import { z } from "zod";
import { route, json } from "@/lib/http";
import { requirePrincipal } from "@/lib/api/guard";
import { CHUNK_TYPE_VALUES, searchProject } from "@/lib/search/search";
import type { ChunkType } from "@/generated/prisma/enums";
import { canAccessProject } from "@/lib/authn";
import { prisma } from "@/lib/prisma";
import { notFound } from "@/lib/errors";

export const runtime = "nodejs";

/**
 * Parses `chunkTypes`, rejecting anything that is not a chunk type.
 *
 * The parameter used to be split and filtered against the known values, with
 * the rejects dropped: `chunkTypes=cdoe` filtered nothing, so the search ran
 * unfiltered, returned results from every chunk type, and reported 200. A
 * caller asking for documentation got code and could not tell the difference —
 * the "correct-looking wrong output" failure. An unknown value is a 400 naming
 * the valid set, raised through the same Zod path as every other bad query
 * parameter so it is reported as `validation_failed` like its neighbours.
 *
 * Blank segments (`code,,test`) are ignored, and a parameter that is empty or
 * all blanks means "no filter" — it filters nothing because nothing was asked
 * for, not because an argument was rejected. Identical to the parser in
 * `projects/[idOrSlug]/search`, which it must stay in step with; the two files
 * are the only entry points that accept this parameter over HTTP.
 */
function parseChunkTypes(value: string | undefined, ctx: z.RefinementCtx): ChunkType[] | undefined {
  if (value === undefined) return undefined;
  const requested = value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (requested.length === 0) return undefined;
  const unknown = requested.filter((t) => !CHUNK_TYPE_VALUES.includes(t as ChunkType));
  if (unknown.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["chunkTypes"],
      message: `Unknown chunk type(s): ${unknown.join(", ")}. Valid values: ${CHUNK_TYPE_VALUES.join(", ")}`,
    });
    return undefined;
  }
  return [...new Set(requested)] as ChunkType[];
}

/** GET /api/v1/search?project=<slug|id>&q=...&mode=&limit= */
export async function GET(request: Request) {
  return route(async (req) => {
    const principal = await requirePrincipal(req);
    const { searchParams } = new URL(req.url);
    const projectArg = searchParams.get("project");
    if (!projectArg) {
      return json({ error: { code: "project_required", message: "`project` query parameter is required" } }, 400);
    }
    const project = await prisma().project.findFirst({
      where: { OR: [{ id: projectArg }, { slug: projectArg }] },
      select: { id: true },
    });
    if (!project) throw notFound("project_not_found", "Project not found");
    if (!canAccessProject(principal, project.id)) {
      return json({ error: { code: "project_forbidden", message: "This credential cannot access the project" } }, 403);
    }

    const q = searchParams.get("q") ?? "";
    if (!q.trim()) return json({ items: [], sources: { vector: 0, lexical: 0, symbol: 0 }, tookMs: 0 });

    const schema = z.object({
      mode: z.enum(["hybrid", "lexical", "semantic", "symbol"]).default("hybrid"),
      limit: z.coerce.number().int().min(1).max(50).default(10),
      chunkTypes: z.string().optional().transform((v, ctx) => parseChunkTypes(v, ctx)),
      languages: z.string().optional().transform((v) => (v ? v.split(",").filter(Boolean) : undefined)),
    });
    const parsed = schema.parse({
      mode: searchParams.get("mode") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
      chunkTypes: searchParams.get("chunkTypes") ?? undefined,
      languages: searchParams.get("languages") ?? undefined,
    });

    const result = await searchProject(project.id, q, {
      mode: parsed.mode,
      limit: parsed.limit,
      chunkTypes: parsed.chunkTypes,
      languages: parsed.languages,
    });
    return json(result);
  })(request, {});
}