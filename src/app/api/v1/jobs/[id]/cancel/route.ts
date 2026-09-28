import { route, json } from "@/lib/http";
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
    if (job.status !== "queued" && job.status !== "running") {
      // Already finished. Reporting "cancelled" here claimed an outcome that
      // did not happen, and the dashboard would show a completed job as
      // cancelled.
      return json({ jobId: job.id, status: job.status, cancelled: false });
    }

    if (job.status === "queued") {
      // A queued job has not been picked up yet, so there is nothing to
      // cooperate with: remove it from the queue as well as marking the row.
      // Without this the worker picked it up moments later and overwrote the
      // status back to "running", indexing the project the operator had just
      // cancelled.
      const { jobQueue } = await import("@/lib/jobs/queue");
      const bullJob = await jobQueue().getJob(job.id).catch(() => null);
      // remove() fails on an active job, which is fine: the status flip below
      // plus the worker's own pre-flight check is what stops a running one.
      await bullJob?.remove().catch(() => {});
    }

    await prisma().job.update({
      where: { id: job.id },
      data: { status: "cancelled", completedAt: new Date() },
    });
    // A running worker observes the marker and aborts cooperatively.
    return json({ jobId: job.id, status: "cancelled", cancelled: true });
  })(request, {});
}