import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { env } from "@/lib/env";
import { decryptSecret, encryptSecret } from "@/lib/encryption";

/**
 * Repository workspaces: isolated clone directories, one per project.
 * Workspace contents are temporary indexing material, never the source of
 * truth — PostgreSQL and Qdrant are. Stale workspaces are pruned after
 * WORKSPACE_RETENTION_DAYS.
 */

export function workspaceRoot(): string {
  return env().WORKSPACE_DIR;
}

export function workspaceForProject(projectId: string): string {
  return join(workspaceRoot(), projectId, "repo");
}

/** Credentials (HTTPS token or similar) supplied by the operator. */
export interface RepoCredentials {
  username?: string;
  token: string;
}

/**
 * Builds a git URL with credentials, or returns the URL unchanged when no
 * credentials are configured. The token is passed via askpass at fetch time,
 * never persisted into .git/config.
 */
export function authUrl(url: string, creds?: RepoCredentials | null): string {
  if (!creds) return url;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return url;
    parsed.username = encodeURIComponent(creds.username ?? "x-access-token");
    parsed.password = encodeURIComponent(creds.token);
    return parsed.toString();
  } catch {
    return url;
  }
}

export function decryptRepoCredentials(encrypted: string | null): RepoCredentials | null {
  if (!encrypted) return null;
  try {
    const raw = decryptSecret(encrypted);
    const parsed = JSON.parse(raw) as RepoCredentials;
    if (!parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function encryptRepoCredentials(creds: RepoCredentials): string {
  return encryptSecret(JSON.stringify(creds));
}

/** Ensures the workspace directory exists and is isolated per project. */
export async function ensureWorkspace(projectId: string): Promise<string> {
  const root = workspaceRoot();
  await mkdir(root, { recursive: true });
  return workspaceForProject(projectId);
}

/** Removes a project's workspace (used by delete_project jobs). */
export async function removeWorkspace(projectId: string): Promise<void> {
  const dir = workspaceForProject(projectId);
  await rm(dir, { recursive: true, force: true });
}

/** Prunes stale workspaces. Returns the number of directories removed. */
export async function pruneWorkspaces(): Promise<number> {
  const days = env().WORKSPACE_RETENTION_DAYS;
  if (days <= 0) return 0;
  const cutoff = Date.now() - days * 24 * 3600_000;
  const root = workspaceRoot();
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(root, entry);
    try {
      const info = await stat(full);
      if (info.isDirectory() && info.mtimeMs < cutoff) {
        await rm(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // A racing delete or permission issue; skip.
    }
  }
  return removed;
}