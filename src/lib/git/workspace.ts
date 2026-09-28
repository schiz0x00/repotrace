import { mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
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
 * Builds a git URL with credentials embedded as `user:pass@`, or returns the
 * URL unchanged when no credentials are configured — or when the URL already
 * carries userinfo, in which case the operator's own value wins.
 *
 * The real sequence this participates in, since it is easy to overstate:
 *  1. The only caller is `cloneRepository`, which needs a URL on the
 *     `git clone` command line. The token is therefore in argv for the
 *     duration of that one invocation, and `git clone` records the URL it was
 *     given — so the token *does* land in .git/config, plaintext, from the
 *     clone until the next step.
 *  2. `cloneRepository` immediately runs `git remote set-url origin <redacted>`
 *     to take it back out.
 *  3. That rewrite is best-effort: a failure is ignored rather than failing the
 *     clone, so a crash (or that failure) between the two leaves the token on
 *     disk. It is repaired by the next sync's `ensureRemote`, which rewrites
 *     any remote whose stored URL differs, or by retention pruning of the
 *     workspace.
 *  4. Every later fetch authenticates through the askpass helper instead, so
 *     from that point on the token is in no file and no argv at all.
 *
 * So: not persisted *after* the scrub, transiently persisted before it, and
 * the scrub is a best-effort cleanup rather than a guarantee.
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

/**
 * The credential embedded in a URL's userinfo, or null when there is none.
 *
 * Operators routinely paste `https://user:token@host/org/repo` straight into
 * the project form. The clone works, and then the post-clone scrub strips the
 * userinfo out of .git/config so the token does not sit on disk for the whole
 * retention window — which leaves the NEXT fetch with no credential at all and
 * no stored secret to fall back on. Without this, such a project clones exactly
 * once and is permanently stuck.
 *
 * Deliberately http(s)-only: in an ssh URL the username is conventionally
 * `git` and is part of the address, not a secret.
 */
export function credentialsFromUrl(url: string): RepoCredentials | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.password) return null;
    return { username: parsed.username || "x-access-token", token: decodeURIComponent(parsed.password) };
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
  // Stamped on every sync so retention pruning can tell an in-use workspace
  // from an abandoned one. See pruneWorkspaces for why the directory mtime
  // cannot answer that question.
  await touchWorkspace(projectId);
  return workspaceForProject(projectId);
}

/** Removes a project's workspace (used by delete_project jobs). */
export async function removeWorkspace(projectId: string): Promise<void> {
  // Remove the per-project directory, not just the `repo` clone inside it.
  // Deleting only the clone left an empty directory per deleted project
  // accumulating in WORKSPACE_DIR forever.
  await rm(join(workspaceRoot(), projectId), { recursive: true, force: true });
}

/** Marker file whose mtime records the last time a workspace was used. */
const LAST_USED = ".repotrace-last-used";

/** Marks a workspace as in use, so retention pruning leaves it alone. */
export async function touchWorkspace(projectId: string): Promise<void> {
  try {
    const dir = join(workspaceRoot(), projectId);
    await mkdir(dir, { recursive: true });
    const marker = join(dir, LAST_USED);
    // Create the file before stamping it. `utimes` alone fails with ENOENT on
    // a path that does not exist, so the marker was never created, the error
    // was swallowed by the catch below, and the whole retention scheme quietly
    // fell back to the directory mtime it was written to replace.
    await writeFile(marker, "", { flag: "a" });
    const now = new Date();
    await utimes(marker, now, now);
  } catch {
    // Retention bookkeeping must never break an index run.
  }
}

/**
 * Whether a workspace is old enough to collect.
 *
 * Extracted from {@link pruneWorkspaces} so the rule can be tested without
 * performing the recursive delete, which must never run against a real
 * workspace root from a test.
 *
 * `lastUsed` is the marker mtime, or the directory mtime for workspaces created
 * before markers existed. `null` means even that is unavailable, in which case
 * the workspace is treated as stale: an unknown workspace is not a reason to
 * delete, but neither is it a reason to keep forever.
 */
export function isWorkspaceStale(lastUsed: number | null, cutoff: number): boolean {
  return lastUsed === null || lastUsed < cutoff;
}

/** Exposed for tests: the marker's mtime, or null when there is no marker. */
export async function lastUsedMarkerAt(projectId: string): Promise<number | null> {
  try {
    return (await stat(join(workspaceRoot(), projectId, LAST_USED))).mtimeMs;
  } catch {
    return null;
  }
}

/** When a workspace was last used, or null when it cannot be determined. */
async function lastUsedAt(dir: string): Promise<number | null> {
  try {
    const marker = await stat(join(dir, LAST_USED));
    return marker.mtimeMs;
  } catch {
    // Workspaces created before the marker existed fall back to the directory
    // mtime, which is the previous (buggy) behaviour and no worse.
    try {
      return (await stat(dir)).mtimeMs;
    } catch {
      return null;
    }
  }
}

/**
 * Prunes stale workspaces. Returns the number of directories removed.
 *
 * Retention is keyed on a marker file written by {@link touchWorkspace}, not on
 * the directory's own mtime. A directory's mtime is set when its entries are
 * created or removed and is NOT refreshed by reading, fetching or checking out
 * inside it — so a workspace used every hour still looked seven days old after
 * the first day. `runIndexJob` calls this at the end of every job, which meant
 * a finishing job could delete a *different* project's workspace while that
 * project was mid-index under a second worker slot. The workspaces are
 * rebuildable, so that is lost work rather than lost data, but it is a
 * self-inflicted stampede.
 */
export async function pruneWorkspaces(): Promise<number> {
  const days = env().WORKSPACE_RETENTION_DAYS;
  if (days <= 0) return 0;
  const cutoff = Date.now() - days * 24 * 3600_000;
  const root = workspaceRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }

  const removed: string[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      const full = join(root, entry);
      try {
        const info = await stat(full);
        if (!info.isDirectory()) return;
        if (isWorkspaceStale(await lastUsedAt(full), cutoff)) {
          await rm(full, { recursive: true, force: true });
          removed.push(entry);
        }
      } catch {
        // A racing delete or permission issue; skip.
      }
    }),
  );
  return removed.length;
}