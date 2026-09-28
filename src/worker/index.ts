import "dotenv/config";
import { Worker, type Job, type Processor } from "bullmq";
import { env } from "@/lib/env";
import { prisma, disconnectPrisma } from "@/lib/prisma";
import {
  redisConnection,
  reapOrphanedJobs,
  enqueueJob,
  enqueueScheduledSyncs,
  pruneJobs,
  removeQueueJobs,
  jobQueue,
  QUEUE_NAME,
  SYNC_SWEEP_INTERVAL_MS,
} from "@/lib/jobs/queue";
import { runIndexJob, syncRepository, CancelledError } from "@/lib/indexing/pipeline";
import { deleteProjectVectors } from "@/lib/qdrant";
import { removeWorkspace } from "@/lib/git/workspace";
import { currentHead } from "@/lib/git/git";
import { pruneMetrics, recordMetric } from "@/lib/metrics";
import { preloadGrammars } from "@/lib/indexing/parser";
import type { JobStatus, JobType } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Worker process — runs long operations (indexing, sync, delete) outside the
 * web process. Jobs are idempotent (content-hash based), retryable, and
 * cancellable.
 *
 * Capacity: `WORKER_CONCURRENCY` is how many jobs ONE PROCESS runs at a time,
 * and one process is the only configuration this workload supports. Running a
 * second worker process does *not* simply add throughput: the per-project lock
 * below is an in-process `Set`, so two processes can hold jobs for the same
 * project simultaneously and race on the shared git workspace, and the
 * per-process housekeeping below (the orphan reaper, the retention prune, the
 * scheduled-sync sweep) would run once per process against the same rows. The
 * shipped deployment matches: one `worker` service in `docker-compose.yml`, no
 * replicas. Scaling out needs a distributed lock — Redis `SET NX` or a Postgres
 * advisory lock — in `withProjectLock` first, not a second replica.
 *
 * The BullMQ-level re-delivery that a restart *does* trigger is separate, and
 * is covered by `reapOrphanedJobs`: see its docstring for the stall case.
 */

interface JobData {
  jobId: string;
  projectId: string | null;
  type: JobType;
}

/**
 * Docker's stop timeout — how long a container gets between SIGTERM and
 * SIGKILL — when the deployment does not override it. The `worker` service in
 * docker-compose.yml sets no `stop_grace_period`, so this is 10s, and it is
 * also what Kubernetes calls `terminationGracePeriodSeconds`.
 */
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
export { DEFAULT_STOP_TIMEOUT_MS };

/**
 * How long in-flight jobs get to finish after SIGTERM before the worker stops
 * waiting.
 *
 * This has to be *shorter* than the stop timeout, not longer. `docker stop`
 * sends SIGKILL at the timeout regardless of what the process is doing, so a
 * grace period longer than the stop timeout means the bounded drain below
 * never finishes: the process dies holding its Postgres transaction, and the
 * "put the abandoned rows back to queued" write — the whole point of bounding
 * the drain — is lost with it. The 3s of headroom is for that path to finish:
 * one `getJobs("active")` round trip, one bounded `updateMany`, and the pool
 * disconnect.
 *
 * The alternative lever is `stop_grace_period` on the compose service — raise
 * the container's stop timeout to fit the drain instead of shortening the
 * drain. 7s is the value that is correct for the compose deployment as it
 * stands today, where `stop_grace_period` is left at the Docker default of 10s.
 */
const SHUTDOWN_GRACE_MS = 7_000;
export { SHUTDOWN_GRACE_MS };

async function markJob(
  jobId: string,
  data: { status?: JobStatus; progress?: number; stage?: string; error?: string | null },
): Promise<void> {
  try {
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
  } catch (err) {
    // A delete_project job removes its own row (the project cascades away), so
    // a "record not found" here is expected rather than a failure. Anything
    // else is rethrown so a real database problem is not silently swallowed.
    if (isRecordNotFound(err)) return;
    throw err;
  }
}

function isRecordNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2025"
  );
}

/**
 * Per-project in-process lock.
 *
 * Job dedupe keys on (project, type), so a `full_reindex` and an
 * `incremental_index` for the same project can both be active at once. They
 * share one git workspace and write the same File/Chunk/Symbol rows, and two
 * concurrent `git fetch`/`git checkout` runs in one directory corrupt it.
 * Serialising per project keeps WORKER_CONCURRENCY useful across *different*
 * projects while removing the collision within one.
 *
 * This guards a single worker process. Running several workers per host would
 * need a distributed lock; the default deployment runs one.
 */
const activeProjects = new Set<string>();

async function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  while (activeProjects.has(projectId)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  activeProjects.add(projectId);
  try {
    return await fn();
  } finally {
    activeProjects.delete(projectId);
  }
}

/**
 * Whether this job's row has been marked `cancelled`.
 *
 * Every handler that does non-trivial work polls this, and it is also the
 * second half of the cancellation contract: `POST /api/v1/jobs/:id/cancel`
 * answers `cancelled: true` for *any* job type, so a handler that never polls
 * would let the worker write `completed` over the operator's `cancelled` a
 * moment later. Polling is what makes the promise true for the handlers that
 * can stop mid-flight; the terminal write in the processor is what makes it
 * true for the ones that cannot.
 *
 * The AbortSignal is BullMQ's, raised when the job's lock is lost or the worker
 * is closing — not a cancellation from the operator, but there is no reason to
 * keep going after it either.
 */
export function makeCancellationProbe(
  jobId: string,
  signal?: AbortSignal,
): () => Promise<boolean> {
  return async () => {
    if (signal?.aborted) return true;
    const row = await prisma()
      .job.findUnique({ where: { id: jobId }, select: { status: true } })
      .catch(() => null);
    return row?.status === "cancelled";
  };
}

/** Throws `CancelledError` when the row has been marked `cancelled`. */
async function assertNotCancelled(isCancelled: () => Promise<boolean>): Promise<void> {
  if (await isCancelled()) throw new CancelledError();
}

/**
 * The status a run's row ends on, given what the row says right now.
 *
 * A cancel that lands in the window between the handler's last poll and the
 * terminal write is still a cancel: the endpoint reported success, and
 * overwriting it with `completed` would show the operator a finished job for
 * work they stopped. Exported for the test that pins it; the processor is the
 * only caller.
 */
export function terminalStatusAfterRun(currentRowStatus: string | null | undefined): JobStatus {
  return currentRowStatus === "cancelled" ? "cancelled" : "completed";
}

const handlers: Record<JobType, Processor<JobData, unknown>> = {
  initial_index: (job, _token, signal) => run(job, "initial", signal),
  incremental_index: (job, _token, signal) => run(job, "incremental", signal),
  full_reindex: (job, _token, signal) => run(job, "full", signal),
  reembed: (job, _token, signal) => run(job, "reembed", signal),
  repository_sync: async (job, _token, signal) => {
    if (!job.data.projectId) throw new Error("repository_sync requires a project");
    // This handler used to pass `() => Promise.resolve(false)` as
    // `syncRepository`'s cancellation probe: it told the pipeline a cancel had
    // never been requested, so a cancel issued mid-fetch was dropped on the
    // floor, the endpoint answered `cancelled: true`, and the fetch — plus the
    // follow-up index it enqueues — ran to completion anyway. The dashboard
    // then showed a cancelled sync that had in fact rewritten HEAD.
    const isCancelled = makeCancellationProbe(job.data.jobId, signal);
    await assertNotCancelled(isCancelled);
    const db = prisma();
    const project = await db.project.findUnique({
      where: { id: job.data.projectId },
      include: { repository: true },
    });
    if (!project?.repository) throw new Error("Project has no repository");
    // `lastKnownCommit` is what the *indexer* last saw, not where the branch
    // points — that is what makes it usable as the "has anything changed?"
    // baseline for a sync that fetches without indexing.
    const indexedHead = project.repository.lastKnownCommit;
    const workspace = await syncRepository(
      project.id,
      project.repository.url,
      project.repository.branch,
      project.repository.provider,
      project.repository.credentialsEncrypted,
      isCancelled,
    );
    // The probe inside `syncRepository` only fires after a fetch; a first-time
    // clone never reaches it, and a cancel that landed during the clone would
    // otherwise be lost. Nothing below this line is reversible, so this is the
    // last safe point to stop.
    await assertNotCancelled(isCancelled);
    const head = await currentHead(workspace);
    await db.repository.update({
      where: { id: project.repository.id },
      data: { syncStatus: "synced", syncError: null, lastSuccessfulSync: new Date() },
    });
    // A sync that moves HEAD without reindexing leaves the project describing
    // code it no longer has, and nothing else notices: the next scheduled sweep
    // sees the same head, does no work, and the drift is permanent. The
    // follow-up index is what makes the sweep actually refresh anything.
    //
    // A failure here is deliberately not swallowed. `enqueueJob` throws when
    // Redis is unreachable, and the retry re-runs this handler: the fetch is
    // idempotent and `indexedHead` is still the pre-index value, so the retry
    // re-attempts the enqueue instead of silently skipping it.
    //
    // Cancelling here means the fetch stands (the repository row above already
    // records it) but no new index is started. That is deliberate: the fetch
    // genuinely happened, and the drift self-heals — `lastSuccessfulSync` has
    // advanced, so the next scheduled sweep skips the project for
    // SYNC_MIN_AGE_MS, and the sweep after that re-reads the same head against
    // the unchanged `lastKnownCommit` and enqueues the index then.
    await assertNotCancelled(isCancelled);
    if (head !== indexedHead) {
      await enqueueJob(project.id, "incremental_index", {
        dedupe: true,
        metadata: { trigger: "sync", from: indexedHead, to: head },
      });
    }
    return { synced: true, head, reindexed: head !== indexedHead };
  },
  delete_project: async (job, _token, signal) => {
    if (!job.data.projectId) throw new Error("delete_project requires a project");
    const projectId = job.data.projectId;
    // Checked once, before the first irreversible step, and only once. The
    // steps below are not a transaction that can be abandoned half-way: vectors
    // are deleted, the workspace is removed, then the rows go. Polling again
    // after the Qdrant delete would report a cancel that could only be honoured
    // by finishing the delete anyway, so the honest contract is that a cancel
    // is honoured if it arrives before the handler starts and is otherwise
    // reported as a job that already ran. `completedAt` on the row is not a
    // reliable signal here in any case — this handler deletes its own row.
    const isCancelled = makeCancellationProbe(job.data.jobId, signal);
    await assertNotCancelled(isCancelled);
    await deleteProjectVectors(projectId);
    await removeWorkspace(projectId);
    const db = prisma();
    // Collected before the rows are deleted: they are the only remaining link
    // to the BullMQ entries still sitting in Redis for this project.
    const siblings = await db.job.findMany({
      where: { projectId, id: { not: job.data.jobId } },
      select: { id: true },
    });
    // Delete the project's other job rows. This job's own row goes with the
    // project via the FK cascade, which is why markJob tolerates a missing row.
    await db.$transaction([
      db.job.deleteMany({ where: { projectId } }),
      db.apiKey.deleteMany({ where: { projectId } }),
      db.evalQuestion.deleteMany({ where: { projectId } }),
    ]);
    // FKs cascade the rest (files, chunks, symbols, commits, repository).
    await db.project.delete({ where: { id: projectId } });
    // Redis outlives the database. A queued `incremental_index` or a delayed
    // sync for this project survives the delete and is still handed to a
    // worker, which then indexes a project that no longer exists and burns
    // every retry on a foreign key violation.
    await removeQueueJobs(siblings.map((s) => s.id));
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
      // Fire-and-forget, but never unhandled: an unhandled rejection here
      // terminates the worker process mid-index.
      void job.updateProgress(pct).catch(() => {});
      void markJob(job.data.jobId, { progress: pct, stage }).catch(() => {});
    },
    isCancelled: makeCancellationProbe(job.data.jobId, signal),
  });
}

/** The counts an operator needs from a finished job, or null for non-index jobs. */
function summarizeResult(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const numeric = [
    "filesProcessed",
    "filesSkipped",
    "filesFailed",
    "chunksProcessed",
    "embeddingsGenerated",
    "vectorsWritten",
    "filesDeleted",
  ] as const;
  if (!numeric.some((k) => typeof r[k] === "number")) return null;
  const out: Record<string, unknown> = {};
  for (const k of numeric) if (typeof r[k] === "number") out[k] = r[k];
  // The per-file failures are the actionable part; cap the list so a wholly
  // broken repository cannot write an unbounded blob into the job row.
  if (Array.isArray(r.failedFiles)) {
    out.failedFiles = (r.failedFiles as Array<{ path: string; error: string }>)
      .slice(0, 50)
      .map((f) => ({ path: f.path, error: String(f.error).slice(0, 500) }));
  }
  return out;
}

/** Reads a job's existing metadata so a summary can be merged into it. */
async function existingMetadata(jobId: string): Promise<Record<string, unknown>> {
  const row = await prisma()
    .job.findUnique({ where: { id: jobId }, select: { metadata: true } })
    .catch(() => null);
  const meta = row?.metadata;
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : {};
}

export function startWorker(): Worker<JobData> {
  const worker = new Worker<JobData>(
    QUEUE_NAME,
    async (job, _token, signal) => {
      // Cancellation of a *queued* job used to be a no-op in practice: the
      // worker picked the job up moments later and immediately overwrote the
      // cancelled status with "running", so the cancel silently reverted and
      // the full index ran anyway. Re-read the row before starting work and
      // bail out if it was cancelled in the meantime.
      const preflight = await prisma()
        .job.findUnique({ where: { id: job.data.jobId }, select: { status: true } })
        .catch(() => null);
      if (preflight?.status === "cancelled") {
        console.log(
          `[worker] job ${job.data.jobId} (${job.data.type}) was cancelled before it started; not running it`,
        );
        return { cancelled: true };
      }
      await markJob(job.data.jobId, { status: "running", progress: 0, stage: "starting", error: null });
      try {
        const handler = handlers[job.data.type];
        if (!handler) throw new Error(`No handler for job type ${job.data.type}`);
        const result = job.data.projectId
          ? await withProjectLock(job.data.projectId, () => handler(job, undefined, signal))
          : await handler(job, undefined, signal);
        // Persist what the job actually did. `IndexResult` carries the counts an
        // operator needs to answer "why did that file fail" and "did the
        // reindex really touch everything" — and it was computed in full and
        // then thrown away, so the job row could only ever say "completed".
        // Stored in the existing `metadata` column, so no migration is needed.
        const summary = summarizeResult(result);
        if (summary) {
          await prisma()
            .job.update({
              where: { id: job.data.jobId },
              data: { metadata: { ...(await existingMetadata(job.data.jobId)), ...summary } as Prisma.InputJsonObject },
            })
            .catch(() => {
              // Telemetry must never fail a job that already succeeded.
            });
        }
        // Re-read before the terminal write. A cancel that arrives after the
        // handler's last poll is still a cancel the operator was told about, and
        // writing `completed` over their `cancelled` is exactly the
        // silent-reversion this used to do for every job type whose handler
        // never polled. Handlers that cannot stop mid-flight — `delete_project`
        // — are covered by this alone, and handlers added later are covered by
        // it too.
        const settled = await prisma()
          .job.findUnique({ where: { id: job.data.jobId }, select: { status: true } })
          .catch(() => null);
        const terminal = terminalStatusAfterRun(settled?.status);
        if (terminal === "cancelled") {
          // Leave the row exactly as the cancel endpoint wrote it — no
          // `progress: 100`, no cleared error. There is nothing to record.
          console.log(
            `[worker] job ${job.data.jobId} (${job.data.type}) was cancelled while it was finishing; recording it as cancelled rather than completed`,
          );
          return { cancelled: true };
        }
        await markJob(job.data.jobId, { status: "completed", progress: 100, stage: "completed", error: null });
        // `indexing_duration_ms` is recorded by the pipeline, which measures the
        // indexing itself. Recording it here as well — where it also covered the
        // wait for the per-project lock and the queue delay — meant every
        // successful job wrote two samples, and the dashboard average was pulled
        // towards short runs. One job, one sample.
        return result;
      } catch (err) {
        if (err instanceof CancelledError) {
          await markJob(job.data.jobId, { status: "cancelled", error: null });
          return { cancelled: true };
        }
        const message = (err as Error).message.slice(0, 4000);
        await recordMetric("job_failures", 1, job.data.projectId ?? undefined);
        // Final attempt: mark failed. On an earlier attempt the row is left
        // `running` with `stage: "retrying"` and the last error — BullMQ still
        // owns the job and will redeliver it, and the reaper only touches rows
        // whose BullMQ entry can no longer be delivered, so neither `failed`
        // nor `queued` would describe this one while a retry is pending. The
        // dashboard's status badge therefore reads "running" for such a job
        // (its table renders the status, not the stage) and only surfaces the
        // error text once the row is `failed`.
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

  // metric_event is append-only, and so is the job table: both grow without
  // bound on a long-running instance. unref() so the timers never hold the
  // process open.
  const pruneTimer = setInterval(() => {
    void Promise.all([pruneMetrics(), pruneJobs()])
      .then(([metrics, jobs]) => {
        if (metrics || jobs) {
          console.log(`[worker] pruned ${metrics} metric event(s) and ${jobs} job row(s)`);
        }
      })
      .catch((err) => {
        console.error(`[worker] prune failed: ${(err as Error).message}`);
      });
  }, 60 * 60_000);
  pruneTimer.unref();

  // Re-enqueue jobs whose PostgreSQL row says work is still owed while BullMQ
  // has nothing that can deliver it. Without this, one crash between the two
  // writes leaves a row that `dedupe` then returns forever, so that project can
  // never enqueue work again — and a job that stalls out across two worker
  // restarts is failed by BullMQ without the processor ever running, which
  // leaves the same wedge. See `reapOrphanedJobs`.
  const runReaper = () =>
    void reapOrphanedJobs()
      .then((n) => {
        if (n > 0) console.log(`[worker] re-enqueued ${n} orphaned job(s)`);
      })
      .catch((err) => {
        console.error(`[worker] orphan reaper failed: ${(err as Error).message}`);
      });
  const reapTimer = setInterval(runReaper, 5 * 60_000);
  reapTimer.unref();
  // Sweep once at start instead of idling for five minutes first. What that
  // buys is narrow, and worth stating precisely: `reapOrphanedJobs` only looks
  // at rows older than its 15-minute floor, so an orphan left by the crash that
  // prompted this restart is still younger than the floor and is *not* seen
  // here — it waits for a later sweep either way. This run picks up orphans
  // that are already past the floor (an earlier crash, a job this process
  // inherits as `failed` in Redis, or a retry whose `bullJob.retry()` failed),
  // at most the 50 oldest rows in `queued` or `running`, and re-enqueues them
  // now rather than up to five minutes from now.
  runReaper();

  // Scheduled repository sync. Nothing else enqueues a sync on a timer: a
  // webhook is the only trigger, and only GitHub projects can have one, so
  // every other provider sat at its creation commit forever.
  const syncTimer = setInterval(() => {
    void enqueueScheduledSyncs()
      .then((n) => {
        if (n > 0) console.log(`[worker] scheduled ${n} repository sync(s)`);
      })
      .catch((err) => {
        console.error(`[worker] sync sweep failed: ${(err as Error).message}`);
      });
  }, SYNC_SWEEP_INTERVAL_MS);
  syncTimer.unref();

  worker.on("closed", () => {
    clearInterval(pruneTimer);
    clearInterval(reapTimer);
    clearInterval(syncTimer);
  });

  return worker;
}

/** Whether the worker finished its in-flight jobs before the deadline. */
export type DrainOutcome = "drained" | "abandoned";

/**
 * Bounded drain: wait up to `graceMs` for `worker.close()`, and if the deadline
 * wins, put the rows of the jobs that are still active back to `queued` before
 * returning.
 *
 * `worker.close()` on its own waits for in-flight jobs indefinitely, so a long
 * index is *always* still running when the container stop timeout expires and
 * the process is SIGKILLed partway through a write. Racing it against a timer
 * means the process exits on its own terms and the work it drops is recorded
 * rather than silent.
 *
 * Extracted from the SIGTERM handler so it can be driven by a test: the handler
 * itself is only installed when this module is the process entrypoint, which is
 * never true under vitest.
 */
export async function drainWorker(
  worker: Pick<Worker<JobData>, "close">,
  graceMs: number = SHUTDOWN_GRACE_MS,
): Promise<DrainOutcome> {
  let drained = false;
  const closing = worker.close().then(
    () => {
      drained = true;
    },
    () => {
      drained = true;
    },
  );
  let deadline: NodeJS.Timeout | null = null;
  await Promise.race([
    closing,
    new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, graceMs);
      deadline.unref();
    }),
  ]);
  if (deadline) clearTimeout(deadline);

  if (drained) {
    console.log("[worker] drained cleanly");
    return "drained";
  }

  // Name what is being dropped. Silence here is what made a killed worker look
  // like a clean deploy: nothing in the logs said a half-indexed project had
  // just been abandoned.
  const active = await jobQueue()
    .getJobs(["active"])
    .catch(() => [] as Job[]);
  const ids = active.map((j) => String(j.id));
  for (const j of active) {
    console.warn(
      `[worker] abandoning in-flight job ${j.id} (${j.name}, project ${j.data.projectId ?? "none"})`,
    );
  }
  // Put the rows back to `queued`. A row left `running` past the reaper's
  // floor is a wedge, and `dedupe` hands its id back to every later enqueue for
  // that (project, type) — the state `reapOrphanedJobs` exists to repair, and
  // the reason this write is worth the 3s of headroom. Guarded on `running` so
  // a job that finished in the meantime is left alone.
  //
  // This is a belt to the reaper's braces, not a replacement: the drain only
  // runs on a clean SIGTERM, and a container that is SIGKILLed at the stop
  // timeout never reaches it. The reaper is what covers that, and what covers
  // the job BullMQ fails on its own for stalling.
  if (ids.length > 0) {
    await prisma()
      .job.updateMany({
        where: { id: { in: ids }, status: "running" },
        data: { status: "queued", stage: "requeued after shutdown", error: null },
      })
      .catch((err) => {
        console.error(`[worker] could not requeue abandoned jobs: ${(err as Error).message}`);
      });
  }
  return "abandoned";
}

if (process.argv[1] && process.argv[1].endsWith("worker/index.ts")) {
  void preloadGrammars().then(() => {
    const worker = startWorker();
    const count = env().WORKER_CONCURRENCY;
    console.log(`[worker] started with concurrency ${count}, waiting for jobs...`);
    if (SHUTDOWN_GRACE_MS >= DEFAULT_STOP_TIMEOUT_MS) {
      // The bounded drain would never finish; SIGKILL would land first, and
      // the abandoned rows would stay `running`.
      console.warn(
        `[worker] shutdown grace ${SHUTDOWN_GRACE_MS}ms is not shorter than the ${DEFAULT_STOP_TIMEOUT_MS}ms stop timeout; ` +
          "in-flight jobs will be SIGKILLed rather than requeued. Set stop_grace_period on the worker service.",
      );
    }
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[worker] shutting down (grace ${SHUTDOWN_GRACE_MS}ms)...`);
      await drainWorker(worker, SHUTDOWN_GRACE_MS);
      // Release the Postgres pool so the process can actually exit instead of
      // being killed with the connection open.
      await disconnectPrisma().catch(() => {});
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}