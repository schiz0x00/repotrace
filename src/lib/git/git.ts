import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authUrl, type RepoCredentials } from "@/lib/git/workspace";

/**
 * Thin wrapper over the git CLI. Repos are cloned with
 * `--filter=blob:none` (blobless) so incremental syncs only fetch the blobs
 * needed to diff changed files. Credentials flow through an askpass helper
 * and never land in .git/config.
 */

const exec = promisify(execFile);

export interface GitChange {
  status: "A" | "M" | "D" | "R" | "C";
  path: string;
}

export interface GitCommit {
  sha: string;
  author: string;
  email: string;
  message: string;
  authoredAt: Date;
  parents: string[];
}

const ASKPASS = `#!/bin/sh
case "$1" in
  Username*) echo "\${GIT_USERNAME:-x-access-token}" ;;
  Password*) echo "\${GIT_PASSWORD:-}" ;;
esac
`;

async function runGit(
  args: string[],
  opts: { cwd?: string; creds?: RepoCredentials | null; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string }> {
  const env = { ...process.env, ...opts.env };
  let askpass: string | undefined;
  if (opts.creds) {
    askpass = await writeAskpass(opts.creds);
    env.GIT_ASKPASS = askpass;
    env.GIT_USERNAME = opts.creds.username ?? "x-access-token";
    env.GIT_PASSWORD = opts.creds.token;
  }
  try {
    const { stdout, stderr } = await exec("git", args, {
      cwd: opts.cwd,
      env,
      maxBuffer: 512 * 1024 * 1024,
    });
    return { stdout, stderr };
  } finally {
    if (askpass) await rm(askpass, { force: true });
  }
}

let askpassCounter = 0;

async function writeAskpass(creds: RepoCredentials): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "repotrace-askpass-"));
  const path = join(dir, `askpass-${process.pid}-${askpassCounter++}.sh`);
  await writeFile(path, ASKPASS, { mode: 0o700 });
  return path;
}

/** Clones (or opens) the repository into the workspace and checks out `branch`. */
export async function cloneRepository(
  dir: string,
  url: string,
  branch: string,
  creds?: RepoCredentials | null,
): Promise<void> {
  const full = authUrl(url, creds);
  await runGit(["clone", "--filter=blob:none", "--branch", branch, "--single-branch", full, dir], {
    creds: null, // credentials already embedded for this one command
  });
}

/** Fetches the latest state of the branch. */
export async function fetchBranch(
  dir: string,
  url: string,
  branch: string,
  creds?: RepoCredentials | null,
): Promise<void> {
  await runGit(["fetch", "origin", branch], { cwd: dir, creds });
}

/** Returns the current HEAD sha (of the checked-out branch). */
export async function currentHead(dir: string): Promise<string> {
  const { stdout } = await runGit(["rev-parse", "HEAD"], { cwd: dir });
  return stdout.trim();
}

/** Moves the working tree to the given commit (blobless-fetches on demand). */
export async function checkoutCommit(dir: string, sha: string): Promise<void> {
  await runGit(["checkout", "-q", sha], { cwd: dir });
}

/** Lists tracked files (NUL-delimited, git-style escaped paths). */
export async function listFiles(dir: string): Promise<string[]> {
  const { stdout } = await runGit(["ls-files", "-z"], { cwd: dir });
  return stdout ? stdout.split("\0").filter(Boolean).map(unescapeGitPath) : [];
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
export async function isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(["merge-base", "--is-ancestor", ancestor, descendant], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

/** Changed files between two commits. */
export async function diffFiles(dir: string, from: string, to: string): Promise<GitChange[]> {
  const { stdout } = await runGit(["diff", "--name-status", "-z", from, to], { cwd: dir });
  if (!stdout) return [];
  const tokens = stdout.split("\0");
  const changes: GitChange[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const rawStatus = tokens[i];
    const rawPath = tokens[i + 1];
    const status = rawStatus[0] as GitChange["status"];
    if (rawStatus.startsWith("R") || rawStatus.startsWith("C")) {
      // Rename/copy: two paths (old, new); index the new path as added.
      const newPath = tokens[i + 2];
      changes.push({ status: "A", path: unescapeGitPath(newPath) });
      i += 1;
    } else {
      changes.push({ status, path: unescapeGitPath(rawPath) });
    }
  }
  return changes;
}

/** Commits reachable from `to` but not `from`, oldest first. */
export async function commitRange(
  dir: string,
  from: string,
  to: string,
): Promise<GitCommit[]> {
  const { stdout } = await runGit(
    ["log", "--format=%H%x00%an%x00%ae%x00%aI%x00%P%x00%s", `${from}..${to}`],
    { cwd: dir },
  );
  return parseCommitLog(stdout);
}

/** The most recent commit of the checked-out branch (or null). */
export async function latestCommit(dir: string): Promise<GitCommit | null> {
  const { stdout } = await runGit(
    ["log", "-1", "--format=%H%x00%an%x00%ae%x00%aI%x00%P%x00%s"],
    { cwd: dir },
  );
  const parsed = parseCommitLog(stdout);
  return parsed[0] ?? null;
}

function parseCommitLog(stdout: string): GitCommit[] {
  const out: GitCommit[] = [];
  for (const line of stdout.split("\n").filter(Boolean)) {
    const [sha, author, email, authoredAt, parents, ...message] = line.split("\0");
    out.push({
      sha,
      author,
      email,
      authoredAt: new Date(authoredAt),
      parents: parents ? parents.split(" ") : [],
      message: message.join("\0"),
    });
  }
  return out;
}

function unescapeGitPath(raw: string): string {
  // `git -z` output keeps paths verbatim; quoted pathnames only appear with
  // -z when core.quotePath is on. Decode octal escapes just in case.
  return raw.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}