import { Queue } from "bullmq";
import IORedis from "ioredis";
import type { JobType } from "@/generated/prisma/enums";
import { env } from "@/lib/env";
import { conflict } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

/**
 * BullMQ-backed job queue over Redis. The PostgreSQL `job` table remains the
 * source of truth; BullMQ tracks queue mechanics (retries, delays, locks).
 */

export const QUEUE_NAME = "repotrace";

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
    await jobQueue().add(type, { jobId: created.id, projectId, type }, {
      jobId: created.id,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
      attempts: env().JOB_MAX_ATTEMPTS,
      backoff: { type: "exponential", delay: env().JOB_RETRY_BACKOFF_MS },
      delay: opts.delayMs,
    });
  } catch (err) {
    // Redis unavailable: keep the DB row but surface the failure.
    await db.job.update({
      where: { id: created.id },
      data: { status: "failed", error: `Could not enqueue job: ${(err as Error).message}` },
    });
    throw conflict("queue_unavailable", "Job queue is unavailable; try again shortly");
  }
  return created.id;
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