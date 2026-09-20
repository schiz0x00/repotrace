import { z } from "zod";
import { route, json, getParam } from "@/lib/http";
import { requirePrincipal, requireScopedProject } from "@/lib/api/guard";
import { searchProject } from "@/lib/search/search";
import type { ChunkType } from "@/generated/prisma/enums";

export const runtime = "nodejs";

const CHUNK_TYPES = ["code", "test", "documentation", "configuration"] as const;

/**
 * GET /api/v1/projects/:idOrSlug/search?q=...&mode=hybrid|lexical|semantic|symbol&limit=&chunkTypes=&languages=
 */
export async function GET(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q") ?? "";
    if (!q.trim()) return json({ items: [], sources: { vector: 0, lexical: 0, symbol: 0 }, tookMs: 0 });

    const schema = z.object({
      mode: z.enum(["hybrid", "lexical", "semantic", "symbol"]).default("hybrid"),
      limit: z.coerce.number().int().min(1).max(50).default(10),
      chunkTypes: z
        .string()
        .optional()
        .transform((v) =>
          v
            ? (v.split(",").filter((t) => CHUNK_TYPES.includes(t as (typeof CHUNK_TYPES)[number])) as ChunkType[])
            : undefined,
        ),
      languages: z.string().optional().transform((v) => (v ? v.split(",").filter(Boolean) : undefined)),
    });
    const parsed = schema.parse({
      mode: searchParams.get("mode"),
      limit: searchParams.get("limit"),
      chunkTypes: searchParams.get("chunkTypes"),
      languages: searchParams.get("languages"),
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

/** POST /api/v1/projects/:idOrSlug/search/context — curated context bundle */
export async function context(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const body = await req.json().catch(() => ({}));
    const schema = z.object({
      query: z.string().min(1).max(2000),
      limit: z.number().int().min(1).max(12).default(8),
    });
    const { query, limit } = schema.parse(body);
    const { buildContextBundle } = await import("@/lib/search/context");
    const bundle = await buildContextBundle(project.id, query, { limit });
    return json(bundle);
  })(request, {});
}