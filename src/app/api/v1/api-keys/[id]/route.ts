import { route, json, getParam } from "@/lib/http";
import { requirePrincipal } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/** DELETE /api/v1/api-keys/:id — revoke a machine credential */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return route(async (req) => {
    const principal = await requirePrincipal(req);
    if (principal.type === "api_key") {
      return json({ error: { code: "forbidden", message: "API keys cannot revoke keys" } }, 403);
    }
    const { id } = await context.params;
    await prisma().apiKey.update({
      where: { id: getParam({ id }, "id") },
      data: { revokedAt: new Date() },
    });
    return json({ revoked: true });
  })(request, {});
}