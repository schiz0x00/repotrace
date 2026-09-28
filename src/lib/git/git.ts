import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authUrl, type RepoCredentials } from "@/lib/git/workspace";

/**
 * Thin wrapper over the git CLI. Repos are cloned with
 * `--filter=blob:none` (blobless) so incremental syncs only fetch the blobs
 * needed to diff changed files.
 *
 * On the fetch path credentials reach git through an askpass helper, so they
 * never appear in argv or in .git/config. The one-time clone is the exception:
 * `git clone` needs a URL, so the token is embedded in that single command
 * line and therefore recorded in .git/config by git itself until
 * `cloneRepository` rewrites the remote. See authUrl and cloneRepository.
 */

const exec = promisify(execFile);

export interface GitChange {
  status: "A" | "M" | "D" | "R" | "C";
  path: string;
  /** For renames/copies: the path the content came from, which must be purged. */
  oldPath?: string;
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

/**
 * Rejects git refspecs that git would parse as command-line options.
 *
 * `git fetch origin <refspec>` still runs git's option parser after the
 * positional `origin`, so an attacker-controlled branch name such as
 * `--upload-pack=<cmd>` makes git execute `<cmd>` on this host. Branch names
 * arrive from user input (`Project.defaultBranch`), so every ref that reaches
 * argv is validated here first.
 */
export function isSafeGitRef(ref: string): boolean {
  if (!ref || ref.length > 255) return false;
  // Leading `-` is the whole attack: git would read it as an option.
  if (ref.startsWith("-")) return false;
  // Control characters, whitespace and the shell/regex metacharacters git
  // itself forbids in a ref name. The shell metacharacters are not needed to
  // break `execFile` (which does not use a shell), but a ref can also reach
  // git's own shell-invoking paths, so they are refused rather than trusted.
  if (/[\x00-\x20\x7f~^:?*[\\|&;$`(){}<>#'"!]/.test(ref)) return false;
  if (ref.includes("..")) return false;
  if (ref.includes("@{")) return false;
  if (ref.endsWith("/") || ref.endsWith(".")) return false;
  if (ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) {
    return false;
  }
  return true;
}

function assertSafeGitRef(ref: string, what: string): void {
  if (!isSafeGitRef(ref)) {
    // Truncate the echoed value: this message can reach a log or an error
    // response, and the input is attacker-controlled and unbounded.
    const shown = ref.length > 80 ? `${ref.slice(0, 80)}…` : ref;
    throw new Error(
      `Invalid ${what} "${shown}": must be a plain git ref name (no leading "-", no whitespace or control characters, no "..")`,
    );
  }
}

/**
 * Removes the credential a URL carries in its **userinfo** — the
 * `user:pass@` part in front of the host.
 *
 * Scheme-aware, because "username" means different things in different
 * protocols. For http(s) the userinfo *is* the credential — that is how
 * repository tokens are embedded. For ssh the username is conventionally
 * `git` and is part of the address, not a secret: stripping it turned
 * `ssh://git@github.com/o/r.git` into `ssh://github.com/o/r.git`, and because
 * `ensureRemote` rewrites a remote whose stored URL differs, that mangled
 * value was written back into `.git/config` on every subsequent fetch and
 * broke authentication permanently. Only the password is removed for
 * non-http schemes, where it genuinely would be a secret.
 *
 * Scope: this is a *userinfo* scrubber, not a "no secret can survive this"
 * filter, and it must not be described as one.
 *  - A credential in the **query string** (`https://host/r.git?access_token=X`)
 *    or in the path is NOT removed. That is deliberate rather than an
 *    oversight: this function's output is also the URL written back as the
 *    fetch remote by `cloneRepository` and `fetchBranch`, so dropping query
 *    parameters here would break clones against hosts that require them. An
 *    operator whose repoUrl carries a token that way gets no protection from
 *    it — in a response, a log line, or .git/config.
 *  - The scp-like form (`git@github.com:o/r.git`) is not something the URL
 *    parser accepts, so it is returned verbatim. It has no password slot
 *    either, so nothing is lost by that.
 *  - A token held in RepoCredentials is passed to git through the askpass
 *    helper, not in the URL — except on the one clone command line, where
 *    authUrl embeds it (see there). It is scrubbed out of error text by
 *    redactSecrets.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
    if (isHttp ? parsed.password || parsed.username : parsed.password) {
      parsed.username = isHttp ? "" : parsed.username;
      parsed.password = "";
      return parsed.toString();
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * Node's execFile puts the full argv in the error message, so a credential
 * embedded in a URL would otherwise be written to Job.error and served back by
 * the jobs API. Every failure message is scrubbed before it escapes.
 *
 * Exported for tests: the argv redaction is otherwise only reachable by making
 * git fail, and the case it exists for (a URL whose credential arrived pasted
 * into the project form, so `creds` is null and the literal-substitution pass
 * has no token to look for) is exactly the one that is awkward to reproduce.
 */
export function redactSecrets(
  text: string,
  secrets: Array<string | undefined>,
): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("***");
    if (secret) {
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) out = out.split(encoded).join("***");
    }
  }
  // Catch a credential in a `//user@host` or `//user:pass@host` userinfo that
  // the substitution pass above could not: either the secret was never handed
  // to runGit (a token pasted into the repoUrl has no `creds` at all), or it
  // arrived percent-encoded by the operator. The password is optional here —
  // requiring both halves is what let a bare `https://TOKEN@host/r.git`
  // through. The pattern is bounded so it cannot run past the authority:
  // `[^/\s:@]+` stops at the first `/`, and an `@` must follow immediately, so
  // ordinary URLs and the `git@host:owner/repo.git` scp form are left alone.
  // It does over-redact a *bare* ssh userinfo (`ssh://git@host/…` becomes
  // `ssh://***@host/…`); that only costs legibility in an error string.
  return out.replace(/(\/\/)[^/\s:@]+(?::[^/\s@]*)?@/g, "$1***@");
}

/**
 * Hard ceiling on a single git invocation.
 *
 * Without it, a clone against an unreachable host, or one whose SSH key is
 * rejected, can block indefinitely. The worker holds a per-project lock and a
 * BullMQ concurrency slot for the duration, so one hung git call silently
 * removes capacity from the whole worker.
 */
const GIT_TIMEOUT_MS = 10 * 60_000;

async function runGit(
  args: string[],
  opts: { cwd?: string; creds?: RepoCredentials | null; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Never wait for a human. A missing or wrong credential must fail the
    // clone, not park the worker on an invisible prompt that no container
    // healthcheck or job timeout can see.
    GIT_TERMINAL_PROMPT: "0",
    // BatchMode=yes: ssh never prompts for a key passphrase or a password, so
    // a missing or wrong key fails the call instead of parking the worker.
    // StrictHostKeyChecking=accept-new IS trust-on-first-use, and saying
    // otherwise is wrong: ssh accepts and *records* a host key it has never
    // seen, and refuses only a key that has *changed* for a host already in
    // known_hosts. So it does stop a MITM against a host that is already
    // pinned, and it does nothing about the first connection to an unknown
    // host, where anyone able to intercept that connection can present their
    // own key and have it stored as genuine. Closing that would need
    // StrictHostKeyChecking=yes against a pre-seeded known_hosts, which this
    // service does not have — it is a deliberate availability-over-pinning
    // trade, not a free win.
    GIT_SSH_COMMAND:
      process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    ...opts.env,
  };
  let askpass: { dir: string; file: string } | undefined;
  if (opts.creds) {
    askpass = await writeAskpass();
    env.GIT_ASKPASS = askpass.file;
    env.GIT_USERNAME = opts.creds.username ?? "x-access-token";
    env.GIT_PASSWORD = opts.creds.token;
  }
  try {
    const { stdout, stderr } = await exec("git", args, {
      cwd: opts.cwd,
      env,
      maxBuffer: 512 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return { stdout, stderr };
  } catch (err) {
    // execFile error messages embed the full command line — scrub before it
    // reaches a Job row or an API response.
    const message = redactSecrets((err as Error).message, [opts.creds?.token]);
    throw new Error(message);
  } finally {
    // Remove the directory, not just the script: mkdtemp creates a fresh
    // directory per git call, and deleting only the file left one empty
    // directory behind in the system temp dir for every fetch of every
    // credentialed project.
    if (askpass) await rm(askpass.dir, { recursive: true, force: true });
  }
}

let askpassCounter = 0;

/**
 * Writes the askpass helper. The credentials themselves are never written to
 * disk: the script reads GIT_USERNAME / GIT_PASSWORD from the environment,
 * which runGit sets for the lifetime of the one git invocation.
 */
async function writeAskpass(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "repotrace-askpass-"));
  const file = join(dir, `askpass-${process.pid}-${askpassCounter++}.sh`);
  await writeFile(file, ASKPASS, { mode: 0o700 });
  return { dir, file };
}

/** Clones (or opens) the repository into the workspace and checks out `branch`. */
export async function cloneRepository(
  dir: string,
  url: string,
  branch: string,
  creds?: RepoCredentials | null,
): Promise<void> {
  assertSafeGitRef(branch, "branch");
  const full = authUrl(url, creds);
  try {
    await runGit(["clone", "--filter=blob:none", "--branch", branch, "--single-branch", full, dir], {
      creds: null, // credentials already embedded for this one command
    });
  } catch (err) {
    // The token is in argv for this one command; scrub it from the failure.
    throw new Error(redactSecrets((err as Error).message, [creds?.token]));
  }
  // `git clone <url>` writes the URL it was given into .git/config, where any
  // credential it carries would sit in plaintext for the whole retention
  // window. Run the scrub unconditionally, not only when credentials were
  // supplied separately: an operator who pasted
  // `https://user:token@host/repo` into the project form has no `creds` at
  // all, so the previous guard left exactly that token in .git/config
  // forever. Setting the remote to its current value is a harmless no-op.
  await runGit(["remote", "set-url", "origin", redactUrl(url)], { cwd: dir }).catch(() => {
    // A failed scrub is not worth failing the clone over; subsequent fetches
    // use the askpass helper, and ensureRemote will retry the rewrite.
  });
}

/** Reads the URL currently configured for `origin`, or null if unset. */
export async function remoteUrl(dir: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(["remote", "get-url", "origin"], { cwd: dir });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Points `origin` at `url` when it has drifted.
 *
 * `updateProject` rewrites `Repository.url`, but a clone made earlier keeps
 * fetching whatever its `.git/config` recorded. `fetchBranch` takes a `url`
 * argument it could not use — git reads the remote from config, not argv — so
 * a project whose repository was moved or re-created kept pulling from the old
 * location indefinitely, and every failure pointed at the old URL.
 */
export async function ensureRemote(dir: string, url: string): Promise<void> {
  const current = await remoteUrl(dir);
  if (current === url) return;
  await runGit(["remote", "set-url", "origin", url], { cwd: dir });
}

/**
 * Git's wording for a ref that does not exist on the remote it was fetched
 * from, and nothing else. This is the only failure that means "the branch was
 * deleted or renamed upstream".
 */
const MISSING_REMOTE_REF = /could ?n[o']t find remote ref/i;

/** Collapses a git/execFile failure into one bounded line for reporting. */
function summarizeGitFailure(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > 400 ? `${flat.slice(0, 400)}…` : flat;
}

/** Fetches the latest state of the branch. */
export async function fetchBranch(
  dir: string,
  url: string,
  branch: string,
  creds?: RepoCredentials | null,
): Promise<void> {
  assertSafeGitRef(branch, "branch");
  await ensureRemote(dir, redactUrl(url));
  try {
    await runGit(["fetch", "origin", branch], { cwd: dir, creds });
  } catch (err) {
    const message = (err as Error).message;
    // A branch deleted or renamed upstream fails on every subsequent sync with
    // git's own "couldn't find remote ref", which reads like a credential
    // problem. Say what actually happened and what to do about it, and keep
    // git's text alongside so the branch name git looked for is still visible.
    if (MISSING_REMOTE_REF.test(message)) {
      throw new Error(
        `Branch "${branch}" no longer exists on the remote. Update the project's default branch to one that does, or recreate the branch upstream. git said: ${summarizeGitFailure(message)}`,
      );
    }
    // Everything else is rethrown with git's own wording intact. The previous
    // version also matched "does not appear to be a git repository", which git
    // emits when the *repository* is gone or the remote cannot be resolved
    // (verified: fetching a `file://` remote whose directory was deleted) —
    // reporting that as "this branch was deleted" sends the operator to fix a
    // branch that is still there. A 401/403, a DNS or TLS failure and a
    // timeout likewise reach here untouched, and all of them need a different
    // fix. Do not widen this match without checking what git actually prints.
    throw err;
  }
}

/** Returns the current HEAD sha (of the checked-out branch). */
export async function currentHead(dir: string): Promise<string> {
  const { stdout } = await runGit(["rev-parse", "HEAD"], { cwd: dir });
  return stdout.trim();
}

/** Moves the working tree to the given commit (blobless-fetches on demand). */
export async function checkoutCommit(dir: string, sha: string): Promise<void> {
  assertSafeGitRef(sha, "commit");
  // `--detach` is required for clarity and correctness, and a bare `--` is
  // actively wrong here: `git checkout -- <ref>` puts git in *pathspec* mode,
  // so it looks for a file literally named `<ref>` and fails with
  // "pathspec did not match any file(s) known to git". That made every
  // incremental/full/reembed job fail at the sync step for an already-cloned
  // project. `--detach` states the intent (move to the commit, do not switch
  // branches) and leaves no pathspec ambiguity. Option injection is already
  // blocked by assertSafeGitRef, which rejects a leading "-".
  await runGit(["checkout", "-q", "--detach", sha], { cwd: dir });
}

/** Lists tracked files (NUL-delimited; `-z` output is verbatim, never quoted). */
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
      // Rename/copy: two paths (old, new). The new path is indexed as added,
      // but the old path must still be reported so the caller can purge its
      // stale rows and vectors — otherwise a renamed file leaves the previous
      // path indexed forever.
      const oldPath = unescapeGitPath(rawPath);
      const newPath = tokens[i + 2];
      changes.push({ status: "A", path: unescapeGitPath(newPath), oldPath });
      i += 1;
    } else {
      changes.push({ status, path: unescapeGitPath(rawPath) });
    }
  }
  return changes;
}

/** Commits reachable from `to` but not `from`, newest first. */
export async function commitRange(
  dir: string,
  from: string,
  to: string,
  limit?: number,
): Promise<GitCommit[]> {
  // `limit` is opt-in and is the CALLER's bound. It must not be used to keep
  // the result small on a range the caller is about to advance a watermark
  // over: the commits left off the end are then neither recorded now nor
  // reachable later, because the next sync diffs from a commit that already
  // contains them.
  const args = ["log", "--format=%H%x00%an%x00%ae%x00%aI%x00%P%x00%s"];
  if (limit !== undefined) args.push(`-n`, String(limit));
  // Callers must only pass a range git can resolve; across unrelated
  // histories `git log A..B` fails outright.
  args.push(`${from}..${to}`);
  const { stdout } = await runGit(args, { cwd: dir });
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
  // Deliberately a no-op.
  //
  // This used to decode `<backslash><octal>` sequences, on the belief that
  // `core.quotePath` might still apply under `-z`. It does not: with `-z`, git
  // separates entries with NUL and emits paths **verbatim**, with no quoting and
  // no escaping, precisely so that arbitrary binary-ish filenames survive.
  //
  // Decoding was therefore a vulnerability, not a safety measure. Git permits a
  // single top-level *filename* of `..\057..\057..\057..\057etc\057passwd`
  // (it contains no `/`, so it is a legal path component), and decoding turned
  // that literal filename into `../../../../etc/passwd`, which the pipeline then
  // joined onto the workspace and read, chunked, embedded and indexed — making
  // host files (including .env) retrievable through search and the MCP tools.
  return raw;
}