import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const API_KEY_PREFIX = "rt_";

/**
 * Machine credentials for MCP/API access. Keys are shown once at creation;
 * only a SHA-256 hash is stored, so a leaked database never exposes usable keys.
 */
export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const raw = randomBytes(32).toString("base64url").replaceAll("=", "");
  const plaintext = `${API_KEY_PREFIX}${raw}`;
  return { plaintext, prefix: plaintext.slice(0, 10), hash: hashApiKey(plaintext) };
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function verifyApiKey(plaintext: string, storedHash: string): boolean {
  const candidate = hashApiKey(plaintext);
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}