import { z } from "zod";
import { route, json, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { buildContextBundle } from "@/lib/search/context";

export const runtime = "nodejs";

/** POST /api/v1/projects/:idOrSlug/search/context — curated context bundle */
export async function POST(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const body = await req.json().catch(() => ({}));
    const schema = z.object({
      query: z.string().min(1).max(2000),
      limit: z.number().int().min(1).max(12).default(8),
    });
    const { query, limit } = schema.parse(body);
    const bundle = await buildContextBundle(project.id, query, { limit });
    return json(bundle);
  })(request, {});
}