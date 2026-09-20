import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, verifyApiKey, API_KEY_PREFIX } from "@/lib/api-keys";

describe("generateApiKey", () => {
  it("returns a key with the rt_ prefix", () => {
    const { plaintext } = generateApiKey();
    expect(plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(plaintext).toMatch(/^rt_[A-Za-z0-9_-]+$/);
  });

  it("exposes the first ten characters as the lookup prefix", () => {
    const { plaintext, prefix } = generateApiKey();
    expect(prefix).toBe(plaintext.slice(0, 10));
    expect(prefix.startsWith("rt_")).toBe(true);
  });

  it("stores a sha256 hex digest of the key", () => {
    const { plaintext, hash } = generateApiKey();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashApiKey(plaintext));
    expect(verifyApiKey(plaintext, hash)).toBe(true);
  });

  it("generates distinct keys", () => {
    const a = generateApiKey().plaintext;
    const b = generateApiKey().plaintext;
    expect(a).not.toBe(b);
  });
});

describe("hashApiKey", () => {
  it("is deterministic for the same key", () => {
    const key = generateApiKey().plaintext;
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  it("differs between keys", () => {
    expect(hashApiKey("rt_key-one")).not.toBe(hashApiKey("rt_key-two"));
  });

  it("rejects a hash for a different key", () => {
    const { plaintext, hash } = generateApiKey();
    expect(verifyApiKey(`${plaintext}x`, hash)).toBe(false);
  });
});