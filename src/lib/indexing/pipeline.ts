import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseFile, preloadGrammars, type ParsedChunk, type ParsedSymbol } from "@/lib/indexing/parser";
import { detectLanguage, fileCategory } from "@/lib/indexing/languages";
import { resolveEmbeddingConfig, embedTexts, type EmbeddingConfig } from "@/lib/embedding/provider";
import {
  deleteVectorsForFile,
  ensureCollection,
  pointIdFor,
  upsertVectors,
  type VectorPayload,
} from "@/lib/qdrant";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { recordMetric } from "@/lib/metrics";
import {
  checkoutCommit,
  cloneRepository,
  commitRange,
  currentHead,
  diffFiles,
  fetchBranch,
  isAncestor,
  latestCommit,
  listFiles,
  type GitChange,
} from "@/lib/git/git";
import {
  decryptRepoCredentials,
  ensureWorkspace,
  pruneWorkspaces,
} from "@/lib/git/workspace";
import { createHash } from "node:crypto";
import type { ChunkType, FileStatus, ProjectProvider } from "@/generated/prisma/enums";

export interface IndexJobContext {
  projectId: string;
  /** "initial" | "incremental" | "full" | "reembed" */
  mode: "initial" | "incremental" | "full" | "reembed";
  onProgress?: (progress: number, stage: string) => void;
  isCancelled?: () => Promise<boolean> | boolean;
}

export interface IndexResult {
  filesProcessed: number;
  filesSkipped: number;
  filesFailed: number;
  chunksProcessed: number;
  embeddingsGenerated: number;
  vectorsWritten: number;
  filesDeleted: number;
  failedFiles: { path: string; error: string }[];
}

/** Paths never indexed, regardless of repository. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  "target",
  ".next",
  "__pycache__",
  ".cache",
  "coverage",
  ".pytest_cache",
  "vendor",
  "bower_components",
  ".terraform",
  "Pods",
  ".gradle",
  ".idea",
  ".vscode",
]);

/** Skip files that are obviously non-source (per common convention). */
const SKIP_FILE_PATTERNS = [
  /\.(png|jpg|jpeg|gif|svg|ico|webp|bmp|tiff|woff2?|ttf|otf|eot|mp4|mp3|mov|avi|pdf|zip|gz|tar|tgz|bz2|7z|jar|war|class|pyc|o|a|so|dylib|dll|exe|wasm|lock|lockb)$/,
];

/** Default ignore file patterns (e.g. .gitignore at repository root). */
const DEFAULT_IGNORES = [
  /^\.gitignore$/,
  /^\.dockerignore$/,
  /^\.gitmodules$/,
];

export async function runIndexJob(ctx: IndexJobContext): Promise<IndexResult> {
  const cfg = env();
  const db = prisma();
  const project = await db.project.findUnique({
    where: { id: ctx.projectId },
    include: { repository: true },
  });
  if (!project || !project.repository) {
    throw new Error(`Project ${ctx.projectId} has no repository configured`);
  }
  const repo = project.repository;
  const embedding = await resolveEmbeddingConfig(project.id);
  await ensureCollection(project.id, embedding.dimensions);

  const progress = (pct: number, stage: string) => ctx.onProgress?.(pct, stage);
  const cancelled = () => (ctx.isCancelled ? Promise.resolve(ctx.isCancelled()) : Promise.resolve(false));

  progress(2, "syncing repository");
  const workspace = await syncRepository(ctx.projectId, repo.url, repo.branch, repo.provider, repo.credentialsEncrypted, cancelled);
  if (await cancelled()) throw new CancelledError();

  const head = await currentHead(workspace);
  await db.repository.update({
    where: { id: repo.id },
    data: { syncStatus: "synced", syncError: null, lastSuccessfulSync: new Date() },
  });

  // ── Change detection ────────────────────────────────────────────────────
  let changes: GitChange[] | null = null;
  let fromCommit: string | null = repo.lastKnownCommit;
  if (ctx.mode === "incremental" && fromCommit && head !== fromCommit) {
    if (await isAncestor(workspace, fromCommit, head)) {
      changes = await diffFiles(workspace, fromCommit, head);
    }
    // History rewrite: fall through to a full scan (hash-based detection).
  }
  let allFiles: string[] | null = null;
  if (!changes) {
    allFiles = await listFiles(workspace);
    changes = allFiles.map((path) => ({ status: "A" as const, path }));
  }

  // ── Commit metadata ─────────────────────────────────────────────────────
  if (fromCommit && head !== fromCommit) {
    const commits = await commitRange(workspace, fromCommit, head);
    await db.$transaction(
      commits.map((c) =>
        db.commit.upsert({
          where: { repositoryId_sha: { repositoryId: repo.id, sha: c.sha } },
          create: {
            repositoryId: repo.id,
            sha: c.sha,
            message: c.message.slice(0, 2000),
            author: c.author,
            authoredAt: c.authoredAt,
          },
          update: {},
        }),
      ),
    );
  } else if (!fromCommit) {
    // First index: retain the tip commit so history has a starting point.
    const tip = await latestCommit(workspace);
    if (tip) {
      await db.commit.upsert({
        where: { repositoryId_sha: { repositoryId: repo.id, sha: tip.sha } },
        create: {
          repositoryId: repo.id,
          sha: tip.sha,
          message: tip.message.slice(0, 2000),
          author: tip.author,
          authoredAt: tip.authoredAt,
        },
        update: {},
      });
    }
  }

  progress(10, "changed files detected");

  // ── Process files ───────────────────────────────────────────────────────
  const result: IndexResult = {
    filesProcessed: 0,
    filesSkipped: 0,
    filesFailed: 0,
    chunksProcessed: 0,
    embeddingsGenerated: 0,
    vectorsWritten: 0,
    filesDeleted: 0,
    failedFiles: [],
  };

  const filesToDelete = new Set<string>();
  if (changes) {
    for (const change of changes) {
      if (change.status === "D") filesToDelete.add(change.path);
    }
  }

  const processed = new Set<string>();
  for (const change of changes) {
    if (await cancelled()) throw new CancelledError();
    const { path } = change;
    if (change.status === "D") {
      await deleteFileFromIndex(ctx.projectId, repo.id, path);
      result.filesDeleted += 1;
      continue;
    }
    if (processed.has(path)) continue;
    processed.add(path);

    const ok = await processFile({
      workspace,
      projectId: ctx.projectId,
      repositoryId: repo.id,
      path,
      commit: head,
      embedding,
      mode: ctx.mode,
      result,
    });
    if (ok === "indexed") result.filesProcessed += 1;
    else if (ok === "skipped") result.filesSkipped += 1;
    else {
      result.filesFailed += 1;
      result.failedFiles.push({ path, error: ok });
    }
    const done = processed.size;
    const total = changes.length;
    const pct = 10 + Math.round((done / Math.max(1, total)) * 80);
    progress(pct, `indexing files (${done}/${total})`);
  }

  // Reembed mode: purge vectors for every non-current embedding version.
  if (ctx.mode === "reembed") {
    await purgeOtherVersions(ctx.projectId, embedding.version);
  }

  // ── Final state ─────────────────────────────────────────────────────────
  await db.repository.update({
    where: { id: repo.id },
    data: { lastKnownCommit: head },
  });
  await db.project.update({
    where: { id: ctx.projectId },
    data: { status: "synced" },
  });
  await pruneWorkspaces();
  progress(100, "completed");

  await recordMetric("indexing_duration_ms", 0, ctx.projectId);
  return result;
}

/** Reads a file's content as UTF-8; returns null when unreadable/binary. */
export async function readSourceFile(absolute: string): Promise<string | null> {
  try {
    const buf = await readFile(absolute);
    if (buf.includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

interface ProcessFileArgs {
  workspace: string;
  projectId: string;
  repositoryId: string;
  path: string;
  commit: string;
  embedding: EmbeddingConfig;
  mode: "initial" | "incremental" | "full" | "reembed";
  result: IndexResult;
}

type FileOutcome = "indexed" | "skipped" | string /* error message */;

async function processFile(args: ProcessFileArgs): Promise<FileOutcome> {
  const { workspace, path, repositoryId, projectId, commit, embedding, mode, result } = args;
  const db = prisma();
  const cfg = env();

  if (shouldSkipPath(path)) return "skipped";

  const absolute = join(workspace, path);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    return `unreadable: ${path}`;
  }
  if (info.size > cfg.MAX_FILE_SIZE_BYTES) return "skipped";
  if (info.size === 0) return "skipped";

  let content: string;
  try {
    const buf = await readFile(absolute);
    if (buf.includes(0)) return "skipped"; // binary
    content = buf.toString("utf8");
  } catch {
    return `unreadable: ${path}`;
  }

  const hash = createHash("sha256").update(content).digest("hex");

  // Incremental: unchanged content is not reprocessed. `full` and `reembed`
  // modes always re-run the pipeline (hash-based dedup still applies within
  // the same run via the files table, but they intentionally reprocess).
  const existing = await db.file.findUnique({
    where: { repositoryId_path: { repositoryId, path } },
  });
  const unchanged =
    existing &&
    existing.hash === hash &&
    existing.status === "indexed" &&
    existing.lastIndexedAt !== null;
  if (unchanged && (mode === "incremental" || mode === "initial")) {
    return "skipped";
  }

  const parsed = parseFile(path, content);

  // Embed all chunk contents in batches.
  const texts = parsed.chunks.map((c) => c.content);
  let vectors: number[][] = [];
  try {
    vectors = await embedTexts(embedding, texts);
  } catch (err) {
    await markFileFailed(repositoryId, path, hash, parsed.language, commit, (err as Error).message);
    return (err as Error).message;
  }
  result.chunksProcessed += parsed.chunks.length;
  result.embeddingsGenerated += vectors.length;

  // ── Persist: PG metadata first, then Qdrant vectors ────────────────────
  const category = fileCategory(path);
  const file = await db.file.upsert({
    where: { repositoryId_path: { repositoryId, path } },
    create: {
      projectId,
      repositoryId,
      path,
      language: parsed.language,
      hash,
      size: info.size,
      status: "indexed",
      lastIndexedCommit: commit,
      lastIndexedAt: new Date(),
    },
    update: {
      hash,
      size: info.size,
      status: "indexed",
      error: null,
      language: parsed.language,
      lastIndexedCommit: commit,
      lastIndexedAt: new Date(),
    },
  });

  // Remove previous chunks/symbols for this file (content changed).
  await db.chunk.deleteMany({ where: { fileId: file.id } });
  await db.symbol.deleteMany({ where: { fileId: file.id } });

  // Insert symbols with structural metadata. File-level imports/calls are
  // inherited by top-level symbols so dependency lookups return the module's
  // imports regardless of which symbol is queried.
  const symbolIdByQualified = new Map<string, string>();
  const fileSymbol = parsed.symbols.find((s) => s.kind === "module");
  const fileImports = fileSymbol?.imports ?? [];
  const fileCalls = fileSymbol?.calls ?? [];
  for (const sym of parsed.symbols) {
    const isTopLevel = sym.parentName === null;
    const created = await db.symbol.create({
      data: {
        projectId,
        fileId: file.id,
        name: sym.name,
        qualifiedName: sym.qualifiedName,
        kind: sym.kind,
        language: parsed.language,
        startLine: sym.startLine,
        endLine: sym.endLine,
        parentName: sym.parentName,
        metadata: {
          calls: dedupe(isTopLevel ? [...sym.calls, ...fileCalls] : sym.calls),
          imports: dedupe(isTopLevel ? [...sym.imports, ...fileImports] : sym.imports),
          extends: dedupe(sym.extends),
        },
      },
    });
    symbolIdByQualified.set(sym.qualifiedName, created.id);
  }

  // Insert chunks + vectors.
  const points: Array<{ id: string; vector: number[]; payload: VectorPayload }> = [];
  let chunksInserted = 0;
  for (let i = 0; i < parsed.chunks.length; i++) {
    const chunk = parsed.chunks[i];
    const symbolId = chunk.symbolName ? symbolIdByQualified.get(chunk.symbolName) : undefined;
    const created = await db.chunk.create({
      data: {
        projectId,
        fileId: file.id,
        symbolId,
        content: chunk.content,
        contentHash: createHash("sha256").update(chunk.content).digest("hex"),
        chunkType: chunkTypeOf(chunk, category),
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        embeddingModel: embedding.model,
        embeddingVersion: embedding.version,
        status: "embedded",
      },
    });
    chunksInserted += 1;
    points.push({
      id: pointIdFor(created.id),
      vector: vectors[i],
      payload: {
        project_id: projectId,
        file_id: file.id,
        chunk_id: created.id,
        path,
        symbol: chunk.symbolName,
        kind: chunk.kind,
        language: parsed.language,
        module: chunk.symbolName ? chunk.symbolName.split(".")[0] : null,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        content_hash: created.contentHash,
        embedding_model: embedding.model,
        embedding_version: embedding.version,
        chunk_type: created.chunkType,
        content: chunk.content,
      },
    });
  }

  // Remove stale vectors for this file at any embedding version before upsert.
  await deleteVectorsForFile(projectId, file.id);
  await upsertVectors(projectId, points);
  result.vectorsWritten += points.length;
  return "indexed";
}

function chunkTypeOf(
  chunk: ParsedChunk,
  category: "code" | "test" | "documentation" | "configuration",
): ChunkType {
  if (chunk.chunkType === "documentation" || category === "documentation") return "documentation";
  if (category === "test") return "test";
  if (category === "configuration") return "configuration";
  return "code";
}

async function markFileFailed(
  repositoryId: string,
  path: string,
  hash: string,
  language: string,
  commit: string,
  error: string,
): Promise<void> {
  const db = prisma();
  const existing = await db.file.findUnique({
    where: { repositoryId_path: { repositoryId, path } },
  });
  if (existing) {
    await db.file.update({
      where: { id: existing.id },
      data: { status: "failed", error: error.slice(0, 2000), hash, language, lastIndexedCommit: commit },
    });
  }
}

/** Removes a deleted file's chunks, symbols and vectors from every index. */
export async function deleteFileFromIndex(
  projectId: string,
  repositoryId: string,
  path: string,
): Promise<void> {
  const db = prisma();
  const file = await db.file.findUnique({
    where: { repositoryId_path: { repositoryId, path } },
  });
  if (!file) return;
  await deleteVectorsForFile(projectId, file.id);
  await db.chunk.deleteMany({ where: { fileId: file.id } });
  await db.symbol.deleteMany({ where: { fileId: file.id } });
  await db.file.delete({ where: { id: file.id } });
}

/** Deletes vectors whose embedding version no longer matches the config. */
async function purgeOtherVersions(projectId: string, currentVersion: number): Promise<void> {
  const { qdrant } = await import("@/lib/qdrant");
  const collection = `proj_${projectId}`;
  const client = qdrant();
  const exists = await client.collectionExists(collection);
  if (!exists.exists) return;
  // Scroll all points with a non-current version and delete them.
  let offset: string | number | null | undefined;
  const ids: (string | number)[] = [];
  for (let page = 0; page < 1000; page++) {
    const scroll = await client.scroll(collection, {
      limit: 500,
      offset: offset ?? undefined,
      filter: {
        must_not: [{ key: "embedding_version", match: { value: currentVersion } }],
      },
      with_payload: false,
      with_vector: false,
    });
    ids.push(...scroll.points.map((p) => p.id));
    if (!scroll.next_page_offset) break;
    offset = scroll.next_page_offset as string | number;
  }
  for (let i = 0; i < ids.length; i += 500) {
    await client.delete(collection, { points: ids.slice(i, i + 500), wait: true });
  }
}

function shouldSkipPath(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((part) => SKIP_DIRS.has(part))) return true;
  if (SKIP_FILE_PATTERNS.some((re) => re.test(path))) return true;
  if (DEFAULT_IGNORES.some((re) => re.test(path))) return true;
  return false;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

/** Synchronizes the workspace to the branch tip; returns the workspace path. */
export async function syncRepository(
  projectId: string,
  url: string,
  branch: string,
  provider: ProjectProvider,
  credentialsEncrypted: string | null,
  cancelled: () => Promise<boolean>,
): Promise<string> {
  const workspace = await ensureWorkspace(projectId);
  const creds = decryptRepoCredentials(credentialsEncrypted);
  const { stat } = await import("node:fs/promises");
  let exists = false;
  try {
    const info = await stat(join(workspace, ".git"));
    exists = info.isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) {
    await cloneRepository(workspace, url, branch, creds);
  } else {
    await fetchBranch(workspace, url, branch, creds);
    if (await cancelled()) throw new CancelledError();
    // `git fetch` only moves origin/<branch>; the local branch is stale, so
    // check the fetched ref out or new remote commits are never seen.
    await checkoutCommit(workspace, `origin/${branch}`);
  }
  return workspace;
}

export class CancelledError extends Error {
  constructor() {
    super("Job cancelled");
  }
}

export { createHash };