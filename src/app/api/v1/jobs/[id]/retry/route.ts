import { route, json, getParam } from "@/lib/http";
import { requirePrincipal } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";
import { canAccessProject } from "@/lib/authn";
import { notFound } from "@/lib/errors";

export const runtime = "nodejs";

/** POST /api/v1/jobs/:id/retry — re-enqueue a failed/cancelled job */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return route(async (req) => {
    const { id } = await context.params;
    const principal = await requirePrincipal(req);
    const job = await prisma().job.findUnique({ where: { id } });
    if (!job || (job.projectId && !canAccessProject(principal, job.projectId))) {
      throw notFound("job_not_found", "Job not found");
    }
    if (job.status !== "failed" && job.status !== "cancelled") {
      return json({ jobId: job.id, status: job.status });
    }
    const { jobQueue } = await import("@/lib/jobs/queue");
    const queue = jobQueue();
    const bullJob = await queue.getJob(job.id);
    await prisma().job.update({
      where: { id: job.id },
      data: { status: "queued", error: null },
    });
    if (bullJob) {
      await bullJob.retry();
    } else {
      const { env } = await import("@/lib/env");
      await queue.add(
        job.type,
        { jobId: job.id, projectId: job.projectId, type: job.type },
        {
          jobId: job.id,
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 500 },
          attempts: env().JOB_MAX_ATTEMPTS,
          backoff: { type: "exponential", delay: env().JOB_RETRY_BACKOFF_MS },
        },
      );
    }
    return json({ jobId: job.id, status: "queued" });
  })(request, {});
}