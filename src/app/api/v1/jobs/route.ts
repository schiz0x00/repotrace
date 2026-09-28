import { z } from "zod";
import { route, json } from "@/lib/http";
import { requirePrincipal } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";
import { notFound } from "@/lib/errors";
import { JobStatus, JobType } from "@/generated/prisma/enums";

export const runtime = "nodejs";

/** GET /api/v1/jobs?project=&status=&type=&limit=&offset= */
export async function GET(request: Request) {
  return route(async (req) => {
    const principal = await requirePrincipal(req);
    const { searchParams } = new URL(req.url);
    // status/type are native Postgres enums. They were validated as free
    // strings and cast with `as never`, so `?status=bogus` reached the driver
    // and came back as a 500 — a client typo reported as a server fault.
    const schema = z.object({
      project: z.string().optional(),
      status: z.enum(Object.values(JobStatus) as [string, ...string[]]).optional(),
      type: z.enum(Object.values(JobType) as [string, ...string[]]).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    });
    const parsed = schema.parse({
      project: searchParams.get("project") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      type: searchParams.get("type") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
      offset: searchParams.get("offset") ?? undefined,
    });
    const projectScope =
      principal.type === "api_key" && principal.projectId
        ? principal.projectId
        : parsed.project
          ? await resolveProjectId(parsed.project)
          : undefined;
    const where = {
      ...(projectScope ? { projectId: projectScope } : {}),
      ...(parsed.status ? { status: parsed.status as JobStatus } : {}),
      ...(parsed.type ? { type: parsed.type as JobType } : {}),
    };
    const [jobs, total] = await Promise.all([
      prisma().job.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: parsed.limit,
        skip: parsed.offset,
        include: { project: { select: { slug: true, name: true } } },
      }),
      prisma().job.count({ where }),
    ]);
    return json({ jobs, total, limit: parsed.limit, offset: parsed.offset });
  })(request, {});
}

/**
 * Resolves a `project` query value that may be either a slug or an id.
 *
 * Callers (notably the dashboard) pass slugs, but the filter is on
 * `projectId`, a cuid — passing a slug straight through matched nothing and
 * left every project-scoped job list permanently empty.
 */
async function resolveProjectId(idOrSlug: string): Promise<string> {
  const project = await prisma().project.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    select: { id: true },
  });
  if (!project) throw notFound("project_not_found", `Project ${idOrSlug} not found`);
  return project.id;
}