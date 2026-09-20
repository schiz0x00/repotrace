import { badRequest, conflict, notFound } from "@/lib/errors";
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

export function normalizeRepoUrl(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed) || /^git@/i.test(trimmed) || /^ssh:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed)) {
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

export async function createProject(input: ProjectInput) {
  const db = prisma();
  const provider = input.provider ?? guessProvider(input.repoUrl);
  const url = normalizeRepoUrl(input.repoUrl);
  const slug = await uniqueSlug(input.name);
  const credentialsEncrypted = input.credentials?.token
    ? encryptRepoCredentials({ token: input.credentials.token, username: input.credentials.username })
    : null;

  const project = await db.project.create({
    data: {
      name: input.name.trim(),
      slug,
      description: input.description ?? null,
      provider,
      repoUrl: url,
      defaultBranch: input.defaultBranch || "main",
      embeddingProvider: input.embedding?.provider,
      embeddingApiUrl: input.embedding?.apiUrl,
      embeddingModel: input.embedding?.model,
      embeddingDimensions: input.embedding?.dimensions,
      embeddingBatchSize: input.embedding?.batchSize,
      repository: {
        create: {
          provider,
          url,
          branch: input.defaultBranch || "main",
          credentialsEncrypted,
        },
      },
    },
    include: { repository: true },
  });
  return project;
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
  embedding?: {
    provider?: string;
    apiUrl?: string;
    apiKey?: string;
    model?: string;
    dimensions?: number;
    batchSize?: number;
  };
}

export async function updateProject(projectId: string, input: ProjectUpdate) {
  const db = prisma();
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { repository: true },
  });
  if (!project) throw notFound("project_not_found", "Project not found");

  const data: Record<string, unknown> = {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.defaultBranch !== undefined ? { defaultBranch: input.defaultBranch } : {}),
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
  }

  const updated = await db.project.update({
    where: { id: projectId },
    data,
    include: { repository: true },
  });

  // Repository mirror (branch / url / credentials).
  const repoData: Record<string, unknown> = {};
  if (input.defaultBranch !== undefined) repoData.branch = input.defaultBranch;
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
  const stats = await Promise.all(
    projects.map(async (p) => {
      const [files, symbols, chunks, jobs] = await Promise.all([
        db.file.count({ where: { projectId: p.id, status: "indexed" } }),
        db.symbol.count({ where: { projectId: p.id } }),
        db.chunk.count({ where: { projectId: p.id } }),
        db.job.count({ where: { projectId: p.id, status: { in: ["queued", "running"] } } }),
      ]);
      return { projectId: p.id, files, symbols, chunks, activeJobs: jobs };
    }),
  );
  return projects.map((p, i) => ({ ...projectToDto(p), stats: stats[i] }));
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
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    embedding: {
      provider: project.embeddingProvider,
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