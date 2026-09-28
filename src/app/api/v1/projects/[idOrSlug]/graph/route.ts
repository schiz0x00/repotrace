import { z } from "zod";
import { route, json, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { dependencyGraph } from "@/lib/search/structural";

export const runtime = "nodejs";

/**
 * GET /api/v1/projects/:idOrSlug/graph?root=<symbol>&depth=&limit=
 *
 * Call/import/extends graph around a symbol. Answers "what does this touch",
 * which neither the per-symbol dependency list nor search can: those answer
 * for one symbol at a time, in isolation.
 */
export async function GET(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const { searchParams } = new URL(req.url);

    const schema = z.object({
      root: z.string().min(1).max(500),
      depth: z.coerce.number().int().min(1).max(4).default(2),
      limit: z.coerce.number().int().min(1).max(1000).default(200),
    });
    const parsed = schema.parse({
      root: searchParams.get("root") ?? undefined,
      depth: searchParams.get("depth") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });

    const graph = await dependencyGraph(project.id, parsed.root, {
      depth: parsed.depth,
      limit: parsed.limit,
    });

    return json({
      graph,
      // A null root means the symbol is not in the index; say so rather than
      // returning an empty graph that reads like "it has no dependencies".
      found: graph.root !== null,
      // Mirrored at the top level beside `found` for the same reason: a caller
      // that only reads the flags should not have to walk into `graph` to
      // discover that the walk stopped early. `truncation` names which bound
      // was hit, because the levers differ:
      //
      // - nodes: raise `limit`. The schema caps it at 1000, and so does the
      //   walk itself, so that is the ceiling.
      // - edges: the budget is `min(MAX_GRAPH_EDGES, max(64, limit * 4))`, so
      //   raising `limit` is the lever only while `limit` is below 500. From
      //   500 up the budget is pinned at MAX_GRAPH_EDGES (2000) and no value of
      //   `limit` this route accepts can raise it — the only remaining lever is
      //   a smaller `depth`, which spends less of the budget.
      //
      // Dropping edges without saying so was the original defect, so a
      // truncated graph is never returned silently.
      truncated: graph.truncated,
      truncation: graph.truncation,
    });
  })(request, {});
}
