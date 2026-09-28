import { describe, expect, it } from "vitest";
import { isSensitivePath } from "@/lib/indexing/pipeline";

/**
 * Files that would leak a live secret into Postgres, Qdrant and the MCP
 * `get_file` tool if indexed. `.gitignore` is not a defence: the indexer works
 * from `git ls-files`, so it only sees files the repository actually tracks.
 */
describe("isSensitivePath", () => {
  it("refuses credential files by name", () => {
    for (const p of [
      ".env",
      ".env.local",
      ".env.production",
      "deploy/.env",
      ".npmrc",
      ".netrc",
      ".pypirc",
      "id_rsa",
      "id_ed25519",
      "secrets.yaml",
      "credentials.json",
    ]) {
      expect(isSensitivePath(p), p).toBe(true);
    }
  });

  it("refuses private key formats", () => {
    for (const p of ["cert.pem", "server.key", "store.p12", "vault.pfx", "a/b/thing.asc"]) {
      expect(isSensitivePath(p), p).toBe(true);
    }
  });

  // Regression: the extension check used `dot <= 0`, which was meant to skip
  // names with no extension but also exempted every file named exactly `.pem`
  // or `.key` — a leading dot puts the dot at index 0.
  it("refuses a key file named with a leading dot and no basename", () => {
    for (const p of [".pem", ".key", ".p12", ".pfx", ".asc"]) {
      expect(isSensitivePath(p), p).toBe(true);
    }
  });

  it("allows ordinary source", () => {
    for (const p of [
      "src/index.ts",
      "src/components/Button.tsx",
      "lib/env.ts",
      "docs/keyboard.md",
      "src/keys.ts",
      "README.md",
    ]) {
      expect(isSensitivePath(p), p).toBe(false);
    }
  });
});

describe("tool credential files that are routinely committed", () => {
  // The deny list's premise is that .gitignore is no defence, because only
  // files git actually tracks are ever read. That makes these the ones that
  // matter: each is a credential store that repositories genuinely commit.
  // Every one of them returned false from `isSensitivePath` before this.
  it("refuses committed tool credential files", () => {
    for (const p of [
      ".git-credentials",
      ".dockercfg",
      ".s3cfg",
      "terraform.tfvars",
      "prod.tfvars",
      "prod.tfvars.json",
      "vault.json",
      "settings.xml",
      ".htpasswd",
      "infra/main.tfvars",
    ]) {
      expect(isSensitivePath(p), p).toBe(true);
    }
  });

  it("does not start refusing ordinary source and config", () => {
    for (const p of [
      "src/variables.ts",
      "infra/main.tf",
      "infra/variables.tf",
      "maven-plugin.xml",
      "src/settings.ts",
      "app/vault.ts",
      "docs/terraform.md",
    ]) {
      expect(isSensitivePath(p), p).toBe(false);
    }
  });
});

describe("shouldPurgeIndexedPath", () => {
  // The deny list only stopped NEW indexing. A secret indexed before it
  // existed was still in Postgres, Qdrant and every search result, and a
  // `full` reindex — the operation whose whole purpose is rebuilding from
  // scratch — walked straight past it, because the file was still tracked by
  // git and processFile simply skipped it. So the deny list was forward-only,
  // and the operator's own remedy did not work.
  it("purges a tracked file the indexer now refuses", async () => {
    const { shouldPurgeIndexedPath } = await import("@/lib/indexing/pipeline");
    const tracked = new Set([".env", "src/index.ts", "terraform.tfvars"]);
    expect(shouldPurgeIndexedPath(".env", tracked)).toBe(true);
    expect(shouldPurgeIndexedPath("terraform.tfvars", tracked)).toBe(true);
    // Still wanted, so it stays.
    expect(shouldPurgeIndexedPath("src/index.ts", tracked)).toBe(false);
  });

  it("purges a file git no longer tracks, whatever it is", async () => {
    const { shouldPurgeIndexedPath } = await import("@/lib/indexing/pipeline");
    expect(shouldPurgeIndexedPath("src/removed.ts", new Set(["src/index.ts"]))).toBe(true);
  });
});
