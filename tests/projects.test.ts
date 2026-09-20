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
});