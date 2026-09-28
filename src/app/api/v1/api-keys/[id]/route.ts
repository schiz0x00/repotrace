import { route, json, getParam } from "@/lib/http";
import { requirePrincipal } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";
import { notFound, forbidden } from "@/lib/errors";

export const runtime = "nodejs";

/** DELETE /api/v1/api-keys/:id — revoke a machine credential */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return route(async (req) => {
    const principal = await requirePrincipal(req);
    if (principal.type === "api_key") {
      throw forbidden("forbidden", "API keys cannot revoke keys");
    }
    const { id } = await context.params;
    // Idempotent by design. `update()` on a missing row raises a Prisma
    // "record not found" error that surfaced as a 500, so this became an
    // updateMany — but filtering on `revokedAt: null` then made revoking an
    // ALREADY-revoked key a 404 where it used to be a 200. DELETE is
    // idempotent by definition, and a double-click in the dashboard is the
    // common case: it produced a "Could not revoke key" toast for a revoke
    // that had in fact already happened.
    //
    // So: distinguish "no such key" from "already revoked", and succeed on the
    // latter while saying which happened.
    const keyId = getParam({ id }, "id");
    const existing = await prisma().apiKey.findUnique({ where: { id: keyId }, select: { revokedAt: true } });
    if (!existing) throw notFound("api_key_not_found", "API key not found");
    if (existing.revokedAt) return json({ revoked: true, alreadyRevoked: true });
    await prisma().apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
    return json({ revoked: true, alreadyRevoked: false });
  })(request, {});
}