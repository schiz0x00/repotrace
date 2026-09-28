import { badRequest, conflict, notFound } from "@/lib/errors";
import { redactUrl, isSafeGitRef } from "@/lib/git/git";
import { encryptRepoCredentials } from "@/lib/git/workspace";
import { enqueueJob } from "@/lib/jobs/queue";
import { prisma } from "@/lib/prisma";
import type { ProjectProvider } from "@/generated/prisma/enums";

/**
 * Project lifecycle: CRUD + repository configuration. Projects are data, not
 * applications — one platform instance serves arbitrarily many repositories.
 */

export interface ProjectInput {
  name: string;
  description?: string | null;
  repoUrl: string;
  provider?: ProjectProvider;
  defaultBranch?: string;
  /** Optional HTTPS token / credentials, encrypted at rest. */
  credentials?: { token: string; username?: string } | null;
  embedding?: {
    provider?: string;
    apiUrl?: string;
    apiKey?: string;
    model?: string;
    dimensions?: number;
    batchSize?: number;
  };
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "project"
  );
}

/**
 * Link-local address space, which includes the cloud instance metadata
 * endpoint (169.254.169.254 on AWS/GCP/Azure). The server clones whatever URL
 * it is given, so a metadata URL would turn "index my repo" into a request
 * that returns instance credentials.
 *
 * Loopback and RFC1918 addresses are deliberately *not* blocked: a
 * self-hosted git server on a LAN or on 127.0.0.1 inside a compose network is
 * a legitimate target for this product.
 */
function isLinkLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;
  // AWS also exposes metadata at the reserved 169.254.169.253 DNS name.
  return host === "metadata.google.internal" || host === "metadata.goog";
}

export function normalizeRepoUrl(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed) || /^git@/i.test(trimmed) || /^ssh:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed)) {
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        if (isLinkLocalHost(new URL(trimmed).hostname)) {
          throw badRequest(
            "invalid_repo_url",
            "Repository URL points at a link-local or metadata address, which is refused",
          );
        }
      } catch (err) {
        if (err && typeof err === "object" && "status" in err) throw err;
        throw badRequest("invalid_repo_url", "Repository URL is not a valid URL");
      }
    }
    return trimmed;
  }
  // github.com/owner/repo shorthand
  const match = trimmed.match(/^(github\.com|gitlab\.com|bitbucket\.org)\/([\w.-]+\/[\w.-]+)$/);
  if (match) return `https://${match[0]}`;
  throw badRequest("invalid_repo_url", "Repository URL must be http(s), ssh, file, or provider shorthand");
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  const existing = await prisma().project.findUnique({ where: { slug: base } });
  if (!existing) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    const taken = await prisma().project.findUnique({ where: { slug: candidate } });
    if (!taken) return candidate;
  }
  throw conflict("slug_exhausted", "Could not generate a unique project slug");
}

/**
 * Validates a branch name at the API boundary.
 *
 * `isSafeGitRef` is enforced again in the git layer — that is what stops the
 * argument-injection RCE — but a bad branch stored here is only discovered when
 * a sync runs, so the operator sees a job failure instead of a rejected input.
 */
function normalizeBranch(branch: string | undefined): string {
  const value = (branch ?? "main").trim() || "main";
  if (!isSafeGitRef(value)) {
    throw badRequest(
      "invalid_branch",
      "Branch must be a plain git ref name (no leading \"-\", whitespace, or \"..\")",
    );
  }
  return value;
}

export async function createProject(input: ProjectInput) {
  const db = prisma();
  const provider = input.provider ?? guessProvider(input.repoUrl);
  const url = normalizeRepoUrl(input.repoUrl);
  const branch = normalizeBranch(input.defaultBranch);
  const credentialsEncrypted = input.credentials?.token
    ? encryptRepoCredentials({ token: input.credentials.token, username: input.credentials.username })
    : null;

  // uniqueSlug reads then writes, so two projects created in the same
  // millisecond with the same name can both compute the same free slug and the
  // loser's INSERT fails on the unique constraint. Retry rather than surfacing
  // a 500 for what is a routine concurrency case.
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = await uniqueSlug(input.name);
    try {
      return await db.project.create({
        data: {
          name: input.name.trim(),
          slug,
          description: input.description ?? null,
          provider,
          repoUrl: url,
          defaultBranch: branch,
          embeddingProvider: input.embedding?.provider,
          embeddingApiUrl: input.embedding?.apiUrl,
          // Accepted, answered 201, and silently dropped: only `updateProject`
          // ever wrote this column, so a per-project embedding key supplied at
          // creation time was discarded and the project fell back to the
          // system default with nothing in the response to say so.
          embeddingApiKeyEnc: input.embedding?.apiKey
            ? encryptRepoCredentials({ token: input.embedding.apiKey })
            : null,
          embeddingModel: input.embedding?.model,
          embeddingDimensions: input.embedding?.dimensions,
          embeddingBatchSize: input.embedding?.batchSize,
          repository: {
            create: {
              provider,
              url,
              branch,
              credentialsEncrypted,
            },
          },
        },
        include: { repository: true },
      });
    } catch (err) {
      if (!isUniqueViolation(err) || attempt === 4) throw err;
    }
  }
  throw conflict("slug_exhausted", "Could not generate a unique project slug");
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

function guessProvider(url: string): ProjectProvider {
  if (/github\.com/i.test(url)) return "github";
  if (/gitlab\.com/i.test(url)) return "gitlab";
  if (/bitbucket\.org/i.test(url)) return "bitbucket";
  return "generic";
}

export interface ProjectUpdate {
  name?: string;
  description?: string | null;
  defaultBranch?: string;
  repoUrl?: string;
  credentials?: { token?: string; username?: string } | null;
  /**
   * Every override is nullable as well as optional: `undefined` means "leave
   * unchanged" and `null` means "clear it and fall back to the system default".
   * The dashboard needs that distinction, because a stored key or model is
   * otherwise unreachable - blanking the field is indistinguishable, on the
   * wire, from leaving it alone.
   */
  embedding?: {
    provider?: string | null;
    apiUrl?: string | null;
    apiKey?: string | null;
    model?: string | null;
    dimensions?: number | null;
    batchSize?: number | null;
  };
}

export async function updateProject(projectId: string, input: ProjectUpdate) {
  const db = prisma();
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { repository: true },
  });
  if (!project) throw notFound("project_not_found", "Project not found");

  const branch = input.defaultBranch !== undefined ? normalizeBranch(input.defaultBranch) : undefined;
  const data: Record<string, unknown> = {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(branch !== undefined ? { defaultBranch: branch } : {}),
    ...(input.repoUrl !== undefined ? { repoUrl: normalizeRepoUrl(input.repoUrl) } : {}),
  };
  const embedding = input.embedding;
  if (embedding) {
    if (embedding.provider !== undefined) data.embeddingProvider = embedding.provider;
    if (embedding.apiUrl !== undefined) data.embeddingApiUrl = embedding.apiUrl;
    if (embedding.apiKey !== undefined) {
      data.embeddingApiKeyEnc = embedding.apiKey ? encryptRepoCredentials({ token: embedding.apiKey }) : null;
    }
    if (embedding.model !== undefined) data.embeddingModel = embedding.model;
    if (embedding.dimensions !== undefined) data.embeddingDimensions = embedding.dimensions;
    if (embedding.batchSize !== undefined) data.embeddingBatchSize = embedding.batchSize;

    // Changing the model, endpoint or dimensionality invalidates every vector
    // already in the collection — they are not merely stale, they cannot be
    // compared against vectors from a different model at all. Bumping the
    // version makes search filter to the new version only, so a half-reembedded
    // index never fuses two embedding spaces into one ranking. The project
    // reports `reembedRequired` until a reembed job refills it.
    const identityChanged =
      (embedding.model !== undefined && embedding.model !== project.embeddingModel) ||
      (embedding.dimensions !== undefined && embedding.dimensions !== project.embeddingDimensions) ||
      (embedding.apiUrl !== undefined && embedding.apiUrl !== project.embeddingApiUrl);
    if (identityChanged) {
      data.embeddingVersion = (project.embeddingVersion ?? 1) + 1;
    }
  }

  const updated = await db.project.update({
    where: { id: projectId },
    data,
    include: { repository: true },
  });

  // Repository mirror (branch / url / credentials).
  const repoData: Record<string, unknown> = {};
  if (input.defaultBranch !== undefined) repoData.branch = branch;
  if (input.repoUrl !== undefined) repoData.url = normalizeRepoUrl(input.repoUrl);
  if (input.credentials !== undefined) {
    repoData.credentialsEncrypted = input.credentials?.token
      ? encryptRepoCredentials({
          token: input.credentials.token,
          username: input.credentials.username,
        })
      : null;
  }
  if (Object.keys(repoData).length > 0 && updated.repository) {
    await db.repository.update({
      where: { id: updated.repository.id },
      data: repoData,
    });
  }
  return updated;
}

export async function deleteProject(projectId: string): Promise<string> {
  // Async cleanup: vectors, workspace, rows — runs in the worker.
  return enqueueJob(projectId, "delete_project", { dedupe: true });
}

export async function listProjects(includeStats = false) {
  const db = prisma();
  const projects = await db.project.findMany({
    orderBy: { name: "asc" },
    include: { repository: true },
  });
  if (!includeStats) {
    return projects.map((p) => projectToDto(p));
  }
  // Four grouped queries rather than four counts per project. The dashboard's
  // project list asks for this on every render, so with N projects the old
  // shape issued 4N round trips before the page could finish.
  const ids = projects.map((p) => p.id);
  const toMap = (rows: Array<{ projectId: string | null; _count: { _all: number } }>) =>
    new Map(rows.filter((r) => r.projectId !== null).map((r) => [r.projectId as string, r._count._all]));

  if (ids.length === 0) return [];
  const [fileCounts, symbolCounts, chunkCounts, jobCounts] = await Promise.all([
    db.file.groupBy({
      by: ["projectId"],
      where: { projectId: { in: ids }, status: "indexed" },
      _count: { _all: true },
    }),
    db.symbol.groupBy({ by: ["projectId"], where: { projectId: { in: ids } }, _count: { _all: true } }),
    db.chunk.groupBy({ by: ["projectId"], where: { projectId: { in: ids } }, _count: { _all: true } }),
    db.job.groupBy({
      by: ["projectId"],
      where: { projectId: { in: ids }, status: { in: ["queued", "running"] } },
      _count: { _all: true },
    }),
  ]);
  const files = toMap(fileCounts);
  const symbols = toMap(symbolCounts);
  const chunks = toMap(chunkCounts);
  const jobs = toMap(jobCounts);

  return projects.map((p) => ({
    ...projectToDto(p),
    stats: {
      files: files.get(p.id) ?? 0,
      symbols: symbols.get(p.id) ?? 0,
      chunks: chunks.get(p.id) ?? 0,
      activeJobs: jobs.get(p.id) ?? 0,
    },
  }));
}

export async function requireProjectByIdOrSlug(idOrSlug: string) {
  const project = await prisma().project.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    include: { repository: true },
  });
  if (!project) throw notFound("project_not_found", "Project not found");
  return project;
}

export function projectToDto(project: Awaited<ReturnType<typeof requireProjectByIdOrSlug>>) {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    provider: project.provider,
    // Operators do paste `https://user:token@host/...`. That value is stored
    // as-is and would otherwise be handed back by every project read; strip
    // the userinfo the same way the git layer does before it reaches a
    // response or the dashboard.
    repoUrl: redactUrl(project.repoUrl),
    defaultBranch: project.defaultBranch,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    embedding: {
      provider: project.embeddingProvider,
      // The endpoint URL, not the key. The key is stored as
      // `embeddingApiKeyEnc` and is never returned; the dashboard's settings
      // form needs the URL to show what the project is currently pointed at.
      apiUrl: project.embeddingApiUrl,
      model: project.embeddingModel,
      dimensions: project.embeddingDimensions,
      batchSize: project.embeddingBatchSize,
      version: project.embeddingVersion,
    },
    repository: project.repository
      ? {
          lastKnownCommit: project.repository.lastKnownCommit,
          lastSuccessfulSync: project.repository.lastSuccessfulSync,
          syncStatus: project.repository.syncStatus,
          syncError: project.repository.syncError,
          hasCredentials: !!project.repository.credentialsEncrypted,
        }
      : null,
  };
}