import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalRepoUrl, generateWebhookSecret, verifyWebhookSignature } from "@/lib/github/webhook";

function signature(secret: string, body: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifyWebhookSignature", () => {
  const secret = "test-secret";
  const body = Buffer.from('{"ref":"refs/heads/main","after":"abc123"}');

  it("accepts a valid sha256 signature", () => {
    expect(verifyWebhookSignature(secret, body, signature(secret, body))).toBe(true);
  });

  it("rejects a tampered body", () => {
    const tampered = Buffer.from('{"ref":"refs/heads/evil","after":"abc123"}');
    expect(verifyWebhookSignature(secret, tampered, signature(secret, body))).toBe(false);
  });

  it("rejects a signature produced with the wrong secret", () => {
    expect(verifyWebhookSignature("wrong-secret", body, signature(secret, body))).toBe(false);
  });

  it("rejects legacy sha1 (x-hub-signature) headers", () => {
    const sha1 = `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`;
    expect(verifyWebhookSignature(secret, body, sha1)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyWebhookSignature(secret, body, null)).toBe(false);
  });

  it("verifies the same body as a utf8 string", () => {
    const asString = body.toString("utf8");
    expect(verifyWebhookSignature(secret, asString, signature(secret, asString))).toBe(true);
  });
});

describe("canonicalRepoUrl", () => {
  // Regression: projectForPushEvent fell back to `repoUrl: { contains: ... }`,
  // so a push to `acme/foo` matched a project configured as `acme/foobar` and
  // triggered indexing of the wrong repository. Matching is now exact.
  it("collapses the spellings GitHub reports for one repository", () => {
    const forms = [
      "https://github.com/acme/foo",
      "https://github.com/acme/foo.git",
      "https://github.com/acme/foo/",
      "git@github.com:acme/foo.git",
      "ssh://git@github.com/acme/foo.git",
      "https://x-access-token:tok@github.com/acme/foo.git",
    ];
    const canonical = forms.map(canonicalRepoUrl);
    for (const c of canonical) expect(c, c).toBe("github.com/acme/foo");
  });

  it("keeps distinct repositories distinct", () => {
    // The exact pair the old `contains` fallback conflated.
    expect(canonicalRepoUrl("https://github.com/acme/foo")).not.toBe(
      canonicalRepoUrl("https://github.com/acme/foobar"),
    );
    expect(canonicalRepoUrl("https://github.com/acme/foo")).not.toBe(
      canonicalRepoUrl("https://gitlab.com/acme/foo"),
    );
  });

  it("tolerates junk without throwing", () => {
    expect(canonicalRepoUrl("")).toBe("");
    expect(canonicalRepoUrl("not a url")).toBe("not a url");
  });
});

describe("generateWebhookSecret", () => {
  it("is deterministic per project id", () => {
    expect(generateWebhookSecret("proj-1")).toBe(generateWebhookSecret("proj-1"));
  });

  it("differs across project ids", () => {
    expect(generateWebhookSecret("proj-1")).not.toBe(generateWebhookSecret("proj-2"));
  });

  it("produces a hex sha256 digest", () => {
    expect(generateWebhookSecret("proj-1")).toMatch(/^[0-9a-f]{64}$/);
  });
});