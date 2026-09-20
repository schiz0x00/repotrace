import { z } from "zod";
import { route, json, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { findReferences } from "@/lib/search/structural";

export const runtime = "nodejs";

/** GET /api/v1/projects/:idOrSlug/symbols/:name/references */
export async function GET(request: Request, context: { params: Promise<Record<string, string>> }) {
  return route(async (req) => {
    const params = await context.params;
    const { project } = await requireScopedProject(req, getParam(params, "idOrSlug"));
    const name = getParam(params, "name");
    const limit = z.coerce.number().int().min(1).max(100).default(50).parse(
      new URL(req.url).searchParams.get("limit") ?? undefined,
    );
    const refs = await findReferences(project.id, name, limit);
    return json({ symbol: name, references: refs });
  })(request, {});
}