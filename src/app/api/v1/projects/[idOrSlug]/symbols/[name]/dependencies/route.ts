import { route, json, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { findDependencies, findSymbol } from "@/lib/search/structural";

export const runtime = "nodejs";

/** GET /api/v1/projects/:idOrSlug/symbols/:name/dependencies */
export async function GET(request: Request, context: { params: Promise<Record<string, string>> }) {
  return route(async (req) => {
    const params = await context.params;
    const { project } = await requireScopedProject(req, getParam(params, "idOrSlug"));
    const name = getParam(params, "name");
    const symbol = await findSymbol(project.id, name);
    if (!symbol) return json({ symbol: name, dependencies: null });
    const deps = await findDependencies(project.id, name);
    return json({ symbol: name, definition: symbol, dependencies: deps });
  })(request, {});
}