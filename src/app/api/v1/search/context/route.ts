import { z } from "zod";
import { route, json } from "@/lib/http";
import { requirePrincipal } from "@/lib/api/guard";
import { canAccessProject } from "@/lib/authn";
import { prisma } from "@/lib/prisma";
import { notFound } from "@/lib/errors";

export const runtime = "nodejs";

/** POST /api/v1/search/context — curated context bundle for a question */
export async function POST(request: Request) {
  return route(async (req) => {
    const principal = await requirePrincipal(req);
    const body = await req.json().catch(() => ({}));
    const schema = z.object({
      project: z.string().min(1),
      query: z.string().min(1).max(2000),
      limit: z.number().int().min(1).max(12).default(8),
    });
    const parsed = schema.parse(body);
    const project = await prisma().project.findFirst({
      where: { OR: [{ id: parsed.project }, { slug: parsed.project }] },
      select: { id: true },
    });
    if (!project) throw notFound("project_not_found", "Project not found");
    if (!canAccessProject(principal, project.id)) {
      return json({ error: { code: "project_forbidden", message: "This credential cannot access the project" } }, 403);
    }
    const { buildContextBundle } = await import("@/lib/search/context");
    const bundle = await buildContextBundle(project.id, parsed.query, { limit: parsed.limit });
    return json(bundle);
  })(request, {});
}