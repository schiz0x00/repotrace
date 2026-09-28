import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JobType } from "@/generated/prisma/enums";

/**
 * What this file covers, and what it does not.
 *
 * Covered:
 * - The two constants and the relationship the drain depends on. The bounded
 *   drain only gets to run if `SHUTDOWN_GRACE_MS` is shorter than the stop
 *   timeout the deployment applies, and if enough headroom is left over for the
 *   requeue write that is the whole point of bounding the drain.
 * - That `DEFAULT_STOP_TIMEOUT_MS` is the value the *shipped* deployment
 *   actually applies, checked against `docker-compose.yml` rather than
 *   asserted in a comment.
 * - `drainWorker` itself, driven with a fake worker whose `close()` either
 *   settles or never does: which rows it puts back to `queued`, and that it
 *   touches nothing when the worker drained in time.
 * - The job processor `startWorker` installs in BullMQ: the status
 *   transitions it writes, the cancellation paths, the retry-versus-final-failure
 *   split, and the two handlers that are not indexing.
 *
 * Not covered: the SIGTERM/SIGINT wiring. That handler is installed only under
 * the `process.argv[1].endsWith("worker/index.ts")` guard at the bottom of the
 * module, which is false under vitest, so nothing here sends a signal and
 * nothing here observes the `process.exit(0)` that follows the drain. Nor is
 * `withProjectLock` exercised under real concurrency: the processor is driven
 * job by job.
 *
 * Hermetic: every runtime dependency is mocked at the module boundary, and
 * importing the module starts no worker for the same reason.
 */

/** A repo file, resolved from the directory vitest runs in (walks up a few levels). */
function repoFile(relative: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 4; i += 1) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`could not find ${relative} at or above ${process.cwd()}`);
}

const prismaMock = vi.hoisted(() => {
  /**
   * Rows the processor reads and writes. A `job.update` against an id that is
   * not here throws Prisma's P2025, which is what `markJob` is built to
   * tolerate — so the fake has to reproduce that, or the tolerance is untested.
   */
  const jobs = new Map<string, Record<string, unknown>>();
  const notFound = () => {
    const err = new Error("Record to update not found.") as Error & { code: string };
    err.code = "P2025";
    return err;
  };
  const update = async ({
    where,
    data,
  }: {
    where: { id: string };
    data: Record<string, unknown>;
  }) => {
    const row = jobs.get(where.id);
    if (!row) throw notFound();
    Object.assign(row, data);
    return { ...row };
  };
  return {
    jobs,
    // Re-applied in `beforeEach`: `vi.clearAllMocks()` clears recorded calls but
    // leaves an implementation installed by `mockRejectedValue` in place, so a
    // test that makes a write fail would otherwise leak into every later one.
    update,
    job: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      update: vi.fn(update),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = jobs.get(where.id);
        return row ? { ...row } : null;
      }),
      findMany: vi.fn(async () => [] as Array<{ id: string }>),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    apiKey: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    evalQuestion: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    project: {
      findUnique: vi.fn(),
      findMany: vi.fn(async () => []),
      delete: vi.fn(async () => ({})),
    },
    repository: { update: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (ops: unknown) => ops),
  };
});

const queueMock = vi.hoisted(() => ({
  // Loosely typed: the fake only has to stand in for the BullMQ job shape the
  // drain reads (id, name, data.projectId).
  getJobs: vi.fn(
    async (): Promise<Array<{ id: string; name: string; data: { projectId: string | null } }>> => [],
  ),
}));

/**
 * Spies for the collaborators whose *call arguments* are under test.
 *
 * Declared untyped on purpose: a `vi.fn(async () => ...)` infers its signature
 * from the seed implementation, and every test that returns something else from
 * the same spy would then be a type error rather than a test. `beforeEach`
 * installs the defaults.
 */
const deps = vi.hoisted(() => ({
  enqueueJob: vi.fn(),
  removeQueueJobs: vi.fn(),
  syncRepository: vi.fn(),
  currentHead: vi.fn(),
  deleteProjectVectors: vi.fn(),
  removeWorkspace: vi.fn(),
  recordMetric: vi.fn(),
  runIndexJob: vi.fn(),
}));

/** What a successful index run reports, and the shape `summarizeResult` reads. */
const INDEX_RESULT = {
  filesProcessed: 3,
  filesSkipped: 1,
  filesFailed: 0,
  chunksProcessed: 9,
  embeddingsGenerated: 9,
  vectorsWritten: 9,
  filesDeleted: 0,
  failedFiles: [] as Array<{ path: string; error: string }>,
};

/** What `startWorker` hands to BullMQ, captured so the processor can be driven. */
const workerMock = vi.hoisted(() => ({
  processor: null as
    | null
    | ((job: never, token: undefined, signal?: AbortSignal) => Promise<unknown>),
  options: null as Record<string, unknown> | null,
  listeners: {} as Record<string, (arg: unknown) => void>,
}));

vi.mock("dotenv/config", () => ({}));

vi.mock("@/lib/env", () => ({
  env: () => ({ WORKER_CONCURRENCY: 1 }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: () => prismaMock,
  disconnectPrisma: async () => {},
}));

vi.mock("@/lib/jobs/queue", () => ({
  QUEUE_NAME: "repotrace",
  SYNC_SWEEP_INTERVAL_MS: 3600_000,
  redisConnection: () => ({}),
  jobQueue: () => queueMock,
  enqueueJob: deps.enqueueJob,
  enqueueScheduledSyncs: async () => 0,
  reapOrphanedJobs: async () => 0,
  pruneJobs: async () => 0,
  removeQueueJobs: deps.removeQueueJobs,
}));

vi.mock("@/lib/indexing/pipeline", () => ({
  runIndexJob: deps.runIndexJob,
  syncRepository: deps.syncRepository,
  CancelledError: class CancelledError extends Error {},
}));

vi.mock("@/lib/qdrant", () => ({ deleteProjectVectors: deps.deleteProjectVectors }));
vi.mock("@/lib/git/workspace", () => ({ removeWorkspace: deps.removeWorkspace }));
vi.mock("@/lib/git/git", () => ({ currentHead: deps.currentHead }));
vi.mock("@/lib/metrics", () => ({
  pruneMetrics: async () => 0,
  recordMetric: deps.recordMetric,
}));
vi.mock("@/lib/indexing/parser", () => ({ preloadGrammars: async () => {} }));

vi.mock("bullmq", () => ({
  Worker: class {
    constructor(
      _name: string,
      processor: (job: never, token: undefined, signal?: AbortSignal) => Promise<unknown>,
      options: Record<string, unknown>,
    ) {
      workerMock.processor = processor;
      workerMock.options = options;
    }
    on(event: string, cb: (arg: unknown) => void) {
      workerMock.listeners[event] = cb;
      return this;
    }
    async close() {}
  },
}));

const { SHUTDOWN_GRACE_MS, DEFAULT_STOP_TIMEOUT_MS, drainWorker, startWorker } = await import(
  "@/worker/index"
);
const { CancelledError } = await import("@/lib/indexing/pipeline");

/** The processor BullMQ would call, obtained the only way it is reachable. */
let runProcessor: (job: never, token?: undefined, signal?: AbortSignal) => Promise<unknown>;
beforeAll(() => {
  // startWorker() registers unref'd sweep timers and runs the reaper once; all
  // of it is mocked, and nothing here fires on a 5-minute/1-hour/6-hour timer.
  startWorker();
  runProcessor = workerMock.processor!;
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.jobs.clear();
  prismaMock.job.update.mockImplementation(prismaMock.update);
  prismaMock.job.updateMany.mockResolvedValue({ count: 0 });
  queueMock.getJobs.mockResolvedValue([]);
  prismaMock.job.findMany.mockResolvedValue([]);
  prismaMock.project.findUnique.mockResolvedValue(null);
  deps.enqueueJob.mockResolvedValue("job-new");
  deps.removeQueueJobs.mockResolvedValue(0);
  deps.syncRepository.mockResolvedValue("/tmp/workspace");
  deps.currentHead.mockResolvedValue("abc123");
  deps.deleteProjectVectors.mockResolvedValue(undefined);
  deps.removeWorkspace.mockResolvedValue(undefined);
  deps.recordMetric.mockResolvedValue(undefined);
  deps.runIndexJob.mockImplementation(async (ctx: {
    onProgress?: (pct: number, stage: string) => void;
  }) => {
    ctx.onProgress?.(42, "indexing");
    return { ...INDEX_RESULT };
  });
});

/** A BullMQ job, with only the fields the processor reads. */
function bullJob(
  data: { jobId: string; projectId: string | null; type: JobType },
  overrides: Record<string, unknown> = {},
) {
  return {
    id: data.jobId,
    name: data.type,
    data,
    attemptsMade: 0,
    opts: { attempts: 3 },
    updateProgress: vi.fn(async () => {}),
    ...overrides,
  } as never;
}

/** Seeds a job row and returns its id. */
function seedJob(id: string, fields: Record<string, unknown> = {}): string {
  prismaMock.jobs.set(id, { id, status: "queued", projectId: "p1", type: "full_reindex", ...fields });
  return id;
}

/** Every `status` the processor wrote to a row, in order. */
function statuses(jobId: string): unknown[] {
  return (prismaMock.job.update as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .filter((c) => (c[0] as { where: { id: string } }).where.id === jobId)
    .map((c) => (c[0] as { data: { status?: unknown } }).data.status)
    .filter((s) => s !== undefined);
}

/** A stand-in for the BullMQ worker: `close` resolves or hangs, as told. */
function fakeWorker(settles: boolean): { close: () => Promise<void> } {
  return { close: settles ? async () => {} : () => new Promise<void>(() => {}) };
}

describe("worker shutdown grace", () => {
  it("is shorter than the stop timeout, so the bounded drain actually runs", () => {
    expect(SHUTDOWN_GRACE_MS).toBeLessThan(DEFAULT_STOP_TIMEOUT_MS);
  });

  // What the deadline buys is the "requeue the abandoned rows" write after the
  // race: one Redis round trip, one bounded updateMany, one pool disconnect.
  // Without that headroom the process is SIGKILLed mid-write and the abandoned
  // jobs stay `running` forever, which the orphan reaper cannot rescue.
  it("leaves headroom for the abandon path to finish", () => {
    const headroom = DEFAULT_STOP_TIMEOUT_MS - SHUTDOWN_GRACE_MS;
    expect(headroom).toBeGreaterThanOrEqual(2_000);
  });

  // The constant is only meaningful if it is the timeout this deployment
  // actually applies. Docker's default is 10s; the shipped worker service
  // raises it only if it sets `stop_grace_period`, which it currently does
  // not. If someone adds one, this fails and the constant has to be revisited.
  it("matches the stop timeout the shipped compose service actually applies", () => {
    const compose = readFileSync(repoFile("docker-compose.yml"), "utf8");
    const workerService = compose.split(/\n(?=  [a-z])/).find((s) => s.startsWith("  worker:"));
    expect(workerService, "worker service not found in docker-compose.yml").toBeDefined();
    expect(workerService).not.toContain("stop_grace_period");
    expect(DEFAULT_STOP_TIMEOUT_MS).toBe(10_000);
  });
});

describe("drainWorker", () => {
  // The case the grace period exists for: the deadline beats worker.close(),
  // so the in-flight jobs are dropped and their rows have to go back to
  // `queued` — the orphan reaper only rescues `queued` rows, so a row left
  // `running` is never run again and `dedupe` keeps handing its id out.
  it("puts the still-active rows back to queued when the deadline wins", async () => {
    queueMock.getJobs.mockResolvedValue([
      { id: "j1", name: "full_reindex", data: { projectId: "p1" } },
      { id: "j2", name: "repository_sync", data: { projectId: "p2" } },
    ]);

    await expect(drainWorker(fakeWorker(false), 5)).resolves.toBe("abandoned");

    expect(queueMock.getJobs).toHaveBeenCalledWith(["active"]);
    expect(prismaMock.job.updateMany).toHaveBeenCalledWith({
      // Guarded on `running`, so a job that finished in the meantime is left alone.
      where: { id: { in: ["j1", "j2"] }, status: "running" },
      data: { status: "queued", stage: "requeued after shutdown", error: null },
    });
  });

  it("touches nothing when worker.close() settles inside the grace period", async () => {
    await expect(drainWorker(fakeWorker(true), 1_000)).resolves.toBe("drained");
    expect(queueMock.getJobs).not.toHaveBeenCalled();
    expect(prismaMock.job.updateMany).not.toHaveBeenCalled();
  });

  // A close() that rejects is still a close(): the worker is not going to
  // finish those jobs, but it is also not holding them any more, so nothing is
  // requeued. This is the pre-existing behaviour, pinned here so the
  // `drained` flag is not "fixed" into the opposite by accident.
  it("treats a rejected close() as drained", async () => {
    const worker = { close: async () => { throw new Error("already closed"); } };
    await expect(drainWorker(worker, 1_000)).resolves.toBe("drained");
    expect(prismaMock.job.updateMany).not.toHaveBeenCalled();
  });

  // Redis unreachable when the abandoned-job lookup runs: `getJobs` rejects,
  // the id list is empty, and the drain still returns rather than hanging the
  // shutdown path until SIGKILL.
  it("survives a queue lookup that fails", async () => {
    queueMock.getJobs.mockRejectedValue(new Error("redis down"));
    await expect(drainWorker(fakeWorker(false), 5)).resolves.toBe("abandoned");
    expect(prismaMock.job.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * The processor `startWorker` installs in BullMQ.
 *
 * The row is the only durable record of a job, so every transition here is a
 * write a human reads in the dashboard. The invariant under all of it: BullMQ
 * owns the retry, PostgreSQL owns the history, and neither may be left
 * describing a job that is not doing what it says.
 */
describe("worker job processor", () => {
  it("marks the row running, then completed, and returns the handler's result", async () => {
    const id = seedJob("job-1");
    const job = bullJob({ jobId: id, projectId: "p1", type: "full_reindex" });

    const result = await runProcessor(job);

    expect(result).toMatchObject({ filesProcessed: 3 });
    expect(statuses(id)).toEqual(["running", "completed"]);
    const row = prismaMock.jobs.get(id)!;
    expect(row.status).toBe("completed");
    expect(row.progress).toBe(100);
    expect(row.stage).toBe("completed");
    // `startedAt`/`completedAt` are what the jobs table sorts and the dashboard
    // reads. markJob stamps one of them per transition and sends the other as
    // `undefined`, which Prisma reads as "leave it alone" — so the fake store
    // cannot be trusted for it; the arguments can.
    const writes = (prismaMock.job.update as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter((c) => (c[0] as { where: { id: string } }).where.id === id)
      .map((c) => (c[0] as { data: Record<string, unknown> }).data);
    const running = writes.find((d) => d.status === "running")!;
    expect(running.startedAt).toBeInstanceOf(Date);
    const completed = writes.find((d) => d.status === "completed")!;
    expect(completed.completedAt).toBeInstanceOf(Date);
    expect(completed.startedAt).toBeUndefined();
    // Progress is cleared on entry, so a job retried after a failure does not
    // report the previous attempt's percentage.
    expect(running.progress).toBe(0);
    expect(running.stage).toBe("starting");
  });

  it("records the counts the index run reported, merged into existing metadata", async () => {
    const id = seedJob("job-1", { metadata: { trigger: "webhook" } });

    await runProcessor(bullJob({ jobId: id, projectId: "p1", type: "incremental_index" }));

    // The pipeline computed all of this and it was thrown away, so the row
    // could only ever say "completed". `trigger` is the enqueue metadata the
    // row already carried — a summary must not erase it.
    expect(prismaMock.jobs.get(id)!.metadata).toEqual({
      trigger: "webhook",
      filesProcessed: 3,
      filesSkipped: 1,
      filesFailed: 0,
      chunksProcessed: 9,
      embeddingsGenerated: 9,
      vectorsWritten: 9,
      filesDeleted: 0,
      failedFiles: [],
    });
  });

  // A wholly broken repository must not be able to write an unbounded blob
  // into the job row, and the per-file error must not either.
  it("caps the failed-file list and each error string in the summary", async () => {
    const id = seedJob("job-1");
    deps.runIndexJob.mockResolvedValue({
      filesProcessed: 60,
      filesFailed: 60,
      failedFiles: Array.from({ length: 60 }, (_, i) => ({
        path: `src/file-${i}.ts`,
        error: "x".repeat(900),
      })),
    });

    await runProcessor(bullJob({ jobId: id, projectId: "p1", type: "full_reindex" }));

    const meta = prismaMock.jobs.get(id)!.metadata as {
      failedFiles: Array<{ path: string; error: string }>;
    };
    expect(meta.failedFiles).toHaveLength(50);
    expect(meta.failedFiles[0].error).toHaveLength(500);
  });

  // A non-indexing handler returns no counts. Writing `{}` over the row's
  // metadata would drop the enqueue metadata for nothing.
  it("does not touch metadata when the result carries no counts", async () => {
    const id = seedJob("job-1", { type: "repository_sync", metadata: { trigger: "schedule" } });
    prismaMock.project.findUnique.mockResolvedValue({
      id: "p1",
      repository: {
        id: "r1",
        url: "https://github.com/example/alpha",
        branch: "main",
        provider: "github",
        credentialsEncrypted: null,
        lastKnownCommit: "aaa111",
      },
    });
    deps.currentHead.mockResolvedValue("aaa111");

    await runProcessor(bullJob({ jobId: id, projectId: "p1", type: "repository_sync" }));

    expect(prismaMock.jobs.get(id)!.metadata).toEqual({ trigger: "schedule" });
  });

  // The regression the preflight guard exists for: cancelling a *queued* job
  // used to be undone by the worker moments later, which wrote "running" over
  // "cancelled" and ran the full index anyway — a cancel that reported success
  // and did the opposite.
  it("does not run a job that was cancelled before it started", async () => {
    const id = seedJob("job-1", { status: "cancelled" });
    const job = bullJob({ jobId: id, projectId: "p1", type: "full_reindex" });

    await expect(runProcessor(job)).resolves.toEqual({ cancelled: true });

    expect(deps.runIndexJob).not.toHaveBeenCalled();
    expect(prismaMock.job.update).not.toHaveBeenCalled();
    expect(prismaMock.jobs.get(id)!.status).toBe("cancelled");
  });

  // An in-flight cancel: the row is flipped while the pipeline runs, and the
  // pipeline's isCancelled() is what observes it. The row must end `cancelled`,
  // not `failed` — the work was not broken, it was called off.
  it("marks a job cancelled when the pipeline reports the cancel", async () => {
    const id = seedJob("job-1");
    deps.runIndexJob.mockImplementation(async (ctx) => {
      if (await ctx.isCancelled!()) throw new CancelledError();
      return { filesProcessed: 1 };
    });

    const job = bullJob({ jobId: id, projectId: "p1", type: "full_reindex" });
    prismaMock.job.update.mockImplementation(async ({ where, data }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const row = prismaMock.jobs.get(where.id);
      if (!row) throw Object.assign(new Error("not found"), { code: "P2025" });
      Object.assign(row, data);
      if (data.status === "running") row.status = "cancelled";
      return { ...row };
    });

    await expect(runProcessor(job)).resolves.toEqual({ cancelled: true });
    expect(prismaMock.jobs.get(id)!.status).toBe("cancelled");
    // A cancellation is not a failure and must not be counted as one.
    expect(deps.recordMetric).not.toHaveBeenCalled();
  });

  // BullMQ's AbortSignal is the other way a cancel arrives: the row is not
  // consulted, so this only works if `run` really threads the signal through.
  it("honours BullMQ's AbortSignal without reading the row", async () => {
    const id = seedJob("job-1");
    const controller = new AbortController();
    controller.abort();
    let sawSignal = false;
    deps.runIndexJob.mockImplementation(async (ctx) => {
      sawSignal = await ctx.isCancelled!();
      return { filesProcessed: 1 };
    });

    await runProcessor(bullJob({ jobId: id, projectId: "p1", type: "full_reindex" }), undefined, controller.signal);

    expect(sawSignal).toBe(true);
  });

  // BullMQ still owns a job that has attempts left, and the reaper only rescues
  // `queued` rows — so a row left `failed` here would be neither running nor
  // reapable, and the dashboard would read "failed" for a job that is about to
  // be retried.
  it("leaves a retrying job `running` with its error, and fails it only on the last attempt", async () => {
    const id = seedJob("job-1");
    const boom = new Error("indexing blew up");
    deps.runIndexJob.mockRejectedValue(boom);

    await expect(
      runProcessor(bullJob({ jobId: id, projectId: "p1", type: "full_reindex" }, { attemptsMade: 0 })),
    ).rejects.toThrow("indexing blew up");
    expect(prismaMock.jobs.get(id)).toMatchObject({ status: "running", stage: "retrying", error: "indexing blew up" });

    await expect(
      runProcessor(bullJob({ jobId: id, projectId: "p1", type: "full_reindex" }, { attemptsMade: 2 })),
    ).rejects.toThrow("indexing blew up");
    expect(prismaMock.jobs.get(id)).toMatchObject({ status: "failed", error: "indexing blew up" });
    expect(prismaMock.jobs.get(id)!.stage).not.toBe("retrying");

    // One metric per failed job, not per failed attempt.
    expect(deps.recordMetric).toHaveBeenCalledTimes(2);
    expect(deps.recordMetric).toHaveBeenCalledWith("job_failures", 1, "p1");
  });

  it("fails a job whose configured attempt count is unknown (attempts defaults to 1)", async () => {
    const id = seedJob("job-1");
    deps.runIndexJob.mockRejectedValue(new Error("nope"));

    await expect(
      runProcessor(bullJob({ jobId: id, projectId: "p1", type: "full_reindex" }, { attemptsMade: 0, opts: {} })),
    ).rejects.toThrow("nope");
    expect(prismaMock.jobs.get(id)!.status).toBe("failed");
  });

  it("truncates a very long failure message rather than writing it whole", async () => {
    const id = seedJob("job-1");
    deps.runIndexJob.mockRejectedValue(new Error("e".repeat(9000)));

    await expect(
      runProcessor(bullJob({ jobId: id, projectId: "p1", type: "full_reindex" }, { attemptsMade: 2 })),
    ).rejects.toThrow();
    expect((prismaMock.jobs.get(id)!.error as string)).toHaveLength(4000);
  });

  it("has no handler for an unknown job type and fails the row", async () => {
    const id = seedJob("job-1");
    const job = bullJob(
      { jobId: id, projectId: "p1", type: "not_a_type" as JobType },
      { attemptsMade: 2 },
    );

    await expect(runProcessor(job)).rejects.toThrow("No handler for job type not_a_type");
    expect(prismaMock.jobs.get(id)!.status).toBe("failed");
  });

  // A delete_project removes its own row with the project, so the writes that
  // follow can find nothing. That is expected, not a database problem, and it
  // must not throw out of the processor.
  it("tolerates the row vanishing under it (delete_project's own row)", async () => {
    const id = seedJob("job-1");
    prismaMock.job.update.mockRejectedValue(
      Object.assign(new Error("Record to update not found."), { code: "P2025" }),
    );

    await expect(
      runProcessor(bullJob({ jobId: id, projectId: "p1", type: "delete_project" })),
    ).resolves.toEqual({ deleted: true });
  });

  // A real database failure is rethrown, not swallowed: silently continuing
  // would report a completed job whose row still says `queued`.
  it("does not swallow a real database error", async () => {
    const id = seedJob("job-1");
    prismaMock.job.update.mockRejectedValue(
      Object.assign(new Error("connection terminated"), { code: "P1001" }),
    );

    await expect(
      runProcessor(bullJob({ jobId: id, projectId: "p1", type: "full_reindex" })),
    ).rejects.toThrow();
  });

  it("runs with the concurrency the deployment configures", () => {
    expect(workerMock.options).toMatchObject({ concurrency: 1, autorun: true });
  });
});

/**
 * The two handlers that are not indexing. Both exist because a sync or a
 * delete that only half-happens leaves the project describing code it does not
 * have, and nothing else notices.
 */
describe("repository_sync handler", () => {
  function projectRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "p1",
      repository: {
        id: "r1",
        url: "https://github.com/example/alpha",
        branch: "main",
        provider: "github",
        credentialsEncrypted: null,
        lastKnownCommit: "aaa111",
        ...overrides,
      },
    };
  }

  async function sync(
    repo: Record<string, unknown> = {},
    head: string = "aaa111",
  ): Promise<{ id: string; result: unknown }> {
    const id = seedJob("job-1", { type: "repository_sync" });
    prismaMock.project.findUnique.mockResolvedValue(projectRow(repo));
    deps.currentHead.mockResolvedValue(head);
    const result = await runProcessor(
      bullJob({ jobId: id, projectId: "p1", type: "repository_sync" }),
    );
    return { id, result };
  }

  it("records the sync on the repository and reindexes when HEAD moved", async () => {
    const { id, result } = await sync({ lastKnownCommit: "aaa111" }, "bbb222");

    expect(deps.syncRepository).toHaveBeenCalledWith(
      "p1",
      "https://github.com/example/alpha",
      "main",
      "github",
      null,
      expect.any(Function),
    );
    expect(prismaMock.repository.update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { syncStatus: "synced", syncError: null, lastSuccessfulSync: expect.any(Date) },
    });
    // A sync that moves HEAD without reindexing leaves the project describing
    // code it no longer has, and the next scheduled sweep then sees the same
    // head and does nothing. The follow-up index is the only thing that makes
    // the sweep refresh anything.
    expect(deps.enqueueJob).toHaveBeenCalledWith("p1", "incremental_index", {
      dedupe: true,
      metadata: { trigger: "sync", from: "aaa111", to: "bbb222" },
    });
    expect(prismaMock.jobs.get(id)!.status).toBe("completed");
    expect(result).toEqual({ synced: true, head: "bbb222", reindexed: true });
  });

  it("does not enqueue an index when the branch did not move", async () => {
    const { result } = await sync({ lastKnownCommit: "aaa111" }, "aaa111");

    expect(deps.enqueueJob).not.toHaveBeenCalled();
    // The repository is still marked synced: reaching the remote is what that
    // field records, and the sync did reach it.
    expect(prismaMock.repository.update).toHaveBeenCalled();
    expect(result).toEqual({ synced: true, head: "aaa111", reindexed: false });
  });

  // The enqueue failing must fail the job, not be swallowed: the retry re-runs
  // the fetch (idempotent) and re-attempts the enqueue. Swallowing it would
  // leave the repository marked `synced` with no index behind it, which is the
  // silent drift the handler exists to prevent.
  it("fails the job when the follow-up index cannot be enqueued", async () => {
    const id = seedJob("job-1", { type: "repository_sync" });
    prismaMock.project.findUnique.mockResolvedValue(projectRow({ lastKnownCommit: "aaa111" }));
    deps.currentHead.mockResolvedValue("bbb222");
    deps.enqueueJob.mockRejectedValue(new Error("queue_unavailable"));

    await expect(
      runProcessor(
        bullJob({ jobId: id, projectId: "p1", type: "repository_sync" }, { attemptsMade: 2 }),
      ),
    ).rejects.toThrow("queue_unavailable");
    expect(prismaMock.jobs.get(id)!.status).toBe("failed");
  });

  it("refuses a sync with no project, and a project with no repository", async () => {
    seedJob("job-1", { type: "repository_sync" });
    await expect(
      runProcessor(bullJob({ jobId: "job-1", projectId: null, type: "repository_sync" })),
    ).rejects.toThrow("repository_sync requires a project");

    seedJob("job-2", { type: "repository_sync" });
    prismaMock.project.findUnique.mockResolvedValue({ id: "p1", repository: null });
    await expect(
      runProcessor(bullJob({ jobId: "job-2", projectId: "p1", type: "repository_sync" })),
    ).rejects.toThrow("Project has no repository");
    expect(deps.syncRepository).not.toHaveBeenCalled();
  });
});

describe("delete_project handler", () => {
  async function del(projectId: string | null = "p1") {
    const id = seedJob("job-1", { type: "delete_project" });
    prismaMock.job.findMany.mockResolvedValue([
      { id: "job-2" },
      { id: "job-3" },
    ]);
    await runProcessor(bullJob({ jobId: id, projectId, type: "delete_project" }));
    return id;
  }

  it("purges vectors, the workspace, the rows and the project", async () => {
    await del();

    expect(deps.deleteProjectVectors).toHaveBeenCalledWith("p1");
    expect(deps.removeWorkspace).toHaveBeenCalledWith("p1");
    expect(prismaMock.project.delete).toHaveBeenCalledWith({ where: { id: "p1" } });
    // apiKey and evalQuestion are removed explicitly; the rest cascade.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    const [ops] = prismaMock.$transaction.mock.calls[0] as [unknown[]];
    expect(ops).toHaveLength(3);
  });

  // Redis outlives the database. A queued incremental_index for a project that
  // no longer exists is still handed to a worker, which then indexes a missing
  // project and burns every retry on a foreign key violation.
  it("removes the sibling BullMQ jobs the delete left behind", async () => {
    await del();
    expect(deps.removeQueueJobs).toHaveBeenCalledWith(["job-2", "job-3"]);
  });

  it("refuses a delete with no project", async () => {
    await expect(del(null)).rejects.toThrow("delete_project requires a project");
    expect(deps.deleteProjectVectors).not.toHaveBeenCalled();
  });
});
