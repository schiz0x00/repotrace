import { z } from "zod";
import { route, json, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/** GET /api/v1/projects/:idOrSlug/files?path=&status=&language=&page=&pageSize= */
export async function GET(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const { searchParams } = new URL(req.url);
    const schema = z.object({
      path: z.string().optional(),
      status: z.enum(["indexed", "failed", "removed"]).optional(),
      language: z.string().optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
    });
    const parsed = schema.parse({
      path: searchParams.get("path"),
      status: searchParams.get("status"),
      language: searchParams.get("language"),
      page: searchParams.get("page"),
      pageSize: searchParams.get("pageSize"),
    });
    const where = {
      projectId: project.id,
      ...(parsed.path ? { path: { contains: parsed.path } } : {}),
      ...(parsed.status ? { status: parsed.status } : {}),
      ...(parsed.language ? { language: parsed.language } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma().file.count({ where }),
      prisma().file.findMany({
        where,
        orderBy: { path: "asc" },
        skip: (parsed.page - 1) * parsed.pageSize,
        take: parsed.pageSize,
        select: {
          id: true,
          path: true,
          language: true,
          size: true,
          status: true,
          error: true,
          lastIndexedCommit: true,
          lastIndexedAt: true,
          _count: { select: { chunks: true, symbols: true } },
        },
      }),
    ]);
    return json({ files: rows, total, page: parsed.page, pageSize: parsed.pageSize });
  })(request, {});
}