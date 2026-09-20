import { route, json, getParam } from "@/lib/http";
import { requirePrincipal } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";
import { canAccessProject } from "@/lib/authn";
import { notFound } from "@/lib/errors";

export const runtime = "nodejs";

async function loadJob(request: Request, id: string) {
  const principal = await requirePrincipal(request);
  const job = await prisma().job.findUnique({
    where: { id },
    include: { project: { select: { slug: true, name: true } } },
  });
  if (!job) throw notFound("job_not_found", "Job not found");
  if (job.projectId && !canAccessProject(principal, job.projectId)) {
    throw notFound("job_not_found", "Job not found");
  }
  return job;
}

/** GET /api/v1/jobs/:id */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return route(async (req) => {
    const { id } = await context.params;
    const job = await loadJob(req, getParam({ id }, "id"));
    return json({ job });
  })(request, {});
}

