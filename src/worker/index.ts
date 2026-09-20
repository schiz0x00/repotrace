import { Worker, type Job, type Processor } from "bullmq";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { redisConnection, QUEUE_NAME } from "@/lib/jobs/queue";
import { runIndexJob, syncRepository, CancelledError } from "@/lib/indexing/pipeline";
import { deleteProjectVectors } from "@/lib/qdrant";
import { removeWorkspace } from "@/lib/git/workspace";
import { recordMetric } from "@/lib/metrics";
import { preloadGrammars } from "@/lib/indexing/parser";
import type { JobStatus, JobType } from "@/generated/prisma/enums";

/**
 * Worker process — runs long operations (indexing, sync, delete) outside the
 * web process. Horizontally scalable: more worker processes = more capacity.
 * Jobs are idempotent (content-hash based), retryable, and cancellable.
 */

interface JobData {
  jobId: string;
  projectId: string | null;
  type: JobType;
}

async function markJob(
  jobId: string,
  data: { status?: JobStatus; progress?: number; stage?: string; error?: string | null },
): Promise<void> {
  await prisma().job.update({
    where: { id: jobId },
    data: {
      ...(data.status ? { status: data.status } : {}),
      ...(data.progress !== undefined ? { progress: data.progress } : {}),
      ...(data.stage ? { stage: data.stage } : {}),
      ...(data.error !== undefined ? { error: data.error } : {}),
      ...(data.status === "running" || data.status === "completed" || data.status === "failed"
        ? {
            startedAt:
              data.status === "running"
                ? new Date()
                : undefined,
            completedAt:
              data.status === "completed" || data.status === "failed"
                ? new Date()
                : undefined,
          }
        : {}),
    },
  });
}

const handlers: Record<JobType, Processor<JobData, unknown>> = {
  initial_index: (job, _token, signal) => run(job, "initial", signal),
  incremental_index: (job, _token, signal) => run(job, "incremental", signal),
  full_reindex: (job, _token, signal) => run(job, "full", signal),
  reembed: (job, _token, signal) => run(job, "reembed", signal),
  repository_sync: async (job) => {
    if (!job.data.projectId) throw new Error("repository_sync requires a project");
    const project = await prisma().project.findUnique({
      where: { id: job.data.projectId },
      include: { repository: true },
    });
    if (!project?.repository) throw new Error("Project has no repository");
    await syncRepository(
      project.id,
      project.repository.url,
      project.repository.branch,
      project.repository.provider,
      project.repository.credentialsEncrypted,
      () => Promise.resolve(false),
    );
    await prisma().repository.update({
      where: { id: project.repository.id },
      data: { syncStatus: "synced", syncError: null, lastSuccessfulSync: new Date() },
    });
    return { synced: true };
  },
  delete_project: async (job) => {
    if (!job.data.projectId) throw new Error("delete_project requires a project");
    const projectId = job.data.projectId;
    await deleteProjectVectors(projectId);
    await removeWorkspace(projectId);
    const db = prisma();
    await db.$transaction([
      db.job.deleteMany({ where: { projectId } }),
      db.apiKey.deleteMany({ where: { projectId } }),
      db.evalQuestion.deleteMany({ where: { projectId } }),
    ]);
    // FKs cascade the rest (files, chunks, symbols, commits, repository).
    await db.project.delete({ where: { id: projectId } });
    return { deleted: true };
  },
};

async function run(
  job: Job<JobData>,
  mode: "initial" | "incremental" | "full" | "reembed",
  signal?: AbortSignal,
) {
  if (!job.data.projectId) throw new Error(`${mode} requires a project`);
  return runIndexJob({
    projectId: job.data.projectId,
    mode,
    onProgress: (pct, stage) => {
      void job.updateProgress(pct);
      void markJob(job.data.jobId, { progress: pct, stage });
    },
    isCancelled: async () => {
      if (signal?.aborted) return true;
      const row = await prisma().job.findUnique({
        where: { id: job.data.jobId },
        select: { status: true },
      });
      return row?.status === "cancelled";
    },
  });
}

export function startWorker(): Worker<JobData> {
  const worker = new Worker<JobData>(
    QUEUE_NAME,
    async (job, _token, signal) => {
      const started = Date.now();
      await markJob(job.data.jobId, { status: "running", progress: 0, stage: "starting", error: null });
      try {
        const handler = handlers[job.data.type];
        if (!handler) throw new Error(`No handler for job type ${job.data.type}`);
        const result = await handler(job, undefined, signal);
        await markJob(job.data.jobId, { status: "completed", progress: 100, stage: "completed", error: null });
        await recordMetric("indexing_duration_ms", Date.now() - started, job.data.projectId ?? undefined);
        return result;
      } catch (err) {
        if (err instanceof CancelledError) {
          await markJob(job.data.jobId, { status: "cancelled", error: null });
          return { cancelled: true };
        }
        const message = (err as Error).message.slice(0, 4000);
        await recordMetric("job_failures", 1, job.data.projectId ?? undefined);
        // Final attempt: mark failed. Earlier attempts stay "failed" too —
        // the retry re-runs the whole job (idempotent via content hashes).
        if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
          await markJob(job.data.jobId, { status: "failed", error: message });
        } else {
          await markJob(job.data.jobId, { stage: "retrying", error: message });
        }
        throw err;
      }
    },
    {
      connection: redisConnection(),
      concurrency: env().WORKER_CONCURRENCY,
      // Expose AbortSignal for cooperative cancellation.
      autorun: true,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[worker] job ${job?.id} (${job?.name}) failed: ${err.message}`);
  });
  worker.on("error", (err) => {
    console.error(`[worker] error: ${err.message}`);
  });
  return worker;
}

if (process.argv[1] && process.argv[1].endsWith("worker/index.ts")) {
  void preloadGrammars().then(() => {
    const worker = startWorker();
  const count = env().WORKER_CONCURRENCY;
  console.log(`[worker] started with concurrency ${count}, waiting for jobs...`);
    const shutdown = async () => {
      console.log("[worker] shutting down...");
      await worker.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}