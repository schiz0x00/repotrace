import { z } from "zod";
import { route, json, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { searchSymbols } from "@/lib/search/structural";

export const runtime = "nodejs";

/** GET /api/v1/projects/:idOrSlug/symbols?q=&kind=&language=&limit= */
export async function GET(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const { searchParams } = new URL(req.url);
    const schema = z.object({
      q: z.string().default(""),
      kind: z.string().optional(),
      language: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    });
    const parsed = schema.parse({
      q: searchParams.get("q"),
      kind: searchParams.get("kind"),
      language: searchParams.get("language"),
      limit: searchParams.get("limit"),
    });
    const symbols = await searchSymbols(project.id, parsed.q, {
      limit: parsed.limit,
      kind: parsed.kind,
      language: parsed.language,
    });
    return json({ symbols });
  })(request, {});
}