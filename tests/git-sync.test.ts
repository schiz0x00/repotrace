import { existsSync, utimesSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkoutCommit, cloneRepository, currentHead, fetchBranch, redactUrl, remoteUrl } from "@/lib/git/git";
import { credentialsFromUrl, isWorkspaceStale } from "@/lib/git/workspace";
import { randomSuffix } from "./helpers";

const exec = promisify(execFile);

/**
 * These exercise the real git CLI against a throwaway local repository, which
 * is what makes them worth having: the regression below is invisible to a
 * mocked git, and the integration suite that would have caught it is skipped
 * unless RUN_INTEGRATION=1.
 */
describe("git sync round trip", () => {
  let root = "";
  let upstream = "";
  let workspace = "";

  const git = async (dir: string, ...args: string[]) =>
    exec("git", ["-C", dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "repotrace-gitsync-"));
    upstream = join(root, "upstream");
    workspace = join(root, "ws");
    await git(root, "init", "-q", "-b", "main", upstream);
    await git(upstream, "config", "user.email", "test@repotrace.local");
    await git(upstream, "config", "user.name", "Repotrace Test");
    await writeFile(join(upstream, "f.txt"), "line1\n");
    await git(upstream, "add", "-A");
    await git(upstream, "commit", "-qm", "c1");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const commitUpstream = async (text: string) => {
    await writeFile(join(upstream, "f.txt"), text);
    await git(upstream, "add", "-A");
    await git(upstream, "commit", "-qm", "update");
    return (await git(upstream, "rev-parse", "HEAD")).stdout.trim();
  };

  it("cloneRepository checks out the requested branch", async () => {
    await cloneRepository(workspace, `file://${upstream}`, "main");
    expect(await readFile(join(workspace, "f.txt"), "utf8")).toBe("line1\n");
  });

  it("cloneRepository rejects a branch that is not a real ref", async () => {
    const err = await cloneRepository(workspace, `file://${upstream}`, "--upload-pack=touch /tmp/x")
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/Invalid branch/);
  });

  // Regression: `checkoutCommit` passed `--` before the ref, which puts git in
  // *pathspec* mode. `git checkout -- origin/main` looks for a file named
  // "origin/main" and fails, so every incremental / full / reembed job threw
  // at the sync step for any project whose workspace already existed — the
  // incremental path never ran at all. An integration test had been written
  // around the symptom instead of catching it.
  it("fetch + checkout fast-forwards the workspace to the new commit", async () => {
    await cloneRepository(workspace, `file://${upstream}`, "main");
    const before = await currentHead(workspace);

    const head = await commitUpstream("line1\nline2\n");
    await fetchBranch(workspace, `file://${upstream}`, "main");
    await checkoutCommit(workspace, "origin/main");

    expect(await currentHead(workspace)).toBe(head);
    expect(await currentHead(workspace)).not.toBe(before);
    expect(await readFile(join(workspace, "f.txt"), "utf8")).toBe("line1\nline2\n");
  });

  it("checkoutCommit still refuses an option-shaped ref", async () => {
    await cloneRepository(workspace, `file://${upstream}`, "main");
    const err = await checkoutCommit(workspace, "--orphan")
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/Invalid commit/);
  });

  // Regression: `fetchBranch` took a `url` argument it never used — git reads
  // the remote from .git/config, not argv — so a project whose repoUrl was
  // changed kept fetching the old location forever, and every error named the
  // old URL.
  it("repoints origin when the configured repository URL has changed", async () => {
    await cloneRepository(workspace, `file://${upstream}`, "main");
    expect(await remoteUrl(workspace)).toBe(`file://${upstream}`);

    // Repoint at a second repository that has a different history.
    const moved = join(root, "moved");
    await git(root, "init", "-q", "-b", "main", moved);
    await git(moved, "config", "user.email", "t@t.t");
    await git(moved, "config", "user.name", "t");
    await writeFile(join(moved, "g.txt"), "moved\n");
    await git(moved, "add", "-A");
    await git(moved, "commit", "-qm", "moved");

    await fetchBranch(workspace, `file://${moved}`, "main");
    expect(await remoteUrl(workspace)).toBe(`file://${moved}`);
    await checkoutCommit(workspace, "origin/main");
    expect(await readFile(join(workspace, "g.txt"), "utf8")).toBe("moved\n");
  });

  it("explains a branch that no longer exists upstream", async () => {
    await cloneRepository(workspace, `file://${upstream}`, "main");
    const err = await fetchBranch(workspace, `file://${upstream}`, "deleted-branch")
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    // Not git's "couldn't find remote ref", which reads like a credential
    // problem and sends the operator looking in the wrong place.
    expect(err!.message).toMatch(/no longer exists on the remote/);
  });
});

describe("workspace retention marker", () => {
  // Regression: touchWorkspace called `utimes` on a marker that had never been
  // created. `utimes` fails with ENOENT on a missing path, the error was caught
  // and discarded, and pruning went on using the directory mtime the marker was
  // introduced to replace -- so the whole fix was inert and the original bug
  // (pruneWorkspaces deleting a workspace another job was indexing) was still
  // live.
  //
  // These tests never call pruneWorkspaces(): it recursively deletes under the
  // configured workspace root, and running it from a test could remove real
  // workspaces. The staleness rule is exercised through the pure predicate
  // instead, and marker creation is verified directly.
  it("touchWorkspace creates the marker and refreshes it", async () => {
    const projectId = `retain-test-${randomSuffix()}`;
    const { touchWorkspace, lastUsedMarkerAt, workspaceRoot } = await import(
      "@/lib/git/workspace"
    );
    const dir = join(workspaceRoot(), projectId);
    const marker = join(dir, ".repotrace-last-used");
    try {
      // First call: the marker does not exist yet, which is exactly the case
      // that used to throw ENOENT and be swallowed.
      await touchWorkspace(projectId);
      expect(existsSync(marker)).toBe(true);
      const first = await lastUsedMarkerAt(projectId);
      expect(first ?? 0).toBeGreaterThan(0);

      // Age it, then touch again: the stamp must move forward.
      const old = new Date(Date.now() - 400 * 24 * 3600_000);
      utimesSync(marker, old, old);
      expect(await lastUsedMarkerAt(projectId)).toBeLessThan(Date.now() - 1000);

      await touchWorkspace(projectId);
      expect((await lastUsedMarkerAt(projectId)) ?? 0).toBeGreaterThan(Date.now() - 60_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a recently used workspace and collects a stale one", () => {
    const now = Date.now();
    const cutoff = now - 7 * 24 * 3600_000;
    // Used an hour ago: kept, however old the directory itself looks.
    expect(isWorkspaceStale(now - 3600_000, cutoff)).toBe(false);
    // Untouched for a month: collectable.
    expect(isWorkspaceStale(now - 30 * 24 * 3600_000, cutoff)).toBe(true);
    // Nothing known at all: collected. An unknown workspace is not a reason to
    // keep forever, and the directory-mtime fallback in the caller means
    // `null` only happens when even that is unreadable.
    expect(isWorkspaceStale(null, cutoff)).toBe(true);
    // The comparison is a strict `<`, so a workspace sitting exactly on the
    // cutoff is still kept and only one millisecond older is collected. The
    // predicate is the whole retention rule, so this boundary is the one
    // thing worth pinning.
    expect(isWorkspaceStale(cutoff, cutoff)).toBe(false);
    expect(isWorkspaceStale(cutoff - 1, cutoff)).toBe(true);
  });
});

describe("credentialsFromUrl", () => {
  // Regression from the .git/config scrub: the clone-time rewrite strips
  // userinfo so a pasted token does not sit on disk for the retention window.
  // Without recovering the credential from the configured URL, a project whose
  // only secret was pasted into its repo URL cloned once and could never fetch
  // again — permanently stuck, with no error that explained it.
  it("recovers an https credential pasted into the repository URL", () => {
    expect(credentialsFromUrl("https://x-access-token:ghp_secret@github.com/org/repo.git")).toEqual({
      username: "x-access-token",
      token: "ghp_secret",
    });
  });

  it("percent-decodes the token, so an encoded @ does not truncate it", () => {
    const creds = credentialsFromUrl("https://user:p%40ss%3Aword@github.com/org/repo.git");
    expect(creds?.token).toBe("p@ss:word");
  });

  it("returns null when there is nothing to recover", () => {
    expect(credentialsFromUrl("https://github.com/org/repo.git")).toBeNull();
    // The username alone is not a credential on an ssh remote.
    expect(credentialsFromUrl("ssh://git@github.com/org/repo.git")).toBeNull();
    expect(credentialsFromUrl("git@github.com:org/repo.git")).toBeNull();
    expect(credentialsFromUrl("not a url")).toBeNull();
  });

  it("survives the round trip that actually happens: scrub, then recover", () => {
    const original = "https://x-access-token:ghp_secret@github.com/org/repo.git";
    // What cloneRepository writes into .git/config.
    const scrubbed = redactUrl(original);
    expect(scrubbed).not.toContain("ghp_secret");
    // What syncRepository then recovers for the askpass helper.
    expect(credentialsFromUrl(scrubbed)).toBeNull();
    // It recovers from the CONFIGURED url, which still has the userinfo,
    // not from the scrubbed remote.
    expect(credentialsFromUrl(original)?.token).toBe("ghp_secret");
  });
});
