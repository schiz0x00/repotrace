import { z } from "zod";
import { route, json } from "@/lib/http";
import { requirePrincipal } from "@/lib/api/guard";
import { searchProject } from "@/lib/search/search";
import { canAccessProject } from "@/lib/authn";
import { prisma } from "@/lib/prisma";
import { notFound } from "@/lib/errors";
import type { ChunkType } from "@/generated/prisma/enums";

export const runtime = "nodejs";

const CHUNK_TYPES = ["code", "test", "documentation", "configuration"] as const;

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

/** POST /api/v1/search/context — curated context bundle for a question */
export async function context(request: Request) {
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