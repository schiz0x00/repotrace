import { createCipheriv, randomBytes } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * These tests drive `@/lib/encryption` itself, never a re-implementation of it.
 *
 * `deriveKey` memoizes the key in a module-level `cachedKey` and `@/lib/env`
 * memoizes its parsed schema, so nothing here can be asserted through a
 * top-level import: the value read at import time is the value under test. Each
 * test therefore sets the key, resets the module registry and imports afresh,
 * which is also the only way to compare two keys in one process.
 *
 * The keys are generated here rather than read from the environment so the file
 * does not depend on a deployment's `REPO_CREDENTIALS_KEY` being a valid
 * 32-byte value.
 */

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);

let originalKey: string | undefined;

beforeAll(() => {
  originalKey = process.env.REPO_CREDENTIALS_KEY;
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.REPO_CREDENTIALS_KEY;
  else process.env.REPO_CREDENTIALS_KEY = originalKey;
  vi.resetModules();
});

/** A module-fresh `@/lib/encryption` that will derive its key from `key`. */
async function loadedWith(key: Buffer) {
  process.env.REPO_CREDENTIALS_KEY = key.toString("base64");
  vi.resetModules();
  return import("@/lib/encryption");
}

/** The documented wire format, written by hand: base64(iv | ciphertext | tag). */
function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = cipher.update(plaintext);
  cipher.final();
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64");
}

describe("key format handling", () => {
  it("rejects a key that does not decode to exactly 32 bytes", async () => {
    // "c2hvcnRy" is base64 for "short": 5 bytes, so the length check is what
    // has to fire, not the cipher (which wants exactly 32).
    process.env.REPO_CREDENTIALS_KEY = Buffer.from("short").toString("base64");
    vi.resetModules();
    const fresh = await import("@/lib/encryption");
    expect(() => fresh.encryptSecret("x")).toThrowError(/exactly 32 bytes/);
  });

  it("rejects a missing key with a clear error", async () => {
    // The variable is DELETED, not set to "": `REPO_CREDENTIALS_KEY` is declared
    // `z.string().min(1).default("")`, so an explicit empty string is rejected
    // earlier by env validation with a different message. Unset is what lets
    // the default through and reaches `deriveKey`'s own "not configured"
    // branch, which is the branch this test is named for.
    delete process.env.REPO_CREDENTIALS_KEY;
    vi.resetModules();
    const fresh = await import("@/lib/encryption");
    expect(() => fresh.encryptSecret("x")).toThrowError(
      /REPO_CREDENTIALS_KEY is not configured/,
    );
  });
});

describe("encryptSecret", () => {
  it("round-trips a secret through decryptSecret", async () => {
    const { encryptSecret, decryptSecret } = await loadedWith(KEY_A);
    const secret = "ghp_token_1234567890abcdef";
    const encoded = encryptSecret(secret);
    expect(decryptSecret(encoded)).toBe(secret);
  });

  it("does not store the plaintext", async () => {
    const { encryptSecret } = await loadedWith(KEY_A);
    const encoded = encryptSecret("super-secret-value");
    expect(encoded).not.toContain("super-secret-value");
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("uses a fresh IV so identical inputs produce different ciphertexts", async () => {
    const { encryptSecret, decryptSecret } = await loadedWith(KEY_A);
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    expect(a).not.toBe(b);
    // Both still read back, so the difference is the IV and not corruption.
    expect([decryptSecret(a), decryptSecret(b)]).toEqual(["same-input", "same-input"]);
  });

  // Both halves go through the exported `decryptSecret`, each against a
  // different process-wide key: encrypt under KEY_A, then read the same bytes
  // back under KEY_B and require the GCM auth tag to reject them. Testing this
  // with a local re-implementation of the decipher would pass even if
  // `decryptSecret` were deleted.
  it("decrypts under the key it was encrypted with and refuses a different one", async () => {
    const encA = await loadedWith(KEY_A);
    const encoded = encA.encryptSecret("payload");

    const decA = await loadedWith(KEY_A);
    expect(decA.decryptSecret(encoded)).toBe("payload");

    const decB = await loadedWith(KEY_B);
    expect(() => decB.decryptSecret(encoded)).toThrow();
  });

  // Pins the storage contract rather than a round trip: a ciphertext written
  // as base64(iv | ciphertext | tag) — the layout documented on
  // `encryptSecret` — is what `decryptSecret` must be able to read. Changing
  // either side of the format breaks real rows in the database, so this fails
  // even though nothing in the test calls `encryptSecret`.
  it("reads a ciphertext in the documented base64(iv | ciphertext | tag) layout", async () => {
    const { decryptSecret } = await loadedWith(KEY_A);
    expect(decryptSecret(seal("hello", KEY_A))).toBe("hello");
  });
});
