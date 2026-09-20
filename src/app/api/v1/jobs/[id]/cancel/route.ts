import { route, json, getParam } from "@/lib/http";
import { requirePrincipal } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";
import { canAccessProject } from "@/lib/authn";
import { notFound } from "@/lib/errors";

export const runtime = "nodejs";

/** POST /api/v1/jobs/:id/cancel — cooperative cancellation */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return route(async (req) => {
    const { id } = await context.params;
    const principal = await requirePrincipal(req);
    const job = await prisma().job.findUnique({ where: { id } });
    if (!job || (job.projectId && !canAccessProject(principal, job.projectId))) {
      throw notFound("job_not_found", "Job not found");
    }
    if (job.status === "queued" || job.status === "running") {
      await prisma().job.update({ where: { id: job.id }, data: { status: "cancelled" } });
    }
    // A running worker observes the marker and aborts cooperatively.
    return json({ jobId: job.id, status: "cancelled" });
  })(request, {});
}