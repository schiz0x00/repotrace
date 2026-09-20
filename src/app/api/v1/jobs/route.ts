import { z } from "zod";
import { route, json } from "@/lib/http";
import { requirePrincipal } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/** GET /api/v1/jobs?project=&status=&limit= */
export async function GET(request: Request) {
  return route(async (req) => {
    const principal = await requirePrincipal(req);
    const { searchParams } = new URL(req.url);
    const schema = z.object({
      project: z.string().optional(),
      status: z.string().optional(),
      type: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    });
    const parsed = schema.parse({
      project: searchParams.get("project") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      type: searchParams.get("type") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });
    const projectScope =
      principal.type === "api_key" && principal.projectId
        ? principal.projectId
        : parsed.project
          ? parsed.project
          : undefined;
    const where = {
      ...(projectScope ? { projectId: projectScope } : {}),
      ...(parsed.status ? { status: parsed.status as never } : {}),
      ...(parsed.type ? { type: parsed.type as never } : {}),
    };
    const [jobs, total] = await Promise.all([
      prisma().job.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: parsed.limit,
        include: { project: { select: { slug: true, name: true } } },
      }),
      prisma().job.count({ where }),
    ]);
    return json({ jobs, total });
  })(request, {});
}