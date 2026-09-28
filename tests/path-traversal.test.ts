import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listFiles, diffFiles } from "@/lib/git/git";
import { classifyPath, resolveInWorkspace, resolveRealInWorkspace } from "@/lib/indexing/pipeline";

const exec = promisify(execFile);

/**
 * A git path becomes a filesystem path in the indexing pipeline, so a path
 * list is an untrusted input even though it came from a clone the server made.
 */
describe("git path handling", () => {
  /**
   * Regression, and the reason this file exists.
   *
   * `unescapeGitPath` decoded `<backslash><octal>` sequences, on the belief
   * that `core.quotePath` still applied under `-z`. It does not — `-z` emits
   * paths verbatim, which is exactly what makes arbitrary filenames safe to
   * transport. Git allows a single top-level *filename* of
   * `..\057..\057..\057..\057etc\057passwd`: it has no `/` in it, so it is a
   * legal path component.
   *
   * Decoding rewrote that literal filename into `../../../../etc/passwd`. The
   * pipeline joined it onto the workspace with no containment check, read the
   * host file, and chunked, embedded and indexed it — so `.env` (holding
   * DATABASE_URL, BETTER_AUTH_SECRET and REPO_CREDENTIALS_KEY) became
   * retrievable through search and the MCP tools by anyone who could get a
   * repository indexed.
   */
  it("returns -z paths verbatim, without decoding octal escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "repotrace-paths-"));
    const repo = join(root, "repo");
    try {
      await exec("git", ["init", "-q", "-b", "main", repo]);
      await exec("git", ["-C", repo, "config", "user.email", "t@t.t"]);
      await exec("git", ["-C", repo, "config", "user.name", "t"]);
      // One filename. No slash, so git accepts it as a top-level entry.
      const hostile = "..\\057..\\057..\\057..\\057etc\\057passwd";
      await writeFile(join(repo, hostile), "root:x:0:0\n");
      await writeFile(join(repo, "ok.ts"), "export const ok = 1;\n");
      await exec("git", ["-C", repo, "add", "-A"]);
      await exec("git", ["-C", repo, "commit", "-qm", "c1"]);

      const files = await listFiles(repo);
      expect(files).toContain(hostile);
      // The decoded form is exactly the traversal that used to be produced.
      expect(files).not.toContain("../../../../etc/passwd");
      for (const f of files) {
        expect(f.startsWith("/")).toBe(false);
        expect(f.split("/")).not.toContain("..");
      }

      // Same for the diff path, which shares the helper.
      await writeFile(join(repo, "ok.ts"), "export const ok = 2;\n");
      await exec("git", ["-C", repo, "add", "-A"]);
      await exec("git", ["-C", repo, "commit", "-qm", "c2"]);
      const head = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
      const parent = (await exec("git", ["-C", repo, "rev-parse", "HEAD~1"])).stdout.trim();
      const changes = await diffFiles(repo, parent, head);
      expect(changes.map((c) => c.path)).toContain("ok.ts");
      for (const c of changes) {
        expect(c.path.split("/")).not.toContain("..");
        expect(c.oldPath ?? "").not.toMatch(/\.\./);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still reads ordinary files by their exact name", async () => {
    const root = await mkdtemp(join(tmpdir(), "repotrace-paths-ok-"));
    const repo = join(root, "repo");
    try {
      await exec("git", ["init", "-q", "-b", "main", repo]);
      await exec("git", ["-C", repo, "config", "user.email", "t@t.t"]);
      await exec("git", ["-C", repo, "config", "user.name", "t"]);
      await exec("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
      await mkdir(join(repo, "src/orders"), { recursive: true });
      await writeFile(join(repo, "src/orders/model.ts"), "export interface Order {}\n");
      await writeFile(join(repo, "a file with spaces & symbols.txt"), "hi\n");
      await exec("git", ["-C", repo, "add", "-A"]);
      await exec("git", ["-C", repo, "commit", "-qm", "c1"]);

      const files = await listFiles(repo);
      expect(files.sort()).toEqual(["a file with spaces & symbols.txt", "src/orders/model.ts"]);
      expect(await readFile(join(repo, "src/orders/model.ts"), "utf8")).toContain("Order");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * The containment check that turns a git path into a filesystem read.
 *
 * The lexical half is not enough on its own: git stores a symlink as a blob
 * and checks it out as a real one, and `stat`/`readFile` both follow links, so
 * a repository containing `creds.txt -> /path/to/.env` passed a `..`-check,
 * reported an ordinary file, and had a host secret chunked, embedded and
 * served back through the MCP tools.
 */
describe("workspace containment", () => {
  let root = "";
  let workspace = "";
  let outside = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "repotrace-contain-"));
    workspace = join(root, "ws");
    outside = join(root, "outside.env");
    await mkdir(workspace, { recursive: true });
    await writeFile(outside, "DATABASE_URL=postgres://real\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("rejects a lexical traversal", () => {
    expect(resolveInWorkspace(workspace, "../outside.env")).toBeNull();
    expect(resolveInWorkspace(workspace, "a/../../outside.env")).toBeNull();
    expect(resolveInWorkspace(workspace, "")).toBeNull();
  });

  it("accepts an ordinary path inside the workspace", () => {
    expect(resolveInWorkspace(workspace, "src/a.ts")).toBe(join(workspace, "src/a.ts"));
  });

  it("rejects a symlink pointing outside the workspace", async () => {
    await symlink(outside, join(workspace, "creds.txt"));
    // The lexical check alone cannot see this.
    expect(resolveInWorkspace(workspace, "creds.txt")).not.toBeNull();
    expect(await resolveRealInWorkspace(workspace, "creds.txt")).toBeNull();
  });

  it("rejects a relative symlink that climbs out", async () => {
    await symlink("../../outside.env", join(workspace, "creds.txt"));
    expect(await resolveRealInWorkspace(workspace, "creds.txt")).toBeNull();
  });

  it("allows a symlink that stays inside the workspace", async () => {
    await writeFile(join(workspace, "real.ts"), "export const a = 1;\n");
    await symlink(join(workspace, "real.ts"), join(workspace, "link.ts"));
    const resolved = await resolveRealInWorkspace(workspace, "link.ts");
    expect(resolved).not.toBeNull();
    expect(await readFile(resolved!, "utf8")).toContain("export const a");
  });

  it("returns null for a broken symlink rather than throwing", async () => {
    await symlink(join(root, "does-not-exist"), join(workspace, "dangling.txt"));
    expect(await resolveRealInWorkspace(workspace, "dangling.txt")).toBeNull();
  });
});

/**
 * The pipeline's decision about a repository-supplied path, made testable
 * without a database. The distinction that matters: a path that is merely
 * ABSENT (an uninitialised submodule, a dangling symlink) is not an escape
 * attempt, and reporting it as one used to count the file as FAILED — which,
 * because the watermark only advances when nothing failed, pinned the whole
 * repository at syncStatus=error on every subsequent run.
 */
describe("classifyPath", () => {
  let root = "";
  let workspace = "";
  let outside = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "repotrace-classify-"));
    workspace = join(root, "ws");
    outside = join(root, "outside.env");
    await mkdir(workspace, { recursive: true });
    await writeFile(outside, "SECRET=1\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("accepts a real file inside the workspace", async () => {
    await writeFile(join(workspace, "a.ts"), "export const a = 1;\n");
    const c = await classifyPath(workspace, "a.ts");
    expect(c.kind).toBe("ok");
    expect(c.kind === "ok" && c.absolute).toBe(join(workspace, "a.ts"));
  });

  it("calls a traversing path an escape", async () => {
    expect((await classifyPath(workspace, "../outside.env")).kind).toBe("escape");
  });

  it("calls a symlink out of the workspace an escape", async () => {
    await symlink(outside, join(workspace, "creds.txt"));
    expect((await classifyPath(workspace, "creds.txt")).kind).toBe("escape");
  });

  it("calls a path that is simply not there absent, not an escape", async () => {
    expect((await classifyPath(workspace, "sub/module.ts")).kind).toBe("absent");
  });

  it("calls a dangling symlink absent, not an escape", async () => {
    await symlink(join(root, "never-existed"), join(workspace, "dangling.ts"));
    expect((await classifyPath(workspace, "dangling.ts")).kind).toBe("absent");
  });

  it("accepts a symlink that stays inside the workspace", async () => {
    await writeFile(join(workspace, "real.ts"), "export const r = 1;\n");
    await symlink(join(workspace, "real.ts"), join(workspace, "link.ts"));
    const c = await classifyPath(workspace, "link.ts");
    expect(c.kind).toBe("ok");
  });
});
