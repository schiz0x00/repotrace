import { route, json, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { findTests } from "@/lib/search/structural";

export const runtime = "nodejs";

/** GET /api/v1/projects/:idOrSlug/tests?symbol= */
export async function GET(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const symbol = new URL(req.url).searchParams.get("symbol") ?? undefined;
    const tests = await findTests(project.id, symbol, 25);
    return json({ tests });
  })(request, {});
}