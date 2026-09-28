import { describe, expect, it } from "vitest";
import { normalizeRepoUrl, slugify, createProject } from "@/lib/projects/service";
import { AppError } from "@/lib/errors";

describe("slugify", () => {
  it("lowercases and collapses whitespace/punctuation to dashes", () => {
    expect(slugify("My Cool Project")).toBe("my-cool-project");
    expect(slugify("  Hello   World  ")).toBe("hello-world");
    expect(slugify("user/api-server")).toBe("user-api-server");
  });

  it("strips leading and trailing separators", () => {
    expect(slugify("-hello-")).toBe("hello");
    expect(slugify("hello-")).toBe("hello");
  });

  it("falls back to 'project' for empty or non-alphanumeric names", () => {
    expect(slugify("")).toBe("project");
    expect(slugify("   ")).toBe("project");
    expect(slugify("你好")).toBe("project");
    expect(slugify("!!!")).toBe("project");
  });

  it("truncates to 60 characters", () => {
    const long = slugify("x".repeat(80));
    expect(long).toHaveLength(60);
  });

  it("strips unicode but keeps ascii letters and digits", () => {
    expect(slugify("café")).toBe("caf");
    expect(slugify("React 18")).toBe("react-18");
  });
});

describe("normalizeRepoUrl", () => {
  it("passes through supported URL schemes", () => {
    for (const url of [
      "https://github.com/owner/repo.git",
      "http://example.com/repo",
      "git@github.com:owner/repo.git",
      "ssh://git@example.com/repo",
      "file:///tmp/repo",
    ]) {
      expect(normalizeRepoUrl(url)).toBe(url);
    }
  });

  it("expands provider shorthand", () => {
    expect(normalizeRepoUrl("github.com/owner/repo")).toBe("https://github.com/owner/repo");
  });

  it("rejects unparseable input", () => {
    expect(() => normalizeRepoUrl("not a url")).toThrowError(/Repository URL/);
  });

  // The server clones whatever URL it is handed, so a cloud metadata address
  // would turn "index my repo" into a request that returns instance
  // credentials. Loopback and RFC1918 stay allowed: a self-hosted git server
  // on a LAN or inside a compose network is a legitimate target.
  it("refuses link-local and metadata addresses", () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "https://169.254.169.254/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://localhost:3000/repo.git",
      "http://[fe80::1]/repo.git",
    ]) {
      expect(() => normalizeRepoUrl(url), url).toThrowError(/link-local|metadata/);
    }
  });

  it("still allows private-network git servers", () => {
    for (const url of ["http://10.0.0.5:8080/git/repo.git", "http://192.168.1.10/repo.git"]) {
      expect(normalizeRepoUrl(url)).toBe(url);
    }
  });
});

describe("createProject validation", () => {
  it("rejects an invalid repository URL before touching the database", async () => {
    try {
      await createProject({ name: "invalid", repoUrl: "garbage!" });
      expect.unreachable("createProject should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("invalid_repo_url");
      expect((err as AppError).status).toBe(400);
    }
  });

  // The git layer re-validates the ref and is what prevents the RCE, but a bad
  // branch accepted here is only discovered when a sync runs, so the operator
  // gets a job failure rather than a rejected request.
  it("rejects a branch git would parse as an option, before touching the database", async () => {
    try {
      await createProject({
        name: "injection",
        repoUrl: "https://github.com/owner/repo",
        defaultBranch: "--upload-pack=touch /tmp/pwned",
      });
      expect.unreachable("createProject should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("invalid_branch");
      expect((err as AppError).status).toBe(400);
    }
  });
});