import type { Queue } from "bullmq";
import { route, json } from "@/lib/http";
import type { JobType } from "@/generated/prisma/enums";
import { requirePrincipal } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";
import { canAccessProject } from "@/lib/authn";
import { notFound, conflict } from "@/lib/errors";

/** Adds a fresh BullMQ job for an existing PostgreSQL job row. */
async function addJob(queue: Queue, job: { id: string; type: JobType; projectId: string | null }) {
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

/** Ioredis error strings can embed the connection URL, which carries the password. */
function redactQueueError(message: string): string {
  return message
    .replace(/(\/\/)[^/\s:@]*:[^/\s@]*@/g, "$1***:***@")
    .replace(/redis:\/\/[^\s"']+/g, "redis://***")
    .slice(0, 300);
}

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

    // Enqueue *before* flipping the row. The reverse order left a window
    // where a failure (Redis down, retry refused) had already written
    // status="queued" with nothing behind it in the queue — and because
    // enqueueJob's dedupe matches on `queued`, every later request for that
    // project and type returned this dead row instead of doing any work. One
    // transient error permanently wedged the project.
    try {
      if (bullJob) {
        // `retry()` only works on a job BullMQ considers *failed*. A job the
        // worker finished — which is what a cancelled job looks like, since
        // cancellation stops the run and the worker records it as done — is in
        // a completed state, and BullMQ refuses. Fall back to replacing it.
        try {
          await bullJob.retry();
        } catch {
          await bullJob.remove().catch(() => {});
          await addJob(queue, job);
        }
      } else {
        await addJob(queue, job);
      }
    } catch (err) {
      // Row untouched, so the job still reads as failed/cancelled and can be
      // retried again. The underlying message is redacted because an ioredis
      // error can embed the connection URL, which carries the password.
      throw conflict(
        "queue_unavailable",
        `Could not re-enqueue the job: ${redactQueueError((err as Error).message)}`,
      );
    }

    await prisma().job.update({
      where: { id: job.id },
      data: { status: "queued", error: null, completedAt: null },
    });
    return json({ jobId: job.id, status: "queued" });
  })(request, {});
}