import { readFile, realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { fallbackChunks, parseFile, type ParsedChunk } from "@/lib/indexing/parser";
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
import type { PrismaClient } from "@/generated/prisma/client";
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
  credentialsFromUrl,
  decryptRepoCredentials,
  ensureWorkspace,
  pruneWorkspaces,
} from "@/lib/git/workspace";
import { createHash } from "node:crypto";
import type { ChunkType, ProjectProvider } from "@/generated/prisma/enums";

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

/**
 * Files that are never indexed, because indexing them would put a live secret
 * into Postgres, into Qdrant, and out again through `get_file` and the search
 * API to any MCP client holding the project's API key.
 *
 * `.gitignore` is not a defence here: the indexer works from `git ls-files`, so
 * it only sees files the repository actually *tracks*. A `.env` that was
 * committed before the ignore rule existed — or an `.env.example` that was
 * never ignored — is tracked, and was being read, chunked, embedded and served
 * verbatim. That is the entire credential-theft path for a tool whose whole
 * purpose is handing an AI agent read access to a codebase.
 */
const SENSITIVE_FILES = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pypirc$/i,
  // Tool credential files that are ROUTINALLY COMMITTED, which is exactly why
  // .gitignore is not a defence here: only tracked files are ever read, and
  // these are tracked in most repositories that use the tools at all.
  /^\.git-credentials$/i, // plain-text https creds for every git host
  /^\.dockercfg$/i, // base64 registry credential
  /^\.s3cfg$/i, // AWS access keys
  /\.tfvars(\.json)?$/i, // Terraform variable files: aws_secret_access_key
  /^vault\.(json|hcl)$/i,
  /^\.?htpasswd$/i,
  /^\.?pgpass$/i,
  // Maven `settings.xml` carries <server><password> for private repositories.
  // It is a common file in projects that have no secret in it at all, so this
  // costs some recall — the right trade for a file that indexes into a
  // credential when it does.
  /^settings\.xml$/i,
  /^credentials$/i,
  // Named specifically rather than blocking every .json, which would swallow
  // most of a repository. These are the filenames real tools write secrets to:
  // an AWS credentials file and a GCP service-account key.
  /(^|[-_.])credentials\.json$/i,
  /(^|[-_.])service[-_]?account\.json$/i,
  /^(keystore|truststore)\.json$/i,
  /^secrets?\.(ya?ml|json|toml|ini)$/i,
  /^\.?(htpasswd|pgpass)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
];

const SENSITIVE_EXTENSIONS = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".asc",
  ".gpg",
  ".ppk",
  ".kdbx",
];

export function isSensitivePath(path: string): boolean {
  const base = (path.split("/").pop() ?? path).toLowerCase();
  if (SENSITIVE_FILES.some((re) => re.test(base))) return true;
  // `dot < 0`, not `dot <= 0`. The intent was to skip names with no extension
  // at all, but a leading dot puts the dot at index 0, so `<= 0` also exempted
  // every file named exactly `.pem` or `.key` — which are private key formats,
  // and precisely the thing this list exists to refuse.
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  return SENSITIVE_EXTENSIONS.includes(base.slice(dot));
}

export async function runIndexJob(ctx: IndexJobContext): Promise<IndexResult> {
  const db = prisma();
  const startedAt = Date.now();
  const project = await db.project.findUnique({
    where: { id: ctx.projectId },
    include: { repository: true },
  });
  if (!project || !project.repository) {
    throw new Error(`Project ${ctx.projectId} has no repository configured`);
  }
  const repo = project.repository;
  const embedding = await resolveEmbeddingConfig(project.id);
  // Only a reembed may recreate a collection whose dimensionality no longer
  // matches the configured model — it is the one job that refills every vector.
  // Any other mode fails here with an actionable message rather than writing
  // vectors Qdrant will reject one file at a time.
  await ensureCollection(project.id, embedding.dimensions, { recreate: ctx.mode === "reembed" });

  const progress = (pct: number, stage: string) => ctx.onProgress?.(pct, stage);
  // Progress is reported per file, which for a large repo means one Postgres
  // UPDATE and one Redis write per file — often for an unchanged percentage.
  // `reportProgress` throttles to real changes and a time floor.
  let lastPct = -1;
  let lastAt = 0;
  const reportProgress = (done: number, total: number) => {
    const pct = 10 + Math.round((done / Math.max(1, total)) * 80);
    const now = Date.now();
    // Skip when the percentage has not moved and we reported recently.
    if (pct === lastPct && now - lastAt < 1000) return;
    lastPct = pct;
    lastAt = now;
    progress(pct, `indexing files (${done}/${total})`);
  };
  // Cancellation is cooperative and checked once per file. For a large
  // repository that is one uncached SELECT against Postgres per file — tens of
  // thousands of round trips for a single index run, all to read one boolean
  // that changes at most once a second from the operator's point of view.
  // Throttled to CANCEL_POLL_INTERVAL_MS, which bounds cancellation latency
  // without turning a large index into a database benchmark.
  const CANCEL_POLL_INTERVAL_MS = 2_000;
  let lastCancelCheck = 0;
  const cancelled = async (): Promise<boolean> => {
    if (!ctx.isCancelled) return false;
    const now = Date.now();
    if (now - lastCancelCheck < CANCEL_POLL_INTERVAL_MS) return false;
    lastCancelCheck = now;
    return Boolean(await ctx.isCancelled());
  };

  progress(2, "syncing repository");
  const workspace = await syncRepository(ctx.projectId, repo.url, repo.branch, repo.provider, repo.credentialsEncrypted, cancelled);
  if (await cancelled()) throw new CancelledError();

  const head = await currentHead(workspace);
  await db.repository.update({
    where: { id: repo.id },
    data: { syncStatus: "syncing", syncError: null, lastSuccessfulSync: new Date() },
  });

  // The repository is now observably mid-sync, and on the path where the run
  // completes, the only statement that moves it out of that state is the
  // terminal `repository.update` at the very end of the run. Everything between
  // here and there is wrapped so that a throw — from git, from Postgres, from
  // Qdrant, or the `CancelledError` the cooperative poll raises — cannot leave
  // the row reading "syncing" with no job behind it.
  const guard = createSyncStatusGuard(async (state) => {
    // Both rows are written, because both are read: `Project.status` is what
    // the dashboard badge and the index-status API report, and
    // `Repository.syncStatus` is what the health endpoint counts failures from
    // and what `enqueueScheduledSyncs` filters on. Both are issued under
    // `allSettled` rather than awaited one after the other, so a failure in one
    // does not leave the other unwritten: the repository row is the one that
    // must not stay at "syncing", and awaiting them in sequence would skip the
    // second write whenever the first threw. (`fail` swallows a rejection from
    // this function either way, so what `allSettled` buys is which statements
    // get attempted, not whether this call throws.)
    // A cancelled run leaves both rows reading "synced", so it must not leave a
    // syncError behind either. The dashboard renders a red "sync error" badge
    // purely on `repository.syncError` being non-empty, so a deliberate cancel
    // would light up a permanent error badge on a project that is fine.
    const terminal = {
      syncStatus: state.syncStatus,
      syncError: state.cancelled ? null : state.syncError,
    };
    await Promise.allSettled([
      db.repository.update({ where: { id: repo.id }, data: terminal }),
      // The same enum on both rows, so the project cannot be told a different
      // story from its repository. A cancelled run is "synced" on both (see
      // `createSyncStatusGuard`); only a real failure is "error".
      db.project.update({ where: { id: ctx.projectId }, data: { status: state.syncStatus } }),
    ]);
  });

  try {
    return await runSyncedIndex({
      db,
      repo,
      projectId: ctx.projectId,
      mode: ctx.mode,
      workspace,
      head,
      embedding,
      progress,
      reportProgress,
      cancelled,
      guard,
      startedAt,
    });
  } catch (err) {
    await guard.fail(err);
    throw err;
  }
}

interface SyncedIndexArgs {
  db: PrismaClient;
  repo: { id: string; lastKnownCommit: string | null };
  projectId: string;
  mode: IndexJobContext["mode"];
  workspace: string;
  head: string;
  embedding: EmbeddingConfig;
  progress: (pct: number, stage: string) => void;
  reportProgress: (done: number, total: number) => void;
  cancelled: () => Promise<boolean>;
  guard: ReturnType<typeof createSyncStatusGuard>;
  startedAt: number;
}

/**
 * Indexes a workspace that has already been synced to its branch tip.
 *
 * Split out of {@link runIndexJob} so that every exit from here — the terminal
 * `syncStatus` update on the happy path, a thrown error, and the cooperative
 * `CancelledError` — passes through one place that guarantees the repository
 * does not stay in `syncStatus: "syncing"`. The happy path disarms that place
 * with `guard.finalized()` once it has written a terminal status of its own.
 */
async function runSyncedIndex(args: SyncedIndexArgs): Promise<IndexResult> {
  const { db, repo, projectId, mode, workspace, head, embedding, progress, reportProgress, cancelled, guard, startedAt } =
    args;
  // Same shape the job context has, so the body below reads as it did before
  // this was split out of `runIndexJob`.
  const ctx = { projectId, mode };

  // ── Change detection ────────────────────────────────────────────────────
  let changes: GitChange[] | null = null;
  const fromCommit: string | null = repo.lastKnownCommit;
  // Whether `fromCommit..head` is a range git can actually resolve. After a
  // force-push or a rebase the two commits are unrelated, `git log A..B` fails
  // outright, and the resulting throw used to abort the whole job before any
  // file was indexed. Remember the answer and only record commits when the
  // history is linear.
  let historyIsLinear = false;
  // Computed for EVERY mode that has a watermark and a new head, not just for
  // incremental. It gates commit recording below as well as the diff: when it
  // was only computed for incremental, a full_reindex or reembed on a
  // perfectly linear repository took the "rewritten history" branch and
  // recorded a single tip commit, silently discarding every commit between the
  // watermark and head. One extra `merge-base --is-ancestor` on a full run is
  // a fair price for keeping the history table complete.
  if (fromCommit && head !== fromCommit) {
    // Narrowed to a local so the compiler sees the non-null the condition
    // already guarantees; `fromCommit` is not reassigned in this scope.
    const from = fromCommit;
    historyIsLinear = await isAncestor(workspace, from, head);
    if (ctx.mode === "incremental" && historyIsLinear) {
      changes = await diffFiles(workspace, from, head);
    }
  }
  // History rewrite: fall through to a full scan (hash-based detection).
  let allFiles: string[] | null = null;
  if (!changes) {
    allFiles = await listFiles(workspace);
    changes = allFiles.map((path) => ({ status: "A" as const, path }));
  }

  // ── Commit metadata ─────────────────────────────────────────────────────
  const recordTipCommit = async (sha: string, message: string, author: string, authoredAt: Date) => {
    await db.commit.upsert({
      where: { repositoryId_sha: { repositoryId: repo.id, sha } },
      create: { repositoryId: repo.id, sha, message: message.slice(0, 2000), author, authoredAt },
      update: {},
    });
  };

  if (fromCommit && head !== fromCommit && historyIsLinear) {
    // Uncapped, deliberately: `commitRange` is called with no `-n`, because a
    // limit here silently dropped the oldest commits in a long range while the
    // watermark still advanced to `head`, so those commits were never recorded
    // and never would be — the next sync diffed from a commit that already
    // included them. Silent, permanent history loss traded against a slow first
    // sync after a long dormancy.
    //
    // Chunked, though: a repository that has not been synced in a long time can
    // produce tens of thousands of commits, and the previous version handed all
    // of them to a single `$transaction`, which holds every statement in memory
    // at once. The writes below go out 500 at a time, so the cost of any one
    // transaction is bounded however long the range is.
    const commits = await commitRange(workspace, fromCommit, head);
    for (let i = 0; i < commits.length; i += 500) {
      const batch = commits.slice(i, i + 500);
      await db.$transaction(
        batch.map((c) =>
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
    }
  } else if (!fromCommit || (head !== fromCommit && !historyIsLinear)) {
    // First index, or a rewritten history where the old range is meaningless:
    // retain the tip so commit history has a starting point and the new tip is
    // still recorded rather than silently skipped.
    const tip = await latestCommit(workspace);
    if (tip) await recordTipCommit(tip.sha, tip.message, tip.author, tip.authoredAt);
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

  const processed = new Set<string>();
  for (const change of changes) {
    if (await cancelled()) throw new CancelledError();
    const { path } = change;
    if (change.status === "D") {
      await deleteFileFromIndex(ctx.projectId, repo.id, path);
      result.filesDeleted += 1;
      continue;
    }
    // A rename/copy is reported as an add of the new path; the old path has to
    // be purged explicitly or its chunks and vectors linger forever.
    if (change.oldPath && change.oldPath !== change.path) {
      await deleteFileFromIndex(ctx.projectId, repo.id, change.oldPath);
      result.filesDeleted += 1;
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
    reportProgress(processed.size, changes.length);
  }

  // Reconcile deletions whenever the run fell through to a full scan — which
  // is every mode except a clean incremental diff, including an incremental run
  // after a history rewrite. A full scan reports every tracked file as an add,
  // so anything still indexed under this repository but no longer tracked by
  // git has been deleted upstream and must be purged. Without this, files
  // removed from the repo stay searchable indefinitely.
  if (allFiles) {
    const tracked = new Set(allFiles);
    const deleted = await scanStaleFiles(
      tracked,
      (after) =>
        db.file.findMany({
          // Keyset pagination on `path`, which is unique within a repository,
          // so the scan never builds a parameter list proportional to the
          // repository — see {@link scanStaleFiles}.
          where: {
            repositoryId: repo.id,
            ...(after === null ? {} : { path: { gt: after } }),
          },
          select: { path: true },
          orderBy: { path: "asc" },
          take: STALE_SCAN_PAGE_SIZE,
        }),
      async (path) => {
        if (await cancelled()) throw new CancelledError();
        // Purges two classes of row, not one — see shouldPurgeIndexedPath.
        if (!shouldPurgeIndexedPath(path, tracked)) return;
        await deleteFileFromIndex(projectId, repo.id, path);
        result.filesDeleted += 1;
      },
    );
    if (deleted) {
      reportProgress(changes.length, changes.length);
    }
  }

  // Reembed mode: purge vectors for every non-current embedding version.
  if (ctx.mode === "reembed") {
    await purgeOtherVersions(ctx.projectId, embedding.version);
  }

  // ── Final state ─────────────────────────────────────────────────────────
  // Only advance the watermark when every file succeeded. Advancing past a
  // partial failure means the next incremental run diffs from the newer commit
  // and never revisits the files that failed.
  if (result.filesFailed === 0) {
    await db.repository.update({
      where: { id: repo.id },
      data: { lastKnownCommit: head, syncStatus: "synced", syncError: null },
    });
  } else {
    await db.repository.update({
      where: { id: repo.id },
      data: { syncStatus: "error", syncError: `${result.filesFailed} file(s) failed to index` },
    });
  }
  // The repository's terminal status is written and the guard is told, so that
  // a throw from the project update below — or from `pruneWorkspaces`, or the
  // metric — cannot reach the guard and replace a status the run has earned
  // with "Index failed: …". The guard writes the repository row as well as the
  // project's, which is why it is disarmed here rather than after the last
  // statement.
  guard.finalized();
  await db.project.update({
    where: { id: projectId },
    data: { status: result.filesFailed === 0 ? "synced" : "error" },
  });
  await pruneWorkspaces();
  progress(100, "completed");

  await recordMetric("indexing_duration_ms", Date.now() - startedAt, projectId);
  return result;
}

/**
 * Page size for the stale-file reconciliation scan.
 *
 * Bounded so each page is a single indexed range scan over at most this many
 * rows, whatever the size of the repository: the cost of a page is a constant
 * rather than a function of how much is indexed. The cost is one extra round
 * trip per page, which is noise next to the per-file work the scan runs
 * alongside.
 */
export const STALE_SCAN_PAGE_SIZE = 1_000;

/**
 * Visits every indexed path of a repository that git no longer tracks, and
 * returns how many were visited.
 *
 * The complement used to be asked of Postgres directly —
 * `where: { repositoryId, path: { notIn: allFiles } }` — which binds one
 * parameter per tracked file. On a repository with tens of thousands of files
 * that is an IN-list larger than the row set being asked about, planned and
 * bound on a connection shared with the rest of the job, and it is paid on
 * every full scan and on every incremental run that falls through to one after
 * a history rewrite.
 *
 * The complement is computed here instead: `tracked` is the set of paths git
 * still reports, and the database is walked a page at a time. The cost is one
 * Set of repository-relative paths — memory this job already commits to anyway,
 * because `listFiles` returns every tracked path in an array that the Set is
 * built from — plus one indexed row per page, and no unbounded parameter list.
 *
 * `onStale` may delete as it goes. The scan is keyset-paged on `path` in
 * ascending order and every path it visits is `<= after`, so a row removed
 * mid-scan is behind the cursor and never reached again; the next page is
 * unaffected.
 */
/**
 * Whether an already-indexed path should be removed from the index.
 *
 * Two cases, and only the first is obvious:
 *  - git no longer tracks it, so it is gone from the repository.
 *  - git STILL tracks it but the indexer now refuses it. That second case is
 *    the one that matters for security: `.gitignore` is no defence, because
 *    only tracked files are ever read, so a `.env` committed before the deny
 *    list existed is tracked. It was indexed; processFile now skips it; and
 *    without this its chunks, its vectors and its plaintext would sit in
 *    Postgres and Qdrant — served to every MCP client — for the life of the
 *    deployment, with a `full` reindex (the operation whose entire purpose is
 *    rebuilding from scratch) leaving it untouched.
 *
 * Exported so the rule is testable without a database.
 */
export function shouldPurgeIndexedPath(path: string, tracked: ReadonlySet<string>): boolean {
  if (!tracked.has(path)) return true;
  return shouldSkipPath(path);
}

export async function scanStaleFiles(
  tracked: ReadonlySet<string>,
  fetchPage: (after: string | null) => Promise<Array<{ path: string }>>,
  onStale: (path: string) => Promise<void>,
): Promise<number> {
  let after: string | null = null;
  let visited = 0;
  for (;;) {
    const page = await fetchPage(after);
    if (page.length === 0) break;
    const next = page[page.length - 1]!.path;
    // Advance past the whole page, visited or not, before anything is deleted,
    // so a failure part-way through cannot rewind the scan. A `next` that does
    // not advance means the fetcher ignored the cursor; stop rather than spin.
    if (after !== null && next <= after) break;
    after = next;
    for (const row of page) {
      if (tracked.has(row.path)) continue;
      await onStale(row.path);
      visited += 1;
    }
  }
  return visited;
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

/**
 * Resolves a repository-relative path inside the workspace, or returns null if
 * it would escape.
 *
 * `git -z` output is verbatim and git forbids `.` and `..` as path
 * components, so a path reaching here should always stay inside the workspace.
 * This is the second line of defence: the pipeline turns an
 * attacker-supplied repository's file list into filesystem reads, and if any
 * future path source (a different transport, a decoding change) ever yields a
 * traversing path, it must fail the file rather than index a host file.
 *
 * This check is purely lexical and does NOT see symlinks — see
 * {@link resolveRealInWorkspace} for that.
 */
export function resolveInWorkspace(workspace: string, path: string): string | null {
  const root = resolve(workspace);
  const absolute = resolve(root, path);
  if (absolute === root) return null;
  return absolute.startsWith(root + sep) ? absolute : null;
}

/**
 * Resolves the path a read would actually reach, following symlinks, and
 * re-applies the containment check to that.
 *
 * `resolve` above is lexical: it normalises `..` and never touches the
 * filesystem, so it cannot see a symlink. Git stores a symlink as a blob and
 * checks it out as a real one, and both `stat` and `readFile` follow links — so
 * a repository containing `creds.txt -> /path/to/.env` passed the lexical
 * check, `stat` reported an ordinary file of ordinary size, and the host file
 * was read, chunked, embedded and served back through the MCP tools. The
 * operator saw an innocuous path in the file list.
 *
 * Following the link and re-checking keeps symlinks that stay inside the
 * workspace working, which monorepos rely on, and refuses the ones that leave.
 * A link that cannot be resolved is dangling, and a path that is not in this
 * checkout at all cannot be resolved either; both return null, and the caller
 * tells them apart from an escape by stat-ing the lexical path (see
 * `pathExists`).
 */
export async function resolveRealInWorkspace(workspace: string, path: string): Promise<string | null> {
  const lexical = resolveInWorkspace(workspace, path);
  if (!lexical) return null;
  let real: string;
  try {
    real = await realpath(lexical);
  } catch {
    return null; // broken symlink, or a race with the checkout
  }
  const root = await realpath(workspace).catch(() => resolve(workspace));
  return real === root || real.startsWith(root + sep) ? real : null;
}

/**
 * Whether a path resolves to something on disk. `stat` follows symlinks, so
 * this is false for a dangling link and for a path that is simply absent.
 */
async function pathExists(absolute: string): Promise<boolean> {
  try {
    await stat(absolute);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decides what a repository-supplied path is, before anything is read.
 *
 * This is the security boundary of the indexing pipeline: the path list comes
 * from a repository someone else wrote, and it becomes a filesystem read. Three
 * outcomes, and the middle one is the point — `null` from
 * {@link resolveRealInWorkspace} means two very different things, which must
 * not be reported the same way:
 *
 *   - `ok`      the path resolves, following symlinks, to somewhere inside the
 *               workspace. Return it.
 *   - `absent`  the path is lexically inside the workspace but nothing is
 *               there: an uninitialised submodule, a dangling symlink, a file
 *               removed between the sync and the read. Not an escape attempt.
 *               Reported as FAILED it would pin the repository at
 *               syncStatus=error on every future run, because the watermark
 *               only advances when nothing failed.
 *   - `escape`  the path traverses out, or a symlink resolves outside. `stat`
 *               follows links, so a link to /etc/passwd stats perfectly and
 *               would otherwise be read, embedded and served.
 *
 * Exported so the boundary is testable without a database.
 */
export async function classifyPath(
  workspace: string,
  path: string,
): Promise<{ kind: "ok"; absolute: string } | { kind: "absent" } | { kind: "escape" }> {
  const absolute = await resolveRealInWorkspace(workspace, path);
  if (absolute) return { kind: "ok", absolute };
  const lexical = resolveInWorkspace(workspace, path);
  if (lexical && !(await pathExists(lexical))) return { kind: "absent" };
  return { kind: "escape" };
}

async function processFile(args: ProcessFileArgs): Promise<FileOutcome> {
  const { workspace, path, repositoryId, projectId, commit, embedding, mode, result } = args;
  const db = prisma();
  const cfg = env();

  if (shouldSkipPath(path)) return "skipped";

  const classification = await classifyPath(workspace, path);
  if (classification.kind === "absent") return "skipped";
  if (classification.kind === "escape") {
    return `unsafe path escapes workspace: ${JSON.stringify(path).slice(0, 200)}`;
  }
  const absolute = classification.absolute;

  let info;
  try {
    info = await stat(absolute);
  } catch {
    return `unreadable: ${path}`;
  }
  // A git submodule (a gitlink) is one path to `git ls-files` and is never a
  // file. `git clone` does create the submodule's directory even without
  // `--recurse-submodules` — verified against fresh clones with exactly the
  // flags this module passes — so the directory check below catches it. The
  // absent-path check above is the other shape the same thing can take: a
  // submodule that is a dangling symlink, or a tracked path the checkout never
  // materialised.
  //
  // Neither is an escape attempt, and reporting one as "unsafe path escapes
  // workspace" was both false and alarming: the file counted as FAILED, and
  // because the watermark only advances when filesFailed is zero, one such path
  // pinned the repository at syncStatus=error on every subsequent run.
  if (info.isDirectory()) return "skipped";
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

  // Unchanged content is not reprocessed, but only for `initial` and
  // `incremental`. `full` and `reembed` deliberately rewrite every file they
  // reach — chunks, vectors and the file row — because rebuilding from scratch
  // is the point of those modes. The only dedup either way is the `processed`
  // set above, which drops a path that appears twice in one change list.
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

  // A parse failure must not abort the run. `parseFile` throws rather than
  // returning when the native parser cannot be built or configured, or when
  // `parse()` itself fails — a malformed source is not one of those, because
  // tree-sitter recovers from syntax errors and returns a tree with ERROR
  // nodes — and this call had no guard, so such a file threw straight out of
  // `processFile`, out of the per-file loop, and failed the whole index job.
  // Since the watermark only advances when every file succeeded, the project
  // then stopped indexing entirely and stayed that way — a single bad file was
  // enough to wedge it.
  //
  // Falling back to block chunking keeps the file's *text* searchable
  // lexically and semantically; it just contributes no symbols, which is the
  // same degradation every unsupported language already gets. The reason is
  // recorded on the file so it is visible rather than silent.
  let parsed: ReturnType<typeof parseFile>;
  let parseError: string | null = null;
  try {
    parsed = parseFile(path, content);
    parseError = parsed.error;
  } catch (err) {
    parseError = (err as Error).message;
    parsed = {
      language: detectLanguage(path).id,
      symbols: [],
      chunks: fallbackChunks(content, fileCategory(path)),
      error: parseError,
    };
  }

  // Applied before the embedding call, not just before the insert: a chunk that
  // will be dropped must not cost an embedding request, and the guard has to
  // know the final chunk list so `texts` and the vectors that come back line
  // up with the rows that get written.
  const chunkDedupe = dedupeChunks(parsed.chunks);
  parsed = { ...parsed, chunks: chunkDedupe.chunks };
  if (chunkDedupe.dropped > 0) {
    console.warn(
      `[index] ${path}: dropped ${chunkDedupe.dropped} duplicate chunk(s) colliding on the unique key ` +
        `(fileId, contentHash, startLine): ${chunkDedupe.examples.join("; ")}`,
    );
  }
  // Precomputed so the final `file.update` below is a plain assignment; the
  // note is a pure function of two values that do not change after this point.
  const fileNote = fileNoteText(parseError, chunkDedupe);

  // Embed all chunk contents in batches.
  const texts = parsed.chunks.map((c) => c.content);
  let vectors: number[][] = [];
  try {
    vectors = await embedTexts(embedding, texts);
  } catch (err) {
    const message = (err as Error).message;
    await markFileFailed(repositoryId, projectId, path, hash, parsed.language, info.size, commit, message).catch(
      () => {},
    );
    return message;
  }
  result.embeddingsGenerated += vectors.length;

  // ── Persist: PG metadata first, then Qdrant vectors ────────────────────
  //
  // The row is NOT marked complete here. The incremental skip test is
  // `hash matches AND status === "indexed" AND lastIndexedAt is set`, so a row
  // that was written before the chunks and vectors exist must fail it: the
  // create branch below stores the hash but pairs it with `status: "failed"`
  // and no `lastIndexedAt`, and the update branch is empty, so an existing row
  // is left exactly as it was. The hash and the `indexed` status are written
  // together at the end, once Qdrant has the vectors.
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
      // Not `indexed`: a crash before the final update must leave this
      // retryable rather than looking complete.
      status: "failed",
    },
    update: {},
  });

  try {
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
  // IDs are generated up front so symbols and chunks can be written with
  // createMany (one round trip each) instead of a serial INSERT per row. A
  // 500-symbol file previously cost 500 sequential queries.
  const symbolRows = parsed.symbols.map((sym) => {
    const isTopLevel = sym.parentName === null;
    const id = randomUUID();
    symbolIdByQualified.set(sym.qualifiedName, id);
    return {
      id,
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
        // Previously dropped here, so the parser's `implements` list never
        // reached the index and the structural queries had no way to answer
        // "what implements this interface".
        implements: dedupe(sym.implements),
      },
    };
  });
  if (symbolRows.length) await db.symbol.createMany({ data: symbolRows });

  // Insert chunks + vectors.
  //
  // `dedupeChunks` above already guaranteed this batch is unique on
  // (fileId, contentHash, startLine); `buildChunkWrites` re-checks rather than
  // trusting it, and throws if the invariant is ever broken, because a silent
  // createMany on an unguarded batch is the failure this whole guard exists to
  // prevent — one that repeats on every run and wedges the project.
  const { rows: chunkRows, points } = buildChunkWrites({
    chunks: parsed.chunks,
    vectors,
    projectId,
    fileId: file.id,
    path,
    language: parsed.language,
    category,
    embeddingModel: embedding.model,
    embeddingVersion: embedding.version,
    symbolIdByQualified,
  });
  // Counted after the plan, not before it, so the number reported is what was
  // actually stored rather than what the parser produced.
  result.chunksProcessed += chunkRows.length;
  if (chunkRows.length) await db.chunk.createMany({ data: chunkRows });

    // Remove stale vectors for this file at any embedding version before upsert.
    await deleteVectorsForFile(projectId, file.id);
    await upsertVectors(projectId, points);
    result.vectorsWritten += points.length;

    // Only now is the file genuinely complete. Writing the hash last is what
    // makes an interrupted index retryable instead of permanently skipped.
    await db.file.update({
      where: { id: file.id },
      data: {
        hash,
        size: info.size,
        language: parsed.language,
        status: "indexed",
        // Null on the happy path. When the parse failed and the file fell back
        // to block chunking, the reason is kept here: the file IS indexed and
        // searchable as text, but it contributed no symbols, and an operator
        // needs to be able to see which files those are rather than wondering
        // why a file has no structure. The same applies to a file that lost
        // chunks to the duplicate guard.
        error: fileNote ? fileNote.slice(0, 2000) : null,
        lastIndexedCommit: commit,
        lastIndexedAt: new Date(),
      },
    });
    return "indexed";
  } catch (err) {
    const message = (err as Error).message;
    await markFileFailed(repositoryId, projectId, path, hash, parsed.language, info.size, commit, message).catch(
      () => {},
    );
    return message;
  }
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

/** How many dropped-chunk descriptions a warning or file note carries. */
const DROPPED_CHUNK_EXAMPLES = 5;

export interface ChunkWriteRow {
  id: string;
  projectId: string;
  fileId: string;
  symbolId: string | undefined;
  content: string;
  contentHash: string;
  chunkType: ChunkType;
  startLine: number;
  endLine: number;
  embeddingModel: string;
  embeddingVersion: number;
  status: "embedded";
}

/**
 * Pairs each chunk with its Postgres row and its Qdrant point, in one pass, so
 * the two lists stay index-aligned.
 *
 * The `vectors` argument is positional: entry `i` is the embedding of chunk
 * `i`. A short or over-long `vectors` array is rejected here rather than
 * producing a point with `vector: undefined` for Qdrant to reject, or —
 * worse — silently pairing a chunk with another chunk's vector, which would
 * store a result that is confidently wrong.
 *
 * Throws if two chunks in `chunks` collide on `Chunk`'s unique key
 * `(fileId, contentHash, startLine)`. Callers run {@link dedupeChunks} first;
 * this is the assertion that the invariant still holds at the write, and a
 * violation is a bug in the caller rather than bad input data, so it fails
 * loudly instead of quietly dropping a row here.
 */
export function buildChunkWrites(args: {
  chunks: readonly ParsedChunk[];
  vectors: readonly number[][];
  projectId: string;
  fileId: string;
  path: string;
  language: string;
  category: "code" | "test" | "documentation" | "configuration";
  embeddingModel: string;
  embeddingVersion: number;
  symbolIdByQualified: ReadonlyMap<string, string>;
}): { rows: ChunkWriteRow[]; points: Array<{ id: string; vector: number[]; payload: VectorPayload }> } {
  const { chunks, vectors, projectId, fileId, path, language, category } = args;
  if (vectors.length !== chunks.length) {
    throw new Error(
      `Embedding count mismatch for ${path}: ${chunks.length} chunk(s) but ${vectors.length} vector(s)`,
    );
  }
  const rows: ChunkWriteRow[] = [];
  const points: Array<{ id: string; vector: number[]; payload: VectorPayload }> = [];
  const seen = new Set<string>();
  for (const [i, chunk] of chunks.entries()) {
    const contentHash = createHash("sha256").update(chunk.content).digest("hex");
    const key = `${contentHash}:${chunk.startLine}`;
    if (seen.has(key)) {
      throw new Error(
        `Duplicate chunk key for ${path} at line ${chunk.startLine}; dedupeChunks was not applied`,
      );
    }
    seen.add(key);
    const symbolId = chunk.symbolName ? args.symbolIdByQualified.get(chunk.symbolName) : undefined;
    const chunkType = chunkTypeOf(chunk, category);
    const id = randomUUID();
    points.push({
      id: pointIdFor(id),
      vector: vectors[i]!,
      payload: {
        project_id: projectId,
        file_id: fileId,
        chunk_id: id,
        path,
        symbol: chunk.symbolName,
        kind: chunk.kind,
        language,
        module: chunk.symbolName ? chunk.symbolName.split(".")[0] : null,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        content_hash: contentHash,
        embedding_model: args.embeddingModel,
        embedding_version: args.embeddingVersion,
        chunk_type: chunkType,
        content: chunk.content,
      },
    });
    rows.push({
      id,
      projectId,
      fileId,
      symbolId,
      content: chunk.content,
      contentHash,
      chunkType,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      embeddingModel: args.embeddingModel,
      embeddingVersion: args.embeddingVersion,
      status: "embedded",
    });
  }
  return { rows, points };
}

export interface ChunkDedupeResult {
  /** The chunks to persist — the first of every colliding group, in order. */
  chunks: ParsedChunk[];
  /** How many chunks were skipped, in total. */
  dropped: number;
  /** Up to {@link DROPPED_CHUNK_EXAMPLES} human-readable descriptions. */
  examples: string[];
}

/**
 * Drops chunks that would violate `Chunk`'s unique key
 * `(fileId, contentHash, startLine)`, keeping the first of every colliding
 * group. Pure; the caller applies the result.
 *
 * There was no guard here at all, and `createMany` issues every row in one
 * statement, so a single collision aborted the whole file — and aborted it
 * *permanently*, because the next run re-derives the same chunks and hits the
 * same collision. The repository's watermark only advances when no file failed,
 * so one colliding file was enough to pin the project at `syncStatus: "error"`
 * and stop it indexing, forever, with no indication of which file or why.
 *
 * A collision is two chunks that are the same text starting at the same line.
 * Grammars produce them — a node and an ancestor of identical extent, an
 * overload set the parser collapses to one span — and so does the parser's own
 * output for a file whose declarations share a line range.
 *
 * **Skip, do not disambiguate.** The alternative — making the offending row
 * unique, e.g. by salting the content hash or appending a discriminator to the
 * start line — writes a second row for a span of text the index already holds.
 * It would be embedded a second time, stored a second time, and returned as a
 * second, indistinguishable search hit whose line numbers and content disagree.
 * The unique key exists to say "one row per span of text"; the honest response
 * to a second row for that span is to not write it.
 *
 * This runs before the embedding call, not just before the insert, so a file
 * whose chunks collide systematically does not pay for embeddings nobody will
 * store.
 */
export function dedupeChunks(chunks: readonly ParsedChunk[]): ChunkDedupeResult {
  // `fileId` is constant across one file's rows, so (hash, startLine) is the
  // whole key. Lengths are fixed by a SHA-256 hex digest, so the join is
  // unambiguous and cannot be forged by content that merely looks like a
  // delimiter.
  const seen = new Set<string>();
  const kept: ParsedChunk[] = [];
  const examples: string[] = [];
  let dropped = 0;
  for (const chunk of chunks) {
    const contentHash = createHash("sha256").update(chunk.content).digest("hex");
    const key = `${contentHash}:${chunk.startLine}`;
    if (seen.has(key)) {
      dropped += 1;
      if (examples.length < DROPPED_CHUNK_EXAMPLES) {
        examples.push(`lines ${chunk.startLine}-${chunk.endLine}${chunk.symbolName ? ` (${chunk.symbolName})` : ""}`);
      }
      continue;
    }
    seen.add(key);
    kept.push(chunk);
  }
  return { chunks: kept, dropped, examples };
}

/**
 * The note stored on `File.error` for a file that indexed but was degraded.
 *
 * The column is not a failure marker — it already carries the parse reason for
 * a file that fell back to plain block chunking and is `null` on a clean index.
 * The drop count belongs beside it for the same reason: it is the one place an
 * operator can see that a file lost chunks, and the alternative (a log line
 * nobody is watching, or a silently shorter file) is exactly the kind of
 * correct-looking wrong output this index is supposed to be trusted about.
 */
function fileNoteText(parseError: string | null, dedupe: ChunkDedupeResult): string | null {
  const parts: string[] = [];
  if (parseError) parts.push(parseError);
  if (dedupe.dropped > 0) {
    const more = dedupe.dropped - dedupe.examples.length;
    parts.push(
      `dropped ${dedupe.dropped} duplicate chunk(s) colliding on the unique key ` +
        `(fileId, contentHash, startLine): ${dedupe.examples.join("; ")}` +
        (more > 0 ? `; and ${more} more` : ""),
    );
  }
  return parts.length > 0 ? parts.join(" | ") : null;
}

async function markFileFailed(
  repositoryId: string,
  projectId: string,
  path: string,
  hash: string,
  language: string,
  size: number,
  commit: string,
  error: string,
): Promise<void> {
  const db = prisma();
  // Upsert rather than find-then-update. On a first index the file row is
  // created *after* embedding succeeds, so a file whose embedding failed had
  // no row at all: the old code found nothing and recorded nothing, and the
  // failure was invisible to /files and /index-status even though the job
  // correctly reported filesFailed.
  await db.file.upsert({
    where: { repositoryId_path: { repositoryId, path } },
    create: {
      repositoryId,
      projectId,
      path,
      language,
      hash,
      size,
      status: "failed",
      error: error.slice(0, 2000),
      lastIndexedCommit: commit,
    },
    update: {
      status: "failed",
      error: error.slice(0, 2000),
      hash,
      language,
      size,
      lastIndexedCommit: commit,
    },
  });
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
  // Checked on the basename, not the whole path: the deny list is about what a
  // file is, and `deploy/.env` is just as much a secret as `.env`.
  if (isSensitivePath(path)) return true;
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
  // Stored credentials first, then whatever the configured URL carries. The
  // second source matters because the clone-time scrub removes userinfo from
  // .git/config on purpose: a project whose only credential was pasted into
  // its repo URL would otherwise clone once and never fetch again.
  const creds = decryptRepoCredentials(credentialsEncrypted) ?? credentialsFromUrl(url);
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

/**
 * Tracks whether a run has written a terminal `syncStatus`, and supplies the
 * write that puts one there when it has not.
 *
 * A repository is moved to `syncStatus: "syncing"` at the start of a run and,
 * on the path where the run completes, only leaves that state through the
 * terminal update at the end. Every other exit — a throw from git, from
 * Postgres, from Qdrant, or the `CancelledError` the cooperative cancellation
 * poll raises — used to propagate straight out of the job with the row still
 * reading "syncing", and the watermark behind it not advanced: no job running,
 * no progress behind it, and a status the commits API and the project detail
 * payload report as-is until some later sync happens to set it to "synced".
 *
 * A cancelled run is recorded as `synced`, not as `error`. The distinction is
 * load-bearing rather than cosmetic: `syncStatus: "error"` is what
 * `enqueueScheduledSyncs` filters on to skip broken repositories and what
 * `/api/v1/health/status` counts its `failures` from, so writing it for a
 * deliberate cancel dropped the project out of scheduled syncing and reported
 * it as unhealthy. The enum has no "cancelled" value, and `synced` is the
 * honest one: the watermark was not advanced, so the next run starts from the
 * commit this one started from and redoes whatever this one had not reached.
 *
 * `syncError` is nulled on a cancellation for the same reason. The dashboard
 * renders a red "sync error" badge purely on that column being non-empty, so
 * leaving "Index cancelled before completion" there lit a permanent error badge
 * on a project that was fine. What remains of a cancellation is the job row,
 * which the worker marks `cancelled`, and the `CancelledError` itself, which
 * propagates out of the job. The message built below is handed to `apply` on
 * both paths; on a cancellation the implementation in `runIndexJob` drops it.
 *
 * `apply` is best effort. The original error is what the job and the operator
 * need to see, so a failure while writing the status is swallowed rather than
 * replacing it.
 */
export function createSyncStatusGuard(
  apply: (state: {
    syncStatus: "synced" | "error";
    syncError: string;
    /** True when the run was cancelled rather than failing. */
    cancelled: boolean;
  }) => Promise<void>,
): { finalized: () => void; fail: (err: unknown) => Promise<void> } {
  let finalized = false;
  return {
    finalized: () => {
      finalized = true;
    },
    fail: async (err: unknown) => {
      if (finalized) return;
      const cancelled = err instanceof CancelledError;
      // The message is built either way, but only `apply` ever sees it, and
      // `apply` decides whether it reaches the status columns: on a
      // cancellation it does not. A cancelled run is not a sync failure, and a
      // lingering syncError lights a permanent red "sync error" badge on the
      // dashboard for a project that is fine.
      const syncError = cancelled
        ? "Index cancelled before completion"
        : `Index failed: ${syncErrorMessage(err)}`;
      await apply({ syncStatus: cancelled ? "synced" : "error", syncError, cancelled }).catch(() => {});
    },
  };
}

/**
 * A one-line reason for a failed sync.
 *
 * The 2000-character cap is self-imposed, not a constraint of the column:
 * `Repository.syncError` is `TEXT` with no length limit. It keeps an unbounded,
 * possibly multi-line error message out of the one place it is read back — the
 * project detail payload the dashboard renders a `sync error` badge from.
 */
function syncErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message || "unknown error").slice(0, 2000);
}

export { createHash };