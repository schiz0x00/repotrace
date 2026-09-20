import { appendFile, cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const REPO_SOURCE = resolve("data/test-repos/rt-test-repo");
export const TMP_REPOS_DIR = resolve("data/tmp-test-repos");

/** Random hex suffix, short enough to stay inside a 60-char slug. */
export function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 10);
}

export function testSlug(prefix: string): string {
  return `${prefix}-${randomSuffix()}`;
}

/** Copies the fixture repo to a throwaway location; returns the copy path. */
export async function makeTempRepoCopy(): Promise<string> {
  await mkdir(TMP_REPOS_DIR, { recursive: true });
  const dir = join(TMP_REPOS_DIR, `rt-${randomSuffix()}`);
  await cp(REPO_SOURCE, dir, { recursive: true });
  await exec("git", ["-C", dir, "config", "user.email", "test@repotrace.local"]);
  await exec("git", ["-C", dir, "config", "user.name", "Repotrace Test"]);
  return dir;
}

/** Commits the current working-tree state of a temp repo. */
export async function gitCommit(dir: string, message: string): Promise<void> {
  await exec("git", ["-C", dir, "add", "-A"]);
  await exec("git", ["-C", dir, "commit", "-m", message]);
}

export async function appendLine(path: string, text: string): Promise<void> {
  await appendFile(path, text);
}

/**
 * Verifies the live services an integration test needs. Throws a descriptive
 * error so `RUN_INTEGRATION=1` fails loudly instead of silently skipping when
 * the infra is down.
 */
export async function requireInfra(needs: ("db" | "qdrant" | "redis" | "embeddings")[]): Promise<void> {
  const missing: string[] = [];
  const check = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      missing.push(name);
    }
  };

  if (needs.includes("db")) {
    await check("postgres", async () => {
      const { prisma } = await import("@/lib/prisma");
      await prisma().$queryRaw`SELECT 1`;
    });
  }
  if (needs.includes("qdrant")) {
    await check("qdrant", async () => {
      const { qdrant } = await import("@/lib/qdrant");
      await qdrant().versionInfo();
    });
  }
  if (needs.includes("redis")) {
    await check("redis", async () => {
      const { env } = await import("@/lib/env");
      const { default: Redis } = await import("ioredis");
      const client = new Redis(env().REDIS_URL);
      try {
        await client.ping();
      } finally {
        client.quit();
      }
    });
  }
  if (needs.includes("embeddings")) {
    await check("mock embeddings (:11435)", async () => {
      const res = await fetch("http://localhost:11435/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mock-embed-64", input: ["ping"] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    });
  }

  if (missing.length > 0) {
    throw new Error(
      `Integration test infra missing: ${missing.join(", ")}. Start docker compose (postgres/qdrant/redis) ` +
        `and 'npm run mock-embeddings' before setting RUN_INTEGRATION=1.`,
    );
  }
}

export async function createProjectRow(name: string, repoUrl: string) {
  const { createProject } = await import("@/lib/projects/service");
  return createProject({ name, repoUrl, defaultBranch: "main" });
}

/** Removes every row, vector and workspace a test project created. */
export async function cleanupProject(projectId: string): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const { deleteProjectVectors } = await import("@/lib/qdrant");
  const { removeWorkspace, workspaceRoot } = await import("@/lib/git/workspace");
  const db = prisma();
  await db.metricEvent.deleteMany({ where: { projectId } });
  await deleteProjectVectors(projectId);
  await removeWorkspace(projectId);
  // removeWorkspace only clears the repo subdir; drop the empty parent too.
  await rm(join(workspaceRoot(), projectId), { recursive: true, force: true });
  await db.project.delete({ where: { id: projectId } });
}