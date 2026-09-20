import { auth } from "@/lib/auth";
import { verifyApiKey } from "@/lib/api-keys";
import { forbidden, unauthorized } from "@/lib/errors";
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
export async function authenticateRequest(
  request: Request,
): Promise<Principal | null> {
  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (!token) throw unauthorized("invalid_api_key", "Missing API key");
    const hash = await apiKeyHashFor(token);
    if (!hash) throw unauthorized("invalid_api_key", "Invalid or revoked API key");
    await prisma().apiKey.update({
      where: { id: hash.id },
      data: { lastUsedAt: new Date() },
    });
    return { type: "api_key", apiKeyId: hash.id, projectId: hash.projectId };
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
    select: { id: true, keyHash: true, projectId: true },
  });
  for (const key of candidates) {
    if (verifyApiKey(token, key.keyHash)) return key;
  }
  return null;
}

/**
 * Resolves a project scope for a principal. API keys are scoped to zero or one
 * project; anything else is forbidden. Session users may access every project.
 */
export function assertProjectAccess(principal: Principal, projectId: string): void {
  if (principal.type === "api_key") {
    if (principal.projectId !== null && principal.projectId !== projectId) {
      throw forbidden("project_forbidden", "This API key cannot access the requested project");
    }
  }
}

/** API keys without a project scope can access every project (owner-level). */
export function canAccessProject(principal: Principal, projectId: string): boolean {
  if (principal.type === "session") return true;
  return principal.projectId === null || principal.projectId === projectId;
}