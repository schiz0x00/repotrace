import { headers } from "next/headers";
import { z } from "zod";
import { api } from "@/components/dashboard/data";
import { AccountSettings, type SessionDto } from "@/components/dashboard/account-settings";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { ApiKeyDto, ProjectDto } from "@/components/dashboard/types";

interface ApiKeysResponse {
  apiKeys: ApiKeyDto[]
}

interface ProjectsResponse {
  projects: ProjectDto[]
}

/** Argument of the revoke function below. Untrusted: it arrives over HTTP. */
const RevokeTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), sessionId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("others") }),
]);

export interface RevokeResult {
  ok: boolean;
  error?: string;
}

/**
 * Active sessions for the signed-in user, newest activity first. Scoped by
 * `userId` from the server-verified session — never a caller-supplied id — and
 * only sessions that have not expired, matching what better-auth's own
 * list-sessions endpoint returns.
 */
async function loadSessions(): Promise<SessionDto[]> {
  const requestHeaders = await headers();
  const current = await auth.api.getSession({ headers: requestHeaders });
  if (!current) return [];
  const rows = await prisma().session.findMany({
    where: { userId: current.user.id, expiresAt: { gt: new Date() } },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      ipAddress: true,
      userAgent: true,
      createdAt: true,
      updatedAt: true,
      expiresAt: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    current: row.id === current.session.id,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
    lastActiveAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }));
}

export default async function SettingsPage() {
  const { apiKeys } = await api<ApiKeysResponse>("/api/v1/api-keys")
  const { projects } = await api<ProjectsResponse>("/api/v1/projects")
  const sessions = await loadSessions()

  // Server function: revoking a session is a mutation, and going through the
  // server keeps the session token out of the RSC payload sent to the browser.
  async function revokeSessions(target: unknown): Promise<RevokeResult> {
    "use server"
    // Server functions are reachable by direct POST, so the argument is
    // validated rather than trusted.
    const parsed = RevokeTarget.safeParse(target);
    if (!parsed.success) return { ok: false, error: "Invalid request." };
    try {
      const requestHeaders = await headers();
      const current = await auth.api.getSession({ headers: requestHeaders });
      if (!current) return { ok: false, error: "Your session has expired. Sign in again." };
      if (parsed.data.kind === "others") {
        await auth.api.revokeOtherSessions({ headers: requestHeaders });
        return { ok: true };
      }
      const row = await prisma().session.findFirst({
        where: { id: parsed.data.sessionId, userId: current.user.id },
        select: { token: true },
      });
      if (!row) return { ok: false, error: "That session is no longer active." };
      // better-auth checks that the target token belongs to the calling user
      // before deleting it; the lookup above is the scoping this app relies on.
      await auth.api.revokeSession({ headers: requestHeaders, body: { token: row.token } });
      return { ok: true };
    } catch {
      // A revocation failure is not worth surfacing as a 500: the session may
      // already be gone, and the user can retry from a fresh list.
      return { ok: false, error: "Could not revoke that session. Try again." };
    }
  }

  return <AccountSettings apiKeys={apiKeys} projects={projects} sessions={sessions} revokeSessions={revokeSessions} />
}
