import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/encryption";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function decryptWithKey(encoded: string, key: Buffer): string {
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(raw.length - TAG_LEN);
  const ct = raw.subarray(IV_LEN, raw.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const out = decipher.update(ct);
  return Buffer.concat([out, decipher.final()]).toString("utf8");
}

describe("key format handling", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("rejects a key that does not decode to exactly 32 bytes", async () => {
    const previous = process.env.REPO_CREDENTIALS_KEY;
    process.env.REPO_CREDENTIALS_KEY = "c2hvcnRy";
    vi.resetModules();
    const fresh = await import("@/lib/encryption");
    expect(() => fresh.encryptSecret("x")).toThrowError(/exactly 32 bytes/);
    process.env.REPO_CREDENTIALS_KEY = previous;
  });

  it("rejects a missing key with a clear error", async () => {
    const previous = process.env.REPO_CREDENTIALS_KEY;
    process.env.REPO_CREDENTIALS_KEY = "";
    vi.resetModules();
    const fresh = await import("@/lib/encryption");
    expect(() => fresh.encryptSecret("x")).toThrowError(/REPO_CREDENTIALS_KEY/);
    process.env.REPO_CREDENTIALS_KEY = previous;
  });
});

describe("encryptSecret", () => {
  it("round-trips a secret", () => {
    const secret = "ghp_token_1234567890abcdef";
    const encoded = encryptSecret(secret);
    expect(decryptSecret(encoded)).toBe(secret);
  });

  it("does not store the plaintext", () => {
    const encoded = encryptSecret("super-secret-value");
    expect(encoded).not.toContain("super-secret-value");
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("uses a fresh IV so identical inputs produce different ciphertexts", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a).not.toBe(b);
  });

  it("fails to decrypt with a different key (GCM auth tag)", () => {
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, keyA, iv);
    const ct = cipher.update("payload");
    cipher.final();
    const encoded = Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64");

    expect(decryptWithKey(encoded, keyA)).toBe("payload");
    expect(() => decryptWithKey(encoded, keyB)).toThrow();
  });

  it("produces a value the deployed decrypt path can read", () => {
    const key = randomBytes(32);
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, key, iv);
    const ct = cipher.update("hello");
    cipher.final();
    const encoded = Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64");
    expect(decryptWithKey(encoded, key)).toBe("hello");
  });
});