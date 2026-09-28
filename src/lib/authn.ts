import { auth } from "@/lib/auth";
import { verifyApiKey } from "@/lib/api-keys";
import { unauthorized } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

export interface ApiKeyPrincipal {
  type: "api_key";
  apiKeyId: string;
  projectId: string | null;
}

export interface SessionPrincipal {
  type: "session";
  userId: string;
}

export type Principal = ApiKeyPrincipal | SessionPrincipal;

/**
 * Authenticates a request through either:
 *  1. `Authorization: Bearer rt_...` — machine/agent credential (hashed at rest)
 *  2. Better Auth session cookie — human dashboard user
 *
 * Returns null when the request carries no credentials.
 */
/** Minimum interval between `lastUsedAt` writes for the same key. */
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60_000;

export async function authenticateRequest(
  request: Request,
): Promise<Principal | null> {
  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (!token) throw unauthorized("invalid_api_key", "Missing API key");
    const key = await apiKeyHashFor(token);
    if (!key) throw unauthorized("invalid_api_key", "Invalid or revoked API key");
    // Throttled: this ran on every authenticated request, turning read-only
    // traffic into a write and a new row version per call. An agent polling
    // search would generate a steady stream of dead tuples in api_key for a
    // timestamp that only needs minute-level resolution.
    const stale = !key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS;
    if (stale) {
      await prisma().apiKey.update({
        where: { id: key.id },
        data: { lastUsedAt: new Date() },
      });
    }
    return { type: "api_key", apiKeyId: key.id, projectId: key.projectId };
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (session) {
    return { type: "session", userId: session.user.id };
  }
  return null;
}

async function apiKeyHashFor(token: string) {
  const prefix = token.slice(0, 10);
  const candidates = await prisma().apiKey.findMany({
    where: { keyPrefix: prefix, revokedAt: null },
    select: { id: true, keyHash: true, projectId: true, lastUsedAt: true },
  });
  for (const key of candidates) {
    if (verifyApiKey(token, key.keyHash)) return key;
  }
  return null;
}

/**
 * Whether a principal may touch a project. API keys are scoped to zero or one
 * project; an unscoped key is owner-level. Session users may access every
 * project.
 */
export function canAccessProject(principal: Principal, projectId: string): boolean {
  if (principal.type === "session") return true;
  return principal.projectId === null || principal.projectId === projectId;
}