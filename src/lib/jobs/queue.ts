import { Queue } from "bullmq";
import IORedis from "ioredis";
import type { JobStatus, JobType } from "@/generated/prisma/enums";
import { env } from "@/lib/env";
import { conflict } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

/**
 * BullMQ-backed job queue over Redis. The PostgreSQL `job` table remains the
 * source of truth; BullMQ tracks queue mechanics (retries, delays, locks).
 */

export const QUEUE_NAME = "repotrace";

/**
 * How often the worker sweeps for projects that are due a repository sync.
 * Deliberately coarse: the sweep exists to rescue projects that no webhook
 * will ever reach, not to re-index the world.
 */
export const SYNC_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * Minimum age since the last successful sync before a project is swept again.
 * A webhook-driven sync updates `lastSuccessfulSync` too, so without this a
 * project that receives push events would still be re-fetched on every sweep
 * for no reason.
 */
export const SYNC_MIN_AGE_MS = 60 * 60_000;

/** Projects examined per sweep; the remainder rotate in on the next tick. */
const SYNC_SWEEP_PAGE_SIZE = 200;

/**
 * First retry delay for a repository whose syncs keep failing, and the ceiling
 * the delay doubles up to. The base is one sweep interval, so a broken
 * repository is still retried promptly the first time and drifts to roughly
 * weekly if it stays broken.
 */
export const SYNC_RETRY_BASE_MS = SYNC_SWEEP_INTERVAL_MS;
export const SYNC_RETRY_MAX_MS = 7 * 24 * 3600_000;

/** How many recent `repository_sync` rows the failure streak reads. */
export const SYNC_FAILURE_PROBE_LIMIT = 12;

/**
 * Retention for finished job rows. Apart from `delete_project`, which removes
 * the rows of the project it deletes, nothing ever removes a `job` row — so on
 * a busy instance the table becomes the largest one in the database while
 * holding mostly history nobody reads.
 *
 * These are tuning constants for the prune below, not deployment settings, so
 * they are defined next to the code that uses them.
 */
export const JOB_RETENTION_DAYS = 30;
/** Rows deleted per statement. */
const JOB_PRUNE_BATCH_SIZE = 500;
/** Ceiling on rows removed by one invocation. */
const JOB_PRUNE_MAX_ROWS = 20_000;

/**
 * Statuses eligible for retention pruning. `queued` and `running` are never
 * deleted: they are work still owed, not history, and dropping one leaves a
 * BullMQ job that will be handed to a worker with no row to write to.
 */
const PRUNABLE_STATUSES: JobStatus[] = ["completed", "failed", "cancelled"];

let queue: Queue | null = null;
let connection: IORedis | null = null;

export function redisConnection(): IORedis {
  if (connection) return connection;
  connection = new IORedis(env().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });
  return connection;
}

export function jobQueue(): Queue {
  if (queue) return queue;
  queue = new Queue(QUEUE_NAME, { connection: redisConnection() });
  return queue;
}

export interface EnqueueIndexJobOptions {
  /** When true, an already-queued/running job of the same type for the
   * project is reused instead of enqueuing a duplicate. */
  dedupe?: boolean;
  /** Job will be delayed by this many milliseconds (webhook debounce). */
  delayMs?: number;
  metadata?: Record<string, unknown>;
}

/** Adds a job to BullMQ under an existing PostgreSQL job row's id. */
async function addToQueue(
  jobId: string,
  type: JobType,
  projectId: string | null,
  opts: EnqueueIndexJobOptions & { /** Overrides the configured attempt budget. */ attempts?: number } = {},
): Promise<void> {
  await jobQueue().add(type, { jobId, projectId, type }, {
    jobId,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
    attempts: opts.attempts ?? env().JOB_MAX_ATTEMPTS,
    backoff: { type: "exponential", delay: env().JOB_RETRY_BACKOFF_MS },
    delay: opts.delayMs,
  });
}

/**
 * Creates a job row in PostgreSQL and enqueues it. Idempotent per
 * (project, type) when `dedupe` is set — duplicate webhooks and double
 * clicks never stack up identical work.
 */
export async function enqueueJob(
  projectId: string | null,
  type: JobType,
  opts: EnqueueIndexJobOptions = {},
): Promise<string> {
  const db = prisma();
  if (opts.dedupe) {
    const active = await db.job.findFirst({
      where: {
        projectId,
        type,
        status: { in: ["queued", "running"] },
      },
      select: { id: true },
    });
    if (active) return active.id;
  }

  const created = await db.job.create({
    data: {
      projectId,
      type,
      status: "queued",
      metadata: (opts.metadata as object) ?? undefined,
    },
  });

  try {
    await addToQueue(created.id, type, projectId, opts);
  } catch (err) {
    // Redis unavailable: keep the DB row but surface the failure.
    await db.job.update({
      where: { id: created.id },
      data: { status: "failed", error: `Could not enqueue job: ${redactQueueError((err as Error).message)}` },
    });
    throw conflict("queue_unavailable", "Job queue is unavailable; try again shortly");
  }
  return created.id;
}

/** Ioredis error strings can embed the connection URL, which carries the password. */
function redactQueueError(message: string): string {
  return message
    .replace(/(\/\/)[^/\s:@]*:[^/\s@]*@/g, "$1***:***@")
    .replace(/\/\/[^/\s:@]+@/g, "//***@");
}

/**
 * How old a row must be before the orphan reaper will touch it. Long enough
 * that a job legitimately sitting in the queue behind a full concurrency
 * (or sitting `delayed` on a retry backoff) is never mistaken for an orphan.
 */
export const REAP_ORPHAN_FLOOR_MS = 15 * 60_000;

/** Rows examined per sweep, per population; the remainder rotate in later. */
const REAP_PAGE_SIZE = 50;

/**
 * BullMQ states from which a job can still be handed to a worker.
 *
 * This is the distinction the reaper turns on, and it is not "does the entry
 * exist". `getJob(id)` answers that question, and a *failed* entry answers it
 * with "yes, here it is" for as long as `removeOnFail` keeps it — while being
 * a job BullMQ will never deliver again. Treating existence as liveness
 * therefore declared a stalled-out job healthy and skipped it, which is how a
 * job abandoned across two worker restarts stayed unschedulable forever:
 * BullMQ fails a job that stalls more than `maxStalledCount` times (default 1)
 * *without invoking the processor* — it stamps `failedReason` and the worker
 * refuses it on the next delivery — so nothing in this codebase ever gets a
 * chance to write the row, and every sweep after that sees an entry that looks
 * present.
 */
const SCHEDULABLE_BULL_STATES: ReadonlySet<string> = new Set([
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "waiting-children",
]);

/**
 * Whether a job in this BullMQ state can still reach a processor.
 *
 * `null` means the entry is gone from Redis entirely. `unknown`, `failed` and
 * `completed` are all entries that exist and will never run again.
 */
export function isSchedulableBullState(state: string | null | undefined): boolean {
  return typeof state === "string" && SCHEDULABLE_BULL_STATES.has(state);
}

/** One row the reaper is considering, as read from PostgreSQL. */
export interface ReapCandidate {
  status: string;
  createdAt: Date;
  startedAt: Date | null;
}

/**
 * Whether a row has been in its current status for longer than the floor.
 *
 * `since` picks the timestamp that actually measures the status. `createdAt`
 * is right for a `queued` row: nothing has claimed it, so its age is its
 * waiting time. It is wrong for a `running` row, whose job may have been
 * created days ago and started a minute ago — that row needs `startedAt`, and
 * a `running` row with no `startedAt` never started at all, so it falls back
 * to `createdAt` rather than being stranded by a missing timestamp.
 */
export function isPastReapFloor(
  row: ReapCandidate,
  floor: Date,
  since: "createdAt" | "startedAt" = "createdAt",
): boolean {
  const measured = since === "startedAt" ? (row.startedAt ?? row.createdAt) : row.createdAt;
  return measured < floor;
}

/** The columns the sweep needs; `status` and `startedAt` drive the second pass. */
const REAP_SELECT = {
  id: true,
  type: true,
  projectId: true,
  status: true,
  createdAt: true,
  startedAt: true,
} as const;

/**
 * Re-enqueues jobs whose PostgreSQL row says work is still owed while BullMQ
 * has nothing that can deliver it.
 *
 * `enqueueJob` writes the row and then adds to BullMQ. A crash, deploy or OOM
 * between those two steps leaves a row no worker will ever pick up — and
 * because `dedupe` matches on `status IN ('queued','running')`, every later
 * enqueue for that (project, type) returned the dead row's id instead of doing
 * any work. One unlucky crash wedged a project's queue permanently, with no
 * error anywhere: the row looks healthy and the dashboard shows a job that is
 * never going to run.
 *
 * Two populations, swept separately because they need different evidence.
 *
 * `queued` is the case above: a row nobody has claimed. Its age is the whole
 * story, so the status filter and the age floor both live in the query, and
 * the only thing left to establish is that BullMQ cannot deliver it.
 *
 * `running` is a row a worker *did* claim and then died holding. A SIGKILL past
 * the container stop timeout never reaches the bounded drain, so nothing puts
 * it back, and `running` is not in `PRUNABLE_STATUSES` either — the row never
 * ages out, and `dedupe` hands its id to every later enqueue for that
 * (project, type) forever. It cannot be swept on `createdAt` alone: a job
 * created days ago may have started a minute ago and be indexing right now. So
 * the age floor is measured on `startedAt` and applied in application code,
 * because the only index the schema declares for this is
 * `@@index([status, createdAt])` and it leads with neither.
 *
 * Both passes then turn on the same BullMQ question, and on `getState()` rather
 * than on existence — see `isSchedulableBullState`. When there is an entry that
 * can no longer be delivered it is removed before the re-add, because
 * `queue.add` short-circuits on an id that already exists and would otherwise
 * report success while doing nothing.
 */
export async function reapOrphanedJobs(maxAgeMs = REAP_ORPHAN_FLOOR_MS): Promise<number> {
  const db = prisma();
  const floor = new Date(Date.now() - maxAgeMs);

  const queued = await db.job.findMany({
    where: { status: "queued", createdAt: { lt: floor } },
    select: REAP_SELECT,
    orderBy: { createdAt: "asc" },
    take: REAP_PAGE_SIZE,
  });
  let reaped = queued.length > 0 ? await sweepOrphans(db, queued, false) : 0;

  // Re-read `Date.now()` for the second pass: the first one did round trips.
  const running = await db.job.findMany({
    where: { status: "running", createdAt: { lt: new Date(Date.now() - maxAgeMs) } },
    select: REAP_SELECT,
    orderBy: { createdAt: "asc" },
    take: REAP_PAGE_SIZE,
  });
  const stranded = running.filter(
    (row) => row.status === "running" && isPastReapFloor(row, floor, "startedAt"),
  );
  if (stranded.length > 0) {
    reaped += await sweepOrphans(db, stranded, true);
  }
  return reaped;
}

/**
 * Re-enqueues the rows BullMQ can no longer deliver.
 *
 * `resetRow` is set for the `running` pass only: those rows have to go back to
 * `queued` or the dashboard shows a job in flight forever. A `queued` row is
 * already in the right state and is deliberately not rewritten, so the reaper
 * cannot clobber a status the worker wrote between the read and here.
 */
async function sweepOrphans(
  db: ReturnType<typeof prisma>,
  rows: ReadonlyArray<{ id: string; type: JobType; projectId: string | null; status: JobStatus }>,
  resetRow: boolean,
): Promise<number> {
  const queue = jobQueue();
  let reaped = 0;
  for (const row of rows) {
    let bull: Awaited<ReturnType<Queue["getJob"]>> | null = null;
    try {
      bull = (await queue.getJob(row.id)) ?? null;
    } catch {
      // A failed lookup is not evidence that the job is live. Attempt the
      // re-add anyway: BullMQ deduplicates on the job id, so the attempt cannot
      // produce a second copy of live work, and if Redis is genuinely down the
      // add fails too and the row records why.
      bull = null;
    }
    if (bull) {
      // An entry we cannot classify is left alone. Existence is treated as
      // liveness on purpose: re-adding over an entry BullMQ still owns is at
      // best a no-op and at worst a second copy of the same work against the
      // same git workspace.
      let live: boolean;
      try {
        live = typeof bull.getState !== "function" || isSchedulableBullState(await bull.getState());
      } catch {
        live = true;
      }
      if (live) continue;
    }
    try {
      if (bull) {
        // A finished entry has to go before the re-add, because adding over an
        // id that already exists is a silent no-op. It cannot be locked — a
        // locked job reads `active`, which was just skipped — so this cannot
        // pull work out from under a running worker.
        await bull.remove();
      }
      // An explicit attempt budget. A plain re-add resets it to the configured
      // JOB_MAX_ATTEMPTS, so a job that reliably kills its worker (an
      // out-of-memory index, an upstream that takes the process down) was
      // handed a full fresh budget every sweep — turning a silent wedge into an
      // unbounded crash loop that the reaper itself was sustaining. One
      // re-delivery per sweep is what "rescue an abandoned job" means; if it
      // fails again, the ordinary BullMQ backoff and the job's own retry
      // policy take over.
      await addToQueue(row.id, row.type, row.projectId, { attempts: 1 });
      if (resetRow) {
        // Compare-and-set on the status we observed. An unconditional
        // `update({ where: { id } })` raced the worker: a job that finished
        // between this pass's findMany and here had its row flipped from
        // "completed" back to "queued" while the re-add above put it back on
        // the queue, so completed work ran a second time and the row ended up
        // describing a run that had already happened.
        const reset = await db.job.updateMany({
          where: { id: row.id, status: row.status },
          data: {
            status: "queued",
            progress: 0,
            stage: "re-enqueued after its worker disappeared",
            error: null,
          },
        });
        if (reset.count === 0) {
          // The worker got there first. Undo the re-add so a finished job is
          // not executed again on the strength of a stale read.
          await queue.getJob(row.id).then((j) => j?.remove()).catch(() => {});
          continue;
        }
      }
      reaped += 1;
    } catch (err) {
      await noteReapFailure(db, row.id, err as Error);
    }
  }
  return reaped;
}

/** Records why a row was not re-enqueued, without touching its status. */
async function noteReapFailure(
  db: ReturnType<typeof prisma>,
  id: string,
  err: Error,
): Promise<void> {
  try {
    await db.job.update({
      where: { id },
      data: { error: `Orphaned job could not be re-enqueued: ${redactQueueError(err.message)}` },
    });
  } catch {
    // The row itself is unreachable (deleted by a concurrent delete_project).
    // There is nothing left to annotate, and the sweep must not abort over it.
  }
}

/**
 * Deletes finished job rows older than the retention window.
 *
 * Two properties matter more than speed here:
 *
 * - Only terminal statuses are eligible. If a `queued` or `running` row were
 *   deleted, the matching BullMQ job would still be in Redis, and the worker
 *   would pick it up and write to a row that no longer exists.
 * - Work is done in bounded batches. A single `DELETE ... WHERE created_at < ?`
 *   over a year of backlog takes a row-level lock on every match and holds it
 *   until commit, blocking the writes of every job still running. Pages of ids
 *   plus a narrow `deleteMany` keep each transaction short; the row cap means
 *   a huge backlog drains over several sweeps instead of one long one.
 *
 * The cutoff is on `createdAt`, which is what retention actually means: a job
 * is old once it was *created*. The cutoff used to be on `updatedAt`, on the
 * reasoning that cancelled rows never get a `completedAt` — true, but
 * `createdAt` covers them too. What the code can guarantee is only the shape
 * of the query: it filters on `status` and orders by `createdAt ASC`, which
 * are the two columns of the `job` table's `@@index([status, createdAt])`, in
 * that order, so a plan that walks that index is available to the planner.
 * Whether Postgres takes it — a three-valued `status IN (...)` on a large
 * table often gets a bitmap scan plus a sort instead — depends on the data,
 * and no `EXPLAIN` was run to confirm either shape. A cutoff on `updated_at`
 * has no index leading with it, so that variant can only be served by reading
 * the rows and filtering: the reason for moving the cutoff is the index, not
 * a measured plan.
 */
export async function pruneJobs(
  retentionDays: number = JOB_RETENTION_DAYS,
  batchSize: number = JOB_PRUNE_BATCH_SIZE,
): Promise<number> {
  if (retentionDays <= 0) return 0;
  const db = prisma();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600_000);
  const take = Math.max(1, batchSize);
  let deleted = 0;

  while (deleted < JOB_PRUNE_MAX_ROWS) {
    const page = await db.job.findMany({
      where: { status: { in: PRUNABLE_STATUSES }, createdAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take,
    });
    if (page.length === 0) break;

    const ids = page.map((r) => r.id);
    const result = await db.job.deleteMany({ where: { id: { in: ids } } });
    deleted += result.count;
    // Nothing went away (another worker pruned the same page) or the page was
    // short: either way the next page would be the same rows, so stop rather
    // than spin.
    if (result.count === 0 || page.length < take) break;
  }
  return deleted;
}

/**
 * Removes BullMQ jobs by id, ignoring any that a worker currently holds a lock
 * on.
 *
 * `delete_project` purges the project's job rows, but a sibling job still
 * queued in Redis — a delayed sync, an `incremental_index` waiting behind a
 * full reindex — survives that. A worker later picks it up and indexes a
 * project whose row no longer exists, failing on a foreign key and retrying
 * `JOB_MAX_ATTEMPTS` times before anyone notices.
 */
export async function removeQueueJobs(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const q = jobQueue();
  let removed = 0;
  for (const id of ids) {
    try {
      const job = await q.getJob(id);
      if (!job) continue;
      await job.remove();
      removed += 1;
    } catch (err) {
      // BullMQ refuses to remove a locked job. Leaving it is the right call:
      // its row is already gone, so when the worker finishes there is nothing
      // left for it to corrupt.
      console.error(
        `[queue] could not remove job ${id}: ${redactQueueError((err as Error).message)}`,
      );
    }
  }
  return removed;
}

/**
 * Whether a repository is due a scheduled sync.
 *
 * Never synced counts as due: a project whose first index failed has a null
 * `lastSuccessfulSync` forever, and skipping those is exactly how a project
 * quietly rots.
 */
export function isSyncDue(
  lastSuccessfulSync: Date | null,
  now: number = Date.now(),
  minAgeMs: number = SYNC_MIN_AGE_MS,
): boolean {
  if (!lastSuccessfulSync) return true;
  return now - lastSuccessfulSync.getTime() >= minAgeMs;
}

/**
 * Delay before the next attempt for a repository that has failed `failures`
 * syncs in a row: one sweep interval, doubling, capped at `maxMs`.
 *
 * The cost of the cap is deliberate — a repository broken by a deleted branch
 * or revoked credentials is still retried, roughly weekly, rather than being
 * written off. A branch that comes back, or credentials that are rotated, are
 * picked up on their own with no one pressing a button.
 */
export function syncRetryDelayMs(
  failures: number,
  baseMs: number = SYNC_RETRY_BASE_MS,
  maxMs: number = SYNC_RETRY_MAX_MS,
): number {
  if (failures <= 0) return 0;
  // Capped exponent so a long-lived streak cannot reach Infinity/2^53 and
  // produce a non-finite delay.
  const exponent = Math.min(failures - 1, 32);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

/**
 * Consecutive failed `repository_sync` runs, newest first, and when the most
 * recent one finished.
 *
 * Counted from the job table rather than a counter on `repository` because the
 * table is already the record of every outcome: adding a column would mean a
 * migration for state that is derivable. Only the *leading* run of failures
 * counts — one success resets the streak — and only the newest
 * `probeLimit` rows are examined, because past the cap the delay is pinned at
 * `SYNC_RETRY_MAX_MS` and the exact count no longer changes the outcome.
 */
export function syncFailureStreak(
  recent: ReadonlyArray<{ status: string; createdAt: Date; completedAt: Date | null }>,
  probeLimit: number = SYNC_FAILURE_PROBE_LIMIT,
): { failures: number; lastFailureAt: Date | null } {
  let failures = 0;
  let lastFailureAt: Date | null = null;
  for (const job of recent.slice(0, Math.max(0, probeLimit))) {
    if (job.status !== "failed") break;
    failures += 1;
    if (!lastFailureAt) lastFailureAt = job.completedAt ?? job.createdAt;
  }
  return { failures, lastFailureAt };
}

/** Whether a repository inside a failure streak is due another attempt yet. */
export function isSyncRetryAllowed(
  streak: { failures: number; lastFailureAt: Date | null },
  now: number = Date.now(),
  baseMs: number = SYNC_RETRY_BASE_MS,
  maxMs: number = SYNC_RETRY_MAX_MS,
): boolean {
  if (streak.failures <= 0) return true;
  // No timestamp to measure from (rows pruned, or createdAt/completedAt both
  // null): attempt rather than pin the repository out of the sweep over a
  // bookkeeping gap. The streak it just earned will gate the next one.
  if (!streak.lastFailureAt) return true;
  return now - streak.lastFailureAt.getTime() >= syncRetryDelayMs(streak.failures, baseMs, maxMs);
}

/**
 * Enqueues a `repository_sync` for every project that is due one.
 *
 * Nothing else covers this: a webhook is the only thing that enqueues a sync,
 * and only GitHub projects can have one. Every other provider — GitLab,
 * Bitbucket, a plain SSH URL — sat at whatever commit it was created with
 * until someone pressed the button, which is the same as never.
 *
 * Two brakes keep a broken repository from being retried forever:
 *
 * - Repositories whose last *index* run did not end cleanly are skipped
 *   (`Repository.syncStatus = "error"`). That field is written by the
 *   indexing pipeline, not by a sync: a run that throws leaves
 *   `Index failed: …`, a run that finishes with any file failed leaves
 *   `N file(s) failed to index`, and a clean finish or a cancellation leaves
 *   `synced`. So the filter means "this project's code has not indexed
 *   cleanly" — it says nothing about whether the remote is reachable, and
 *   nothing about files that merely will not parse; a repository that 404s or
 *   rejects its credentials does not change the field at all, because the
 *   `repository_sync` handler only ever writes `synced`. It is a
 *   cheapest-first brake, not a broken-repository guard.
 * - The failure streak (`isSyncRetryAllowed`) is the guard against a broken
 *   repository. It reads the run of failed `repository_sync` jobs for the
 *   project and backs off exponentially, so a deleted branch or revoked
 *   credentials costs one attempt per doubling instead of one every sweep,
 *   forever.
 */
export async function enqueueScheduledSyncs(now: number = Date.now()): Promise<number> {
  const db = prisma();
  const projects = await db.project.findMany({
    // Filtered on the REPOSITORY's sync status, not the project's.
    //
    // `Project.status` used to be the filter here. Both fields are written
    // from the same indexing outcome — the pipeline's status guard updates the
    // two rows together — so moving the filter does not change which projects
    // are selected: a failed index run leaves "error" on both, a later
    // successful run leaves "synced" on both, and a cancellation is "synced"
    // on both. The repository row is the one that describes the source itself,
    // and either way this stays an *indexing* filter; see the note above on
    // what `syncStatus` does and does not tell you.
    where: {
      repository: { is: { syncStatus: { not: "error" } } },
    },
    select: { id: true, repository: { select: { lastSuccessfulSync: true } } },
    // Least-recently-synced first, never-synced ahead of them. Ordering by
    // creation instead would pin the sweep to the same first N projects
    // forever and let everything after them rot.
    orderBy: { repository: { lastSuccessfulSync: { sort: "asc", nulls: "first" } } },
    take: SYNC_SWEEP_PAGE_SIZE,
  });

  let enqueued = 0;
  for (const project of projects) {
    if (!isSyncDue(project.repository?.lastSuccessfulSync ?? null, now)) continue;
    // Skip while anything for this project is in flight. `dedupe` would hand
    // back the running job's id anyway, so the check is belt-and-braces for
    // the case where the active job is a different type.
    const active = await db.job.findFirst({
      where: { projectId: project.id, status: { in: ["queued", "running"] } },
      select: { id: true },
    });
    if (active) continue;
    // Read the recent outcome history for this project before spending an
    // attempt. One extra query per *due* project per sweep (at most
    // SYNC_SWEEP_PAGE_SIZE), served by `@@index([projectId, createdAt])` and
    // capped at SYNC_FAILURE_PROBE_LIMIT rows — the price of not hammering a
    // permanently broken remote four times a day, forever.
    const recent = await db.job.findMany({
      where: { projectId: project.id, type: "repository_sync" },
      select: { status: true, createdAt: true, completedAt: true },
      orderBy: { createdAt: "desc" },
      take: SYNC_FAILURE_PROBE_LIMIT,
    });
    if (!isSyncRetryAllowed(syncFailureStreak(recent), now)) continue;
    try {
      await enqueueJob(project.id, "repository_sync", {
        dedupe: true,
        metadata: { trigger: "schedule" },
      });
      enqueued += 1;
    } catch (err) {
      // Queue down, or a race with a concurrent enqueue. The next sweep
      // retries; one failure must not abort the whole page of projects.
      console.error(
        `[queue] scheduled sync enqueue failed for project ${project.id}: ` +
          redactQueueError((err as Error).message),
      );
    }
  }
  return enqueued;
}

export async function queueDepth(): Promise<number> {
  try {
    const q = jobQueue();
    const [waiting, active, delayed] = await Promise.all([
      q.getWaitingCount(),
      q.getActiveCount(),
      q.getDelayedCount(),
    ]);
    return waiting + active + delayed;
  } catch {
    return -1;
  }
}