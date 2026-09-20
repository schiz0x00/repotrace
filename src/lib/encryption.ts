import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Encrypts a secret (e.g. repository credentials) at rest.
 * Format: base64(iv | ciphertext | tag) with a fresh 96-bit IV per message.
 */
export function encryptSecret(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = cipher.update(plaintext);
  cipher.final();
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

/** Decrypts a value produced by {@link encryptSecret}. */
export function decryptSecret(encoded: string): string {
  const key = deriveKey();
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(raw.length - TAG_LEN);
  const ct = raw.subarray(IV_LEN, raw.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const out = decipher.update(ct);
  return Buffer.concat([out, decipher.final()]).toString("utf8");
}

let cachedKey: Buffer | undefined;

function deriveKey(): Buffer {
  if (cachedKey) return cachedKey;
  const b64 = env().REPO_CREDENTIALS_KEY;
  if (!b64) {
    throw new Error(
      "REPO_CREDENTIALS_KEY is not configured; set it to a base64-encoded 32-byte key (openssl rand -base64 32)",
    );
  }
  cachedKey = Buffer.from(b64, "base64");
  if (cachedKey.length !== 32) {
    throw new Error("REPO_CREDENTIALS_KEY must decode to exactly 32 bytes");
  }
  return cachedKey;
}