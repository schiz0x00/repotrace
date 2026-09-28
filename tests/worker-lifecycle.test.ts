import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Worker lifecycle: when a job stops being schedulable, and when a cancel is
 * actually honoured.
 *
 * Covered:
 * - `reapOrphanedJobs` against the stall case: a PostgreSQL row that still says
 *   work is owed while BullMQ holds an entry it will never deliver again. That
 *   entry *exists*, so an existence check calls the job healthy; BullMQ fails it
 *   for stalling without invoking the processor, so nothing in this codebase
 *   ever writes the row, and `dedupe` then hands the dead row's id back to every
 *   later enqueue for that (project, type).
 * - `isSchedulableBullState` / `isPastReapFloor`, the two decisions that sweep
 *   rests on.
 * - Cancellation for the job types whose handlers do not poll the pipeline:
 *   `repository_sync` (which used to pass `() => Promise.resolve(false)`) and
 *   `delete_project`, plus the terminal write in the processor that keeps a
 *   late cancel from being overwritten with `completed`.
 *
 * Not covered: BullMQ's own Lua, and the SIGTERM drain (that is
 * `tests/worker-shutdown-grace.test.ts`).
 *
 * Hermetic: Prisma, ioredis, the BullMQ `Queue` and the BullMQ `Worker` are all
 * mocked at the module boundary. No database, no Redis, no network, no port.
 */

const db = vi.hoisted(() => ({
  job: {
    findMany: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []),
    findFirst: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
    findUnique: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
    create: vi.fn(),
    update: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({})),
    updateMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: 0 })),
    deleteMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: 0 })),
  },
  project: {
    findUnique: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
    update: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({})),
    delete: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({})),
  },
  repository: { update: vi.fn(async () => ({})) },
  apiKey: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  evalQuestion: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  $transaction: vi.fn(async (ops: unknown) => Promise.all(ops as Promise<unknown>[])),
}));

vi.mock("dotenv/config", () => ({}));

vi.mock("@/lib/env", () => ({
  env: () => ({
    REDIS_URL: "redis://127.0.0.1:6379",
    WORKER_CONCURRENCY: 1,
    JOB_MAX_ATTEMPTS: 3,
    JOB_RETRY_BACKOFF_MS: 1_000,
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: () => db,
  disconnectPrisma: async () => {},
}));

vi.mock("ioredis", () => ({
  default: class {
    on() {
      return this;
    }
  },
}));

/**
 * The BullMQ job entries the fake queue hands back, keyed by id. A test puts
 * one in place to describe the state the job is in; the reaper's whole job is
 * to read that state and act on it.
 */
const bullJobs = vi.hoisted(() => new Map<string, { state: string; removed: boolean }>());

/** Ids `Queue.add` was called with, in order. */
const added = vi.hoisted(() => [] as string[]);

const bullQueue = vi.hoisted(() => ({
  getJob: vi.fn<(id: string) => Promise<unknown>>(async () => null),
  add: vi.fn<(name: string, data: { jobId: string }) => Promise<unknown>>(
    async () => undefined,
  ),
  getWaitingCount: async () => 0,
  getActiveCount: async () => 0,
  getDelayedCount: async () => 0,
  getJobs: async () => [],
}));

/**
 * The processor `startWorker` hands to BullMQ, captured so a test can invoke it
 * directly. `on("closed", …)` is wired so the test's `afterEach` clears the
 * worker's intervals.
 */
const workerCtl = vi.hoisted(() => ({
  processor: null as
    | ((job: unknown, token?: string, signal?: AbortSignal) => Promise<unknown>)
    | null,
}));

vi.mock("bullmq", () => {
  class Queue {
    getJob = bullQueue.getJob;
    add = bullQueue.add;
    getWaitingCount = bullQueue.getWaitingCount;
    getActiveCount = bullQueue.getActiveCount;
    getDelayedCount = bullQueue.getDelayedCount;
    getJobs = bullQueue.getJobs;
  }
  class Worker {
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(_name: string, processor: typeof workerCtl.processor) {
      workerCtl.processor = processor;
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }
    async close() {
      // Firing "closed" is what clears the worker's intervals, so every test
      // that starts a worker has to close it.
      for (const handler of this.handlers.get("closed") ?? []) handler();
    }
  }
  return { Queue, Worker };
});

const pipeline = vi.hoisted(() => ({
  runIndexJob: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ filesProcessed: 1 })),
  syncRepository: vi.fn<(...args: unknown[]) => Promise<string>>(async () => "/tmp/workspace"),
}));

vi.mock("@/lib/indexing/pipeline", () => ({
  runIndexJob: pipeline.runIndexJob,
  syncRepository: pipeline.syncRepository,
  CancelledError: class CancelledError extends Error {
    constructor() {
      super("Job cancelled");
    }
  },
}));

const qdrant = vi.hoisted(() => ({ deleteProjectVectors: vi.fn(async () => {}) }));
vi.mock("@/lib/qdrant", () => qdrant);
vi.mock("@/lib/git/workspace", () => ({ removeWorkspace: vi.fn(async () => {}) }));
vi.mock("@/lib/git/git", () => ({ currentHead: vi.fn(async () => "abc123") }));
vi.mock("@/lib/metrics", () => ({ pruneMetrics: vi.fn(async () => 0), recordMetric: vi.fn(async () => {}) }));
vi.mock("@/lib/indexing/parser", () => ({ preloadGrammars: vi.fn(async () => {}) }));

/**
 * The real reaper and its helpers, with only the process-level entrypoints
 * stubbed. `enqueueJob` is replaced so the worker's `repository_sync` handler
 * can be watched without a database; the module-private `addToQueue` the reaper
 * uses is not stubbed, so the reaper's Redis behaviour stays the real code path
 * against the fake queue.
 */
const queueModule = await vi.importActual<typeof import("@/lib/jobs/queue")>("@/lib/jobs/queue");
const enqueueJob = vi.fn(async () => "enqueued-job");
vi.mock("@/lib/jobs/queue", () => ({
  ...queueModule,
  enqueueJob: (...args: unknown[]) => enqueueJob(...(args as [])),
  jobQueue: () => bullQueue,
  redisConnection: () => ({}),
}));

const worker = await import("@/worker/index");
const {
  isSchedulableBullState,
  isPastReapFloor,
  reapOrphanedJobs,
  REAP_ORPHAN_FLOOR_MS,
} = queueModule;
type ReapCandidate = import("@/lib/jobs/queue").ReapCandidate;
const { makeCancellationProbe, terminalStatusAfterRun } = worker;

/** Job rows, keyed by id, as the fake Prisma holds them. */
let rows: Map<string, Record<string, unknown>>;

const OLD = 60 * 60_000;
const old = () => new Date(Date.now() - OLD);

/** Installs one reapable row and returns it. */
function seedRow(
  id: string,
  status: "queued" | "running" | "completed" | "failed" | "cancelled",
): Record<string, unknown> {
  const row = {
    id,
    type: "repository_sync",
    projectId: "p1",
    status,
    progress: 0,
    error: null as string | null,
    createdAt: old(),
    startedAt: status === "running" ? old() : null,
    metadata: null,
  };
  rows.set(id, row);
  return row;
}

/** The BullMQ entry for a job, in the given state. */
function seedBull(id: string, state: string): { state: string; removed: boolean } {
  const entry = { state, removed: false };
  bullJobs.set(id, entry);
  return entry;
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, so the defaults are re-stated: a test
  // that makes the sync fail must not leak that into the next one.
  pipeline.syncRepository.mockImplementation(async () => "/tmp/workspace");
  pipeline.runIndexJob.mockImplementation(async () => ({ filesProcessed: 1 }));
  bullJobs.clear();
  added.length = 0;
  rows = new Map();
  // The reaper makes two passes — `queued` then `running` — and each names the
  // status it wants in the query, so the fake dispatches on it.
  db.job.findMany.mockImplementation(async (args: unknown) => {
    const { where } = args as { where: { status: string } };
    return [...rows.values()].filter((r) => r.status === where.status);
  });
  db.job.findUnique.mockImplementation(async (args: unknown) => {
    const { where } = args as { where: { id: string } };
    return rows.get(where.id) ?? null;
  });
  db.job.update.mockImplementation(async (args: unknown) => {
    const { where, data } = args as { where: { id: string }; data: Record<string, unknown> };
    const row = rows.get(where.id);
    if (!row) throw Object.assign(new Error("not found"), { code: "P2025" });
    Object.assign(row, data);
    return row;
  });
  // The reaper resets a stranded `running` row with a compare-and-set, so
  // updateMany has to honour the status in the WHERE and report how many rows
  // it actually changed. A mock that always returns 0 would make the reaper
  // look like it had lost every race, and the test would pass for the wrong
  // reason.
  db.job.updateMany.mockImplementation(async (args: unknown) => {
    const { where, data } = args as {
      where: { id: string; status?: string };
      data: Record<string, unknown>;
    };
    const row = rows.get(where.id);
    if (!row) return { count: 0 };
    if (where.status !== undefined && row.status !== where.status) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  bullQueue.getJob.mockImplementation(async (id: string) => {
    const entry = bullJobs.get(id);
    if (!entry) return null;
    return {
      getState: async () => entry.state,
      remove: async () => {
        entry.removed = true;
        bullJobs.delete(id);
      },
    };
  });
  bullQueue.add.mockImplementation(async (_name: string, data: { jobId: string }) => {
    added.push(data.jobId);
    if (!bullJobs.has(data.jobId)) bullJobs.set(data.jobId, { state: "waiting", removed: false });
    return { id: data.jobId };
  });
});

describe("isSchedulableBullState", () => {
  // The distinction the reaper turns on. Every state here can still reach a
  // processor; the rest cannot, however present the entry looks.
  it.each(["waiting", "active", "delayed", "prioritized", "waiting-children"])(
    "treats %s as still deliverable",
    (state) => expect(isSchedulableBullState(state)).toBe(true),
  );

  // `failed` is the stall case. `completed` is a job whose processor ran and
  // whose terminal row write then failed. `unknown` is BullMQ saying it has no
  // idea. `null`/`undefined` is no entry at all.
  it.each(["failed", "completed", "unknown", "", null, undefined])(
    "treats %s as not deliverable",
    (state) => expect(isSchedulableBullState(state)).toBe(false),
  );
});

describe("isPastReapFloor", () => {
  const floor = new Date(Date.now() - REAP_ORPHAN_FLOOR_MS);
  const row = (over: Partial<ReapCandidate>): ReapCandidate => ({
    status: "queued",
    createdAt: old(),
    startedAt: null,
    ...over,
  });

  it("reaps a queued row past the floor", () => {
    expect(isPastReapFloor(row({}), floor)).toBe(true);
  });

  it("holds off a row created inside the floor", () => {
    expect(isPastReapFloor(row({ createdAt: new Date() }), floor)).toBe(false);
  });

  // `running` cannot be swept on `createdAt` alone: a job created hours ago may
  // have started a minute ago and be indexing right now. That is why the second
  // pass measures `startedAt` instead.
  it("measures the floor on startedAt when asked to", () => {
    expect(
      isPastReapFloor(
        row({ status: "running", createdAt: old(), startedAt: new Date(Date.now() - 1_000) }),
        floor,
        "startedAt",
      ),
    ).toBe(false);
  });

  it("reaps a run that started before the floor", () => {
    expect(
      isPastReapFloor(row({ status: "running", startedAt: old() }), floor, "startedAt"),
    ).toBe(true);
  });

  // A `running` row with no `startedAt` never started, so the row's own age is
  // the only measure there is. Refusing to reap it would strand exactly the rows
  // most likely to be stranded.
  it("falls back to createdAt for a running row with no startedAt", () => {
    expect(isPastReapFloor(row({ status: "running" }), floor, "startedAt")).toBe(true);
  });
});

describe("reapOrphanedJobs", () => {
  it("re-enqueues a queued row whose BullMQ entry never existed", async () => {
    seedRow("j1", "queued");

    await expect(reapOrphanedJobs()).resolves.toBe(1);
    expect(added).toEqual(["j1"]);
    // A `queued` row is already in the right state, so it is not rewritten: the
    // reaper must not clobber a status the worker wrote after this row was read.
    expect(db.job.update).not.toHaveBeenCalled();
  });

  // The finding this sweep exists for. Two worker restarts inside one job's lock
  // lifetime push the stall counter past `maxStalledCount`; BullMQ then stamps
  // `failedReason` and refuses the job on the next delivery *without calling the
  // processor*, so the row is never written. The finished entry stays in Redis
  // under `removeOnFail`, so `getJob` returns it — and an existence check calls
  // the job healthy, forever.
  it("re-enqueues a queued row whose BullMQ entry has already failed", async () => {
    seedRow("j1", "queued");
    const dead = seedBull("j1", "failed");

    await expect(reapOrphanedJobs()).resolves.toBe(1);
    // The dead entry has to go first: `Queue.add` short-circuits on an id that
    // already exists, so re-adding over it would report success and do nothing.
    expect(dead.removed).toBe(true);
    expect(added).toEqual(["j1"]);
    expect(bullJobs.get("j1")?.state).toBe("waiting");
  });

  it("re-enqueues a queued row whose BullMQ entry has already completed", async () => {
    seedRow("j1", "queued");
    seedBull("j1", "completed");

    await expect(reapOrphanedJobs()).resolves.toBe(1);
    expect(added).toEqual(["j1"]);
  });

  it("rescues a running row left behind by a killed worker", async () => {
    seedRow("j1", "running");
    seedBull("j1", "failed");

    await expect(reapOrphanedJobs()).resolves.toBe(1);
    expect(added).toEqual(["j1"]);
    // The row has to go back to `queued`: `running` is not in PRUNABLE_STATUSES,
    // so it would never age out, and the dashboard would show a job in flight
    // forever.
    expect(rows.get("j1")).toMatchObject({ status: "queued", progress: 0, error: null });
  });

  it("rescues a running row with no BullMQ entry at all", async () => {
    seedRow("j1", "running");

    await expect(reapOrphanedJobs()).resolves.toBe(1);
    expect(rows.get("j1")).toMatchObject({ status: "queued" });
  });

  it("leaves a job the queue is still holding", async () => {
    seedRow("j1", "queued");
    const live = seedBull("j1", "waiting");

    await expect(reapOrphanedJobs()).resolves.toBe(0);
    expect(added).toEqual([]);
    expect(live.removed).toBe(false);
  });

  // The case that makes sweeping `running` rows safe: a full reindex of a large
  // repository is legitimately older than the floor and legitimately active.
  it("leaves a long-running index alone", async () => {
    seedRow("j1", "running");
    seedBull("j1", "active");

    await expect(reapOrphanedJobs()).resolves.toBe(0);
    expect(added).toEqual([]);
    expect(rows.get("j1")).toMatchObject({ status: "running" });
  });

  // A job between attempts sits `delayed` on the retry backoff, still owned by
  // BullMQ. Re-adding it would restart its attempt count every sweep.
  it("leaves a delayed retry alone", async () => {
    seedRow("j1", "running");
    seedBull("j1", "delayed");

    await expect(reapOrphanedJobs()).resolves.toBe(0);
    expect(added).toEqual([]);
  });

  it("leaves a run that only just started alone", async () => {
    const row = seedRow("j1", "running");
    row.startedAt = new Date(Date.now() - 1_000);
    seedBull("j1", "failed");

    await expect(reapOrphanedJobs()).resolves.toBe(0);
    expect(added).toEqual([]);
    expect(rows.get("j1")).toMatchObject({ status: "running" });
  });

  it("never resurrects a terminal row", async () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      seedRow("j1", status);
      await expect(reapOrphanedJobs()).resolves.toBe(0);
    }
    expect(added).toEqual([]);
  });

  // A finished entry that will not budge is the honest-failure case: BullMQ
  // refuses to remove a locked job, and the re-add over the surviving id would
  // be a silent no-op. Neither is counted, and the row says why.
  it("does not count a repair it could not make", async () => {
    seedRow("j1", "queued");
    seedBull("j1", "failed");
    bullQueue.getJob.mockImplementation(async (id: string) => {
      const entry = bullJobs.get(id);
      if (!entry) return null;
      return {
        getState: async () => entry.state,
        remove: async () => {
          throw new Error("Job could not be removed because it is locked");
        },
      };
    });

    await expect(reapOrphanedJobs()).resolves.toBe(0);
    expect(added).toEqual([]);
    expect(rows.get("j1")?.error).toMatch(/could not be removed because it is locked/);
    expect(rows.get("j1")).toMatchObject({ status: "queued" });
  });

  // An entry whose state cannot be read is left alone. Existence is treated as
  // liveness on purpose: re-adding over an entry BullMQ still owns is at best a
  // no-op and at worst a second copy of the same work against the same git
  // workspace.
  it("leaves an entry alone when its state cannot be read", async () => {
    seedRow("j1", "queued");
    const live = seedBull("j1", "failed");
    bullQueue.getJob.mockResolvedValue({
      getState: async () => {
        throw new Error("redis down");
      },
      remove: vi.fn(async () => {}),
    });

    await expect(reapOrphanedJobs()).resolves.toBe(0);
    expect(added).toEqual([]);
    expect(live.removed).toBe(false);
  });

  // A failed lookup is not evidence that the job is live. Attempting the
  // re-add is safe — BullMQ deduplicates on the job id — and if Redis really is
  // down the add fails too, which is what the next test pins.
  it("attempts the re-add when the lookup itself fails", async () => {
    seedRow("j1", "queued");
    bullQueue.getJob.mockRejectedValue(new Error("redis down"));

    await expect(reapOrphanedJobs()).resolves.toBe(1);
    expect(added).toEqual(["j1"]);
  });

  it("records the reason and tries again next sweep when Redis is unreachable", async () => {
    seedRow("j1", "queued");
    bullQueue.getJob.mockRejectedValue(new Error("redis down"));
    bullQueue.add.mockRejectedValue(new Error("READONLY redis://user:hunter2@cache:6379"));

    await expect(reapOrphanedJobs()).resolves.toBe(0);
    expect(String(rows.get("j1")?.error)).toContain(
      "Orphaned job could not be re-enqueued",
    );
    // The connection URL can carry the password; it must not reach the row.
    expect(String(rows.get("j1")?.error)).not.toContain("hunter2");
    // Status is untouched, so the row stays reapable.
    expect(rows.get("j1")).toMatchObject({ status: "queued" });
  });

  it("does not abort the sweep because one row is unreachable", async () => {
    seedRow("j1", "queued");
    seedRow("j2", "queued");
    seedBull("j2", "failed");
    bullQueue.getJob.mockImplementation(async (id: string) => {
      if (id === "j1") throw new Error("redis down");
      const entry = bullJobs.get(id);
      if (!entry) return null;
      return { getState: async () => entry.state, remove: async () => { bullJobs.delete(id); } };
    });
    bullQueue.add.mockImplementation(async (_name: string, data: { jobId: string }) => {
      if (data.jobId === "j1") throw new Error("redis down");
      added.push(data.jobId);
      bullJobs.set(data.jobId, { state: "waiting", removed: false });
      return { id: data.jobId };
    });

    await expect(reapOrphanedJobs()).resolves.toBe(1);
    expect(added).toEqual(["j2"]);
    expect(rows.get("j1")?.error).toContain("Orphaned job could not be re-enqueued");
  });

  // The two populations are swept separately so the `running` one can be held
  // to the stricter floor. Each query names the single status it wants.
  it("asks for the two populations in two queries", async () => {
    seedRow("j1", "queued");
    seedRow("j2", "running");

    await reapOrphanedJobs();
    const statuses = db.job.findMany.mock.calls.map(
      (call) => (call as unknown as [{ where: { status: unknown } }])[0].where.status,
    );
    expect(statuses).toEqual(["queued", "running"]);
  });
});

describe("makeCancellationProbe", () => {
  beforeEach(() => {
    seedRow("j1", "running");
    db.job.findMany.mockResolvedValue([]);
  });

  it("is false while the row says running", async () => {
    await expect(makeCancellationProbe("j1")()).resolves.toBe(false);
  });

  it("is true once the row is cancelled", async () => {
    rows.get("j1")!.status = "cancelled";
    await expect(makeCancellationProbe("j1")()).resolves.toBe(true);
  });

  it("is true on an aborted signal, without a database round trip", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(makeCancellationProbe("j1", controller.signal)()).resolves.toBe(true);
  });

  // A row deleted out from under the job — a `delete_project` cascade, say —
  // must not read as a cancellation, or every handler would abort.
  it("is false when the row is gone", async () => {
    rows.delete("j1");
    await expect(makeCancellationProbe("j1")()).resolves.toBe(false);
  });
});

describe("terminalStatusAfterRun", () => {
  // A cancel that lands between the handler's last poll and the terminal write
  // is still a cancel the operator was told about.
  it("keeps a cancel that landed as the run finished", () => {
    expect(terminalStatusAfterRun("cancelled")).toBe("cancelled");
  });

  it.each(["running", "queued", "completed", null, undefined])(
    "records %s as completed",
    (status) => expect(terminalStatusAfterRun(status)).toBe("completed"),
  );
});

/** Builds a BullMQ job as the processor sees one. */
function fakeJob(
  jobId: string,
  type: string,
  projectId: string | null = "p1",
  attemptsMade = 0,
): Record<string, unknown> {
  return {
    id: jobId,
    name: type,
    data: { jobId, projectId, type },
    attemptsMade,
    opts: { attempts: 3 },
    updateProgress: vi.fn(async () => {}),
  };
}

/** The processor `startWorker` registered, or a thrown error if it never did. */
function processor(): NonNullable<typeof workerCtl.processor> {
  if (!workerCtl.processor) throw new Error("startWorker() was never called");
  return workerCtl.processor;
}

describe("worker cancellation", () => {
  /** The fake Worker startWorker returned, closed in afterEach. */
  let started: { close: () => Promise<void> };

  beforeEach(() => {
    // startWorker installs three intervals; closing the worker fires the
    // "closed" handler that clears them, so every test does that on the way out.
    started = worker.startWorker() as unknown as { close: () => Promise<void> };
    seedRow("j1", "running");
    seedRow("sync1", "running");
    db.project.findUnique.mockResolvedValue({
      id: "p1",
      repository: {
        id: "r1",
        url: "https://example.invalid/x.git",
        branch: "main",
        provider: "github",
        credentialsEncrypted: null,
        lastKnownCommit: "old-sha",
      },
    });
  });

  afterEach(async () => {
    await started.close();
  });

  describe("repository_sync", () => {
    it("gives the fetch a probe that can actually see a cancel", async () => {
      // It used to pass `() => Promise.resolve(false)`, which told the
      // pipeline no cancel had ever been requested. A cancel issued mid-fetch
      // was then dropped, the endpoint answered `cancelled: true`, and the
      // fetch — plus the index it enqueues — ran to completion anyway.
      await processor()(fakeJob("sync1", "repository_sync"), "token");
      const probe = (pipeline.syncRepository.mock.calls[0] as unknown[])[5] as () => Promise<boolean>;
      expect(typeof probe).toBe("function");

      rows.get("sync1")!.status = "cancelled";
      await expect(probe()).resolves.toBe(true);
    });

    it("does not start once the row is already cancelled", async () => {
      rows.get("sync1")!.status = "cancelled";
      await expect(processor()(fakeJob("sync1", "repository_sync"), "token")).resolves.toEqual({
        cancelled: true,
      });
      expect(pipeline.syncRepository).not.toHaveBeenCalled();
    });

    // The pre-flight check covers a job cancelled before it started. This one
    // covers a cancel that arrives *during* the fetch, which is the case the
    // hard-coded `false` probe threw away.
    it("stops after the fetch and does not enqueue a follow-up index", async () => {
      pipeline.syncRepository.mockImplementation(async () => {
        rows.get("sync1")!.status = "cancelled";
        return "/tmp/workspace";
      });

      await expect(processor()(fakeJob("sync1", "repository_sync"), "token")).resolves.toEqual({
        cancelled: true,
      });
      expect(enqueueJob).not.toHaveBeenCalled();
      // The repository row is not written either: nothing irreversible runs
      // past the last safe point.
      expect(db.repository.update).not.toHaveBeenCalled();
    });

    it("runs to completion and enqueues the index when nothing cancels it", async () => {
      const result = await processor()(fakeJob("sync1", "repository_sync"), "token");
      expect(result).toEqual({ synced: true, head: "abc123", reindexed: true });
      expect(enqueueJob).toHaveBeenCalledWith("p1", "incremental_index", {
        dedupe: true,
        metadata: { trigger: "sync", from: "old-sha", to: "abc123" },
      });
      expect(rows.get("sync1")).toMatchObject({ status: "completed", progress: 100 });
    });

    // A sync that legitimately finds nothing new still has to report success.
    it("does not enqueue an index when the head has not moved", async () => {
      db.project.findUnique.mockResolvedValue({
        id: "p1",
        repository: {
          id: "r1",
          url: "https://example.invalid/x.git",
          branch: "main",
          provider: "github",
          credentialsEncrypted: null,
          lastKnownCommit: "abc123",
        },
      });
      const result = await processor()(fakeJob("sync1", "repository_sync"), "token");
      expect(result).toEqual({ synced: true, head: "abc123", reindexed: false });
      expect(enqueueJob).not.toHaveBeenCalled();
    });
  });

  describe("delete_project", () => {
    // The destructive steps cannot be abandoned half-way: vectors are deleted,
    // the workspace removed, then the rows. Polling after the Qdrant delete
    // would report a cancel that could only be honoured by finishing anyway,
    // so the one check is before the first irreversible step.
    it("destroys nothing when the row is already cancelled", async () => {
      seedRow("del1", "running");
      rows.get("del1")!.status = "cancelled";

      await expect(processor()(fakeJob("del1", "delete_project"), "token")).resolves.toEqual({
        cancelled: true,
      });
      expect(qdrant.deleteProjectVectors).not.toHaveBeenCalled();
      expect(db.project.delete).not.toHaveBeenCalled();
    });

    it("deletes when nothing cancelled it", async () => {
      seedRow("del1", "running");
      await expect(processor()(fakeJob("del1", "delete_project"), "token")).resolves.toEqual({
        deleted: true,
      });
      expect(qdrant.deleteProjectVectors).toHaveBeenCalledWith("p1");
      expect(db.project.delete).toHaveBeenCalledWith({ where: { id: "p1" } });
    });
  });

  describe("the terminal write", () => {
    // The general guarantee. Whatever the handler did, a cancel that the
    // endpoint has already reported must not be overwritten with `completed`.
    it("does not overwrite a cancel that landed as the run finished", async () => {
      pipeline.runIndexJob.mockImplementation(async () => {
        rows.get("j1")!.status = "cancelled";
        return { filesProcessed: 3 };
      });

      await expect(processor()(fakeJob("j1", "full_reindex"), "token")).resolves.toEqual({
        cancelled: true,
      });
      expect(rows.get("j1")!.status).toBe("cancelled");
      // And the row is left exactly as the cancel endpoint wrote it: no
      // `progress: 100`, no cleared error.
      expect(rows.get("j1")!.progress).toBe(0);
    });

    it("records completed for a run that was not cancelled", async () => {
      await processor()(fakeJob("j1", "full_reindex"), "token");
      expect(rows.get("j1")).toMatchObject({ status: "completed", progress: 100, stage: "completed" });
    });

    // A handler that finishes after the row is deleted (delete_project's own
    // row goes with the project) must not crash the processor on the re-read.
    it("completes when the row has been cascaded away", async () => {
      rows.delete("j1");
      await expect(processor()(fakeJob("j1", "full_reindex"), "token")).resolves.toEqual({
        filesProcessed: 1,
      });
    });
  });
});

describe("reapOrphanedJobs does not resurrect a finished job", () => {
  // Regression: the reaper reset a stranded `running` row with an
  // unconditional `update({ where: { id } })`. A job that the worker finished
  // between the reaper's findMany and this write had its row flipped from
  // "completed" back to "queued" — while the re-add above it had already put
  // the job back on the queue — so completed work ran a second time and the
  // row ended up describing a run that had already happened.
  it("leaves a row the worker completed in the meantime alone", async () => {
    seedRow("j1", "running");
    // No BullMQ entry, so the reaper decides it is stranded...
    const original = db.job.updateMany.getMockImplementation();
    db.job.updateMany.mockImplementation(async (args: unknown) => {
      // ...and by the time it writes, the worker has moved it to completed.
      rows.get("j1")!.status = "completed";
      return original!(args);
    });
    await reapOrphanedJobs();
    db.job.updateMany.mockImplementation(original!);

    expect(rows.get("j1")!.status).toBe("completed");
    // And the re-added queue entry is taken back out, so the finished job is
    // not executed again on the strength of a stale read.
    expect(bullQueue.getJob).toHaveBeenCalledWith("j1");
  });
});

describe("the reaper does not sustain a crash loop", () => {
  // A plain re-add resets the attempt budget to the configured
  // JOB_MAX_ATTEMPTS, so a job that reliably kills its worker — an
  // out-of-memory index, an upstream that takes the process down — was handed a
  // full fresh budget every sweep. The rescue path was itself the thing
  // keeping the job failing forever.
  it("re-adds with a single attempt rather than a fresh budget", async () => {
    seedRow("j1", "running");
    seedBull("j1", "failed");
    await reapOrphanedJobs();
    const options = (bullQueue.add as unknown as { mock: { calls: unknown[][] } }).mock
      .calls.at(-1)?.[2] as { attempts?: number } | undefined;
    expect(options?.attempts).toBe(1);
  });
});
