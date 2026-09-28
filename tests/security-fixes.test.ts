import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isSafeGitRef,
  redactUrl,
  redactSecrets,
  fetchBranch,
  cloneRepository,
} from "@/lib/git/git";
import { errorBody, statusOf, badRequest, notFound } from "@/lib/errors";
import { jsonBody, getParam } from "@/lib/http";

const exec = promisify(execFile);

describe("isSafeGitRef", () => {
  it("accepts ordinary branch names", () => {
    for (const ref of [
      "main",
      "master",
      "develop",
      "release/1.2",
      "feature/JIRA-123_add-widget",
      "v1.0.0",
      "fix.thing",
    ]) {
      expect(isSafeGitRef(ref), ref).toBe(true);
    }
  });

  // Regression: `defaultBranch` is user input and reaches `git fetch origin
  // <ref>` / `git clone --branch <ref>` as a bare argv entry. Git still parses
  // options after a positional argument, so a leading "-" made git execute
  // attacker-chosen commands (verified: --upload-pack=<cmd> ran <cmd>).
  it("rejects refs that git would parse as command-line options", () => {
    const payloads = [
      "--upload-pack=touch /tmp/pwned",
      "--exec=rm -rf /",
      "-x",
      "--help",
      "-",
    ];
    for (const ref of payloads) {
      expect(isSafeGitRef(ref), ref).toBe(false);
    }
  });

  it("rejects refs with control characters, whitespace or shell metacharacters", () => {
    for (const ref of [
      "main; rm -rf /",
      "main\nupload-pack=x",
      "main branch",
      "main\tx",
      "main|cat",
      "main&whoami",
      "main`id`",
      "main$(id)",
      "main~1",
      "main^",
      "main:ref",
      "main?",
      "main*",
      "main[a",
      "main\\b",
    ]) {
      expect(isSafeGitRef(ref), JSON.stringify(ref)).toBe(false);
    }
  });

  it("rejects structurally invalid ref names", () => {
    for (const ref of [
      "",
      "..",
      "a..b",
      "main..",
      "refs/heads/",
      "main/",
      "branch.",
      "@{",
      ".hidden",
      "a/.hidden",
      "x".repeat(256),
    ]) {
      expect(isSafeGitRef(ref), JSON.stringify(ref)).toBe(false);
    }
  });

  it("rejects a ref whose final path segment is a lock file", () => {
    expect(isSafeGitRef("main.lock")).toBe(false);
    expect(isSafeGitRef("a/b.lock")).toBe(false);
  });
});

describe("git ref injection is closed end to end", () => {
  // These call the real code path with a real `git` on PATH. Before the fix,
  // `git fetch origin --upload-pack=<cmd>` executed <cmd>; the canary assertion
  // below is the actual proof, not the error message.
  const CANARY = "/tmp/repotrace-rce-canary";
  const INJECTION = `--upload-pack=touch ${CANARY}`;

  it("fetchBranch refuses an option-shaped branch instead of running git", async () => {
    const err = await fetchBranch("/nonexistent-workspace", "https://example.invalid/x.git", INJECTION)
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/Invalid branch/);
    // A git-originated failure would mention the working directory; a
    // validation rejection never reaches git.
    expect(err!.message).not.toMatch(/nonexistent-workspace/);
  });

  it("cloneRepository refuses an option-shaped branch", async () => {
    const err = await cloneRepository("/tmp/repotrace-should-not-exist", "https://example.invalid/x.git", INJECTION)
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/Invalid branch/);
  });

  it("never executed the injected command", async () => {
    const { existsSync, rmSync } = await import("node:fs");
    expect(existsSync(CANARY)).toBe(false);
    rmSync(CANARY, { force: true });
    expect(existsSync("/tmp/repotrace-should-not-exist")).toBe(false);
  });
});

describe("redactUrl", () => {  it("strips credentials from a URL", () => {
    expect(redactUrl("https://x-access-token:supersecret@github.com/o/r.git")).toBe(
      "https://github.com/o/r.git",
    );
  });

  it("leaves a credential-free URL untouched", () => {
    expect(redactUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
  });

  it("does not throw on a non-URL", () => {
    expect(redactUrl("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  });
});

describe("errorBody", () => {
  // Regression: errorBody returned `err.message` for non-AppError exceptions, so
  // Prisma/Qdrant/fs/git failures (including repository credentials embedded in
  // a git argv) were served to API clients, contradicting route()'s own
  // "no internals leak" docstring.
  it("does not leak internal error messages to clients", () => {
    const body = errorBody(new Error("connect ECONNREFUSED 10.0.0.5:5432 (password=hunter2)"));
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(JSON.stringify(body)).not.toContain("10.0.0.5");
  });

  it("passes AppError code and message through unchanged", () => {
    expect(errorBody(badRequest("invalid_repo_url", "Bad URL")).error).toEqual({
      code: "invalid_repo_url",
      message: "Bad URL",
    });
  });

  // Regression: Zod .parse() failures were 500s leaking the raw issue JSON.
  it("reports Zod failures as a 400 with field-level issues", () => {
    const schema = z.object({ name: z.string().min(1), limit: z.number() });
    let thrown: unknown;
    try {
      schema.parse({ name: "", limit: "nope" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    const body = errorBody(thrown);
    expect(body.error.code).toBe("validation_failed");
    expect(Array.isArray(body.error.details)).toBe(true);
    expect((body.error.details as Array<{ path: string }>).map((d) => d.path)).toContain("limit");
  });
});

describe("statusOf", () => {
  it("uses the AppError status", () => {
    expect(statusOf(badRequest("x", "y"))).toBe(400);
    expect(statusOf(notFound("x", "y"))).toBe(404);
  });

  it("maps a Zod error to 400 rather than 500", () => {
    let thrown: unknown;
    try {
      z.object({ a: z.string() }).parse({});
    } catch (err) {
      thrown = err;
    }
    expect(statusOf(thrown)).toBe(400);
  });

  it("falls back to 500 for unknown errors", () => {
    expect(statusOf(new Error("boom"))).toBe(500);
    expect(statusOf("not an error")).toBe(500);
  });

  // Regression: these used `Object.assign(new Error(...), { status })`, but
  // statusOf() only recognises `instanceof AppError`, so a malformed body
  // returned 500 instead of 400 and a missing param returned 500, not 404.
  it("ignores a bare `status` property on a plain Error", () => {
    expect(statusOf(Object.assign(new Error("x"), { status: 400 }))).toBe(500);
  });
});

describe("jsonBody", () => {
  it("parses a valid JSON body", async () => {
    const req = new Request("http://x", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      headers: { "content-type": "application/json" },
    });
    await expect(jsonBody(req)).resolves.toEqual({ a: 1 });
  });

  it("throws a 400 AppError — not a 500 — on malformed JSON", async () => {
    const req = new Request("http://x", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    const err = await jsonBody(req).catch((e) => e);
    expect(statusOf(err)).toBe(400);
    expect(errorBody(err).error.code).toBe("invalid_json");
  });
});

describe("getParam", () => {
  it("returns the parameter value", () => {
    expect(getParam({ idOrSlug: "abc" }, "idOrSlug")).toBe("abc");
  });

  it("throws a 404 AppError when the parameter is absent", () => {
    const err = (() => {
      try {
        getParam({}, "idOrSlug");
      } catch (e) {
        return e;
      }
    })();
    expect(statusOf(err)).toBe(404);
  });
});

describe("redactUrl is scheme-aware", () => {
  // Regression: redactUrl stripped the username for every scheme the URL parser
  // accepted. For ssh the username is conventionally `git` and is part of the
  // address, so `ssh://git@github.com/o/r.git` became
  // `ssh://github.com/o/r.git` — and since ensureRemote rewrites a remote whose
  // stored URL differs, that value was written into .git/config on every fetch,
  // permanently breaking authentication for every SSH-URL project.
  it("removes http(s) userinfo, which is the credential there", () => {
    expect(redactUrl("https://x-access-token:supersecret@github.com/o/r.git")).toBe(
      "https://github.com/o/r.git",
    );
    expect(redactUrl("http://user:pass@internal/repo.git")).toBe("http://internal/repo.git");
  });

  it("keeps the ssh username but still removes a password", () => {
    expect(redactUrl("ssh://git@github.com/o/r.git")).toBe("ssh://git@github.com/o/r.git");
    expect(redactUrl("ssh://git@host:2222/o/r.git")).toBe("ssh://git@host:2222/o/r.git");
    expect(redactUrl("ssh://git:hunter2@host/o/r.git")).toBe("ssh://git@host/o/r.git");
  });

  it("leaves the scp-style form and other schemes untouched", () => {
    expect(redactUrl("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
    expect(redactUrl("file:///tmp/repo")).toBe("file:///tmp/repo");
  });

  // Scope of the guarantee, pinned by a test so the docstring cannot quietly
  // drift back to "safe to log or persist". redactUrl removes *userinfo* only:
  // a token in the query string or the path survives, because this function's
  // output is also the URL written back as the fetch remote and dropping query
  // parameters would break hosts that require them. Callers holding such a URL
  // get no protection from it — this test exists to say so out loud.
  it("does NOT remove a credential carried in the query string", () => {
    const url = "https://host/r.git?access_token=supersecret";
    expect(redactUrl(url)).toBe(url);
    expect(redactUrl(url)).toContain("supersecret");
  });
});

describe("redactSecrets", () => {
  // Regression: the general userinfo pattern required a username *and* a
  // password (`[^/\s:@]+:[^/\s@]+@`). `https://TOKEN@host/r.git` — a real shape,
  // and the only one left when an operator pastes a token into the project
  // form, since then `creds` is null and the literal-substitution pass has no
  // secret to look for — sailed through into Job.error.
  it("redacts a userinfo credential that has no password", () => {
    const message =
      "Command failed: git clone --filter=blob:none --branch main --single-branch " +
      "https://ghp_TOPSECRET@github.com/o/r.git /ws/repo";
    const out = redactSecrets(message, [undefined]);
    expect(out).not.toContain("ghp_TOPSECRET");
    expect(out).toContain("https://***@github.com/o/r.git");
  });

  it("still redacts a user:pass credential", () => {
    const out = redactSecrets("fatal: could not read from https://user:pw@host/r.git", []);
    expect(out).toBe("fatal: could not read from https://***@host/r.git");
  });

  it("redacts the known secret and its percent-encoded form", () => {
    expect(redactSecrets("token=a b/c here", ["a b/c"])).toBe("token=*** here");
    expect(redactSecrets("token=a%20b%2Fc here", ["a b/c"])).toBe("token=*** here");
  });

  // The pattern is bounded to the authority: it must not run past the host and
  // redact an unrelated `@` further along the string.
  it("does not touch credential-free URLs, scp syntax, or later @ signs", () => {
    for (const message of [
      "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
      "git@github.com:o/r.git",
      "file:///tmp/repo",
      "https://host/o/r.git",
      "author John Smith <john@example.com> pushed",
    ]) {
      expect(redactSecrets(message, []), message).toBe(message);
    }
  });
});

describe("fetchBranch reports what actually failed", () => {
  // These drive the real git CLI against a throwaway local repository, because
  // the defect was in which git messages the error rewrite matched, and only
  // real git can say which messages those are.
  let root = "";
  let upstream = "";
  let workspace = "";

  const git = async (dir: string, ...args: string[]) =>
    exec("git", ["-C", dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "repotrace-gitfail-"));
    upstream = join(root, "upstream");
    workspace = join(root, "ws");
    await git(root, "init", "-q", "-b", "main", upstream);
    await git(upstream, "config", "user.email", "test@repotrace.local");
    await git(upstream, "config", "user.name", "Repotrace Test");
    await writeFile(join(upstream, "f.txt"), "line1\n");
    await git(upstream, "add", "-A");
    await git(upstream, "commit", "-qm", "c1");
    await cloneRepository(workspace, `file://${upstream}`, "main");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("explains a branch that no longer exists, keeping git's own wording", async () => {
    const err = await fetchBranch(workspace, `file://${upstream}`, "deleted-branch")
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/no longer exists on the remote/);
    // git's text is retained: the branch name git actually looked for is in it.
    expect(err!.message).toMatch(/couldn't find remote ref deleted-branch/);
  });

  // Regression: "does not appear to be a git repository" was matched by the
  // rewrite, so deleting the repository (or losing permission to it) reported
  // "Branch X no longer exists on the remote" — sending the operator to fix a
  // branch that is still perfectly well there.
  it("does not claim the branch was deleted when the repository is gone", async () => {
    await rm(upstream, { recursive: true, force: true });
    const err = await fetchBranch(workspace, `file://${upstream}`, "main")
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toMatch(/no longer exists on the remote/);
    // git's real diagnosis survives.
    expect(err!.message).toMatch(/does not appear to be a git repository/);
  });
});
