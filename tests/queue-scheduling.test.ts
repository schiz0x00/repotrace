import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Hermetic tests for the queue's scheduled-sync sweep, the orphan reaper and
 * the retention prune. Prisma, BullMQ and ioredis are mocked at the module
 * boundary: no database, no Redis, no network.
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

const db = vi.hoisted(() => ({
  job: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
  project: { findMany: vi.fn() },
}));

const bull = vi.hoisted(() => ({
  // Loosely typed: the fake Queue only has to accept whatever the real one
  // would and record the calls.
  add: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined),
  getJob: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
}));

vi.mock("@/lib/prisma", () => ({ prisma: () => db }));
vi.mock("ioredis", () => ({
  default: class {
    on() {
      return this;
    }
  },
}));
vi.mock("bullmq", () => ({
  Queue: class {
    add = bull.add;
    getJob = bull.getJob;
  },
}));

const {
  enqueueScheduledSyncs,
  isSyncDue,
  pruneJobs,
  reapOrphanedJobs,
  removeQueueJobs,
  SYNC_MIN_AGE_MS,
} = await import("@/lib/jobs/queue");

beforeEach(() => {
  vi.clearAllMocks();
  db.job.create.mockImplementation(async () => ({ id: "job-1" }));
  db.job.findFirst.mockResolvedValue(null);
  db.job.findMany.mockResolvedValue([]);
  db.project.findMany.mockResolvedValue([]);
  db.job.deleteMany.mockResolvedValue({ count: 0 });
  bull.getJob.mockResolvedValue(null);
});

describe("isSyncDue", () => {
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);

  it("treats a never-synced repository as due", () => {
    expect(isSyncDue(null, now)).toBe(true);
  });

  it("skips a repository synced inside the window", () => {
    expect(isSyncDue(new Date(now - SYNC_MIN_AGE_MS + 1), now)).toBe(false);
  });

  it("accepts one at the window boundary", () => {
    expect(isSyncDue(new Date(now - SYNC_MIN_AGE_MS), now)).toBe(true);
  });

  it("accepts one synced long ago", () => {
    expect(isSyncDue(new Date(now - 30 * 24 * 3600_000), now)).toBe(true);
  });
});

describe("enqueueScheduledSyncs", () => {
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);

  it("enqueues a sync for a project that has never synced", async () => {
    db.project.findMany.mockResolvedValue([{ id: "p1", repository: { lastSuccessfulSync: null } }]);

    await expect(enqueueScheduledSyncs(now)).resolves.toBe(1);
    expect(bull.add).toHaveBeenCalledTimes(1);
    expect(bull.add.mock.calls[0][1]).toMatchObject({ projectId: "p1", type: "repository_sync" });
    expect(db.job.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ projectId: "p1", type: "repository_sync", status: "queued" }),
      }),
    );
  });

  it("enqueues a sync for a project whose last sync is older than the window", async () => {
    db.project.findMany.mockResolvedValue([
      { id: "p1", repository: { lastSuccessfulSync: new Date(now - SYNC_MIN_AGE_MS - 1) } },
    ]);
    await expect(enqueueScheduledSyncs(now)).resolves.toBe(1);
  });

  it("leaves a recently-synced project alone", async () => {
    db.project.findMany.mockResolvedValue([
      { id: "p1", repository: { lastSuccessfulSync: new Date(now - 1000) } },
    ]);
    await expect(enqueueScheduledSyncs(now)).resolves.toBe(0);
    expect(bull.add).not.toHaveBeenCalled();
  });

  it("skips a project with a job already queued or running", async () => {
    db.project.findMany.mockResolvedValue([{ id: "p1", repository: { lastSuccessfulSync: null } }]);
    db.job.findFirst.mockResolvedValue({ id: "job-existing" });

    await expect(enqueueScheduledSyncs(now)).resolves.toBe(0);
    expect(bull.add).not.toHaveBeenCalled();
  });

  // One project's enqueue failing (Redis blip) must not abandon the rest of the
  // page: otherwise a single outage costs a whole sweep's worth of staleness.
  it("keeps sweeping after one enqueue fails", async () => {
    db.project.findMany.mockResolvedValue([
      { id: "p1", repository: { lastSuccessfulSync: null } },
      { id: "p2", repository: { lastSuccessfulSync: null } },
    ]);
    db.job.create.mockImplementation(async ({ data }: { data: { projectId: string } }) => {
      if (data.projectId === "p1") throw new Error("redis down");
      return { id: "job-2" };
    });

    await expect(enqueueScheduledSyncs(now)).resolves.toBe(1);
    expect(bull.add).toHaveBeenCalledTimes(1);
  });

  // Regression: the sweep filtered on `Project.status`, which the indexing
  // pipeline sets to "error" whenever a run throws — including a cancellation,
  // which is not a failure. Cancelling an index, or having one fail once for a
  // transient reason, therefore removed the project from scheduled syncing
  // permanently: the repository went stale and nothing reported it. The filter
  // belongs on the repository's own sync status, which is only set to "error" by
  // a genuine sync failure.
  it("filters on the repository's sync status, not the project's index status", async () => {
    await enqueueScheduledSyncs(now);
    const where = db.project.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ repository: { is: { syncStatus: { not: "error" } } } });
    expect(where).not.toHaveProperty("status");
    // Ordering by staleness, not by creation: creation order pins the sweep to
    // the same first N projects and starves everything after them.
    expect(db.project.findMany.mock.calls[0][0].orderBy).toEqual({
      repository: { lastSuccessfulSync: { sort: "asc", nulls: "first" } },
    });
  });
});

describe("reapOrphanedJobs", () => {
  it("does nothing when no queued row is old enough", async () => {
    await expect(reapOrphanedJobs()).resolves.toBe(0);
    expect(bull.add).not.toHaveBeenCalled();
    // Nothing was even looked up in Redis: an empty candidate page must not
    // cost a round trip.
    expect(bull.getJob).not.toHaveBeenCalled();
  });

  // The whole reason the reaper exists. `enqueueJob` writes the row and *then*
  // adds to BullMQ; a crash in between leaves a row that `dedupe` hands back to
  // every later enqueue for that (project, type), so the project's queue is
  // wedged with nothing logged. Re-adding under the row's own id is what makes
  // the work happen — and it has to be that id, because the row is the only
  // record of the job.
  it("re-enqueues a queued row that has no BullMQ job", async () => {
    db.job.findMany.mockResolvedValue([{ id: "job-1", type: "full_reindex", projectId: "p1" }]);
    bull.getJob.mockResolvedValue(null);

    await expect(reapOrphanedJobs()).resolves.toBe(1);
    expect(bull.getJob).toHaveBeenCalledWith("job-1");
    expect(bull.add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = bull.add.mock.calls[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(name).toBe("full_reindex");
    expect(data).toEqual({ jobId: "job-1", projectId: "p1", type: "full_reindex" });
    expect(opts).toMatchObject({ jobId: "job-1" });
    // The row is not rewritten: it is already `queued`, and the reaper must not
    // resurrect one the worker has since marked `running` by clearing the row's
    // status. Nothing here touches the status field at all.
    expect(db.job.update).not.toHaveBeenCalled();
  });

  // The other half, and the reason this is a reaper and not a blanket
  // re-enqueue: a job that is genuinely in Redis must be left alone. Re-adding
  // it would either be a no-op (BullMQ refuses a duplicate jobId while the
  // original is active) or, on a queue that has already handed the job to a
  // worker, a second copy of the same work against the same git workspace.
  it("leaves a row alone when its BullMQ job is still live", async () => {
    db.job.findMany.mockResolvedValue([{ id: "job-1", type: "full_reindex", projectId: "p1" }]);
    bull.getJob.mockResolvedValue({ id: "job-1", name: "full_reindex" });

    await expect(reapOrphanedJobs()).resolves.toBe(0);
    expect(bull.getJob).toHaveBeenCalledWith("job-1");
    expect(bull.add).not.toHaveBeenCalled();
  });

  it("reaps each orphan in a mixed page exactly once", async () => {
    db.job.findMany.mockResolvedValue([
      { id: "live", type: "repository_sync", projectId: "p1" },
      { id: "orphan", type: "initial_index", projectId: "p2" },
    ]);
    bull.getJob.mockImplementation((async (id: string) =>
      id === "live" ? { id } : null) as (...args: unknown[]) => Promise<unknown>);

    await expect(reapOrphanedJobs()).resolves.toBe(1);
    expect(bull.add).toHaveBeenCalledTimes(1);
    expect((bull.add.mock.calls[0] as unknown[])[2]).toMatchObject({ jobId: "orphan" });
  });

  // A Redis error on the existence check is not evidence that the job is live.
  // Treating it as "live" would leave the wedge in place forever, silently, for
  // as long as Redis keeps throwing — which is precisely the failure mode the
  // reaper was written to undo.
  it("re-enqueues when the existence check itself fails", async () => {
    db.job.findMany.mockResolvedValue([{ id: "job-1", type: "full_reindex", projectId: "p1" }]);
    bull.getJob.mockRejectedValue(new Error("redis down"));

    await expect(reapOrphanedJobs()).resolves.toBe(1);
    expect(bull.add).toHaveBeenCalledTimes(1);
  });

  // Redis unreachable at the re-add: the row must stay `queued` (so the next
  // sweep retries it) and the reason must be written to the row rather than
  // swallowed — an operator reading the dashboard needs to know this row is
  // stuck and why.
  it("records why an orphan could not be re-enqueued, and keeps sweeping", async () => {
    db.job.findMany.mockResolvedValue([
      { id: "job-1", type: "full_reindex", projectId: "p1" },
      { id: "job-2", type: "initial_index", projectId: "p2" },
    ]);
    bull.add.mockImplementation((async (_n: string, data: { jobId: string }) => {
      if (data.jobId === "job-1") throw new Error("READONLY redis://user:hunter2@cache:6379");
      return undefined;
    }) as (...args: unknown[]) => Promise<unknown>);

    await expect(reapOrphanedJobs()).resolves.toBe(1);

    // The stored message must not carry the Redis password.
    const stored = (db.job.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(stored.where).toEqual({ id: "job-1" });
    expect(stored.data.error).toContain("Orphaned job could not be re-enqueued");
    expect(stored.data.error).not.toContain("hunter2");
    // Status is untouched, so the row stays reapable.
    expect(stored.data).not.toHaveProperty("status");
    // The second orphan was still attempted.
    expect(bull.add).toHaveBeenCalledTimes(2);
  });

  // `running` is never a candidate: a job the worker has picked up is not
  // orphaned, and re-adding it would run the same work twice against the same
  // workspace. The floor on `createdAt` is what keeps a slow-queued job (delayed
  // webhook debounce, a long queue) out of the candidate set.
  it("only considers queued rows past the age floor", async () => {
    await reapOrphanedJobs(60_000);
    const where = (db.job.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(where.status).toBe("queued");
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    // Oldest first, so a backlog of 50 drains in creation order rather than
    // re-picking the same 50 forever.
    expect((db.job.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].orderBy).toEqual({
      createdAt: "asc",
    });
  });
});

describe("pruneJobs", () => {
  it("is a no-op when retention is disabled", async () => {
    await expect(pruneJobs(0)).resolves.toBe(0);
    expect(db.job.deleteMany).not.toHaveBeenCalled();
  });

  // Deleting a queued or running row orphans the BullMQ job that matches it.
  it("only ever targets terminal statuses", async () => {
    db.job.findMany.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);
    db.job.deleteMany.mockResolvedValueOnce({ count: 2 });

    await pruneJobs(30);

    expect(db.job.findMany.mock.calls[0][0].where.status).toEqual({
      in: ["completed", "failed", "cancelled"],
    });
  });

  // Retention means "old job", and a job's age is when it was created. The
  // filter and the sort both have to lead with a column the `job` table's
  // `@@index([status, createdAt])` can serve.
  it("cuts off and sorts on createdAt, not updatedAt", async () => {
    await pruneJobs(30);
    const args = db.job.findMany.mock.calls[0][0];
    expect(args.where.createdAt).toBeDefined();
    expect(args.where.updatedAt).toBeUndefined();
    expect(args.where.completedAt).toBeUndefined();
    expect(args.orderBy).toEqual({ createdAt: "asc" });
  });

  // The reason the cutoff moved off `updatedAt` is the index, so the claim is
  // only worth anything while the index is still in the schema. Whether the
  // planner then walks it is data-dependent and not asserted here; what is
  // asserted is that the query filters and orders on the two indexed columns,
  // leading with `status`, and that the schema still declares that index.
  it("shapes the query to match an index the schema actually declares", async () => {
    const schema = readFileSync(repoFile("prisma/schema.prisma"), "utf8");
    const jobModel = /model Job \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    const indexes = [...jobModel.matchAll(/@@index\(\[([^\]]+)\]\)/g)].map((m) =>
      m[1].split(",").map((c) => c.trim()),
    );

    await pruneJobs(30);
    const args = db.job.findMany.mock.calls[0][0];
    // The index the query is shaped for, in the order the query uses it.
    const shape = Object.keys(args.where);
    expect(indexes).toContainEqual(["status", "createdAt"]);
    expect(shape[0]).toBe("status");
    expect(shape[1]).toBe("createdAt");
    expect(args.where.status).toEqual({ in: ["completed", "failed", "cancelled"] });
  });

  it("deletes in bounded pages rather than one statement", async () => {
    db.job.findMany
      .mockResolvedValueOnce([{ id: "a" }, { id: "b" }])
      .mockResolvedValueOnce([{ id: "c" }]);
    db.job.deleteMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(pruneJobs(30, 2)).resolves.toBe(3);
    expect(db.job.findMany).toHaveBeenCalledTimes(2);
    expect(db.job.deleteMany.mock.calls[0][0]).toEqual({ where: { id: { in: ["a", "b"] } } });
    expect(db.job.deleteMany.mock.calls[1][0]).toEqual({ where: { id: { in: ["c"] } } });
  });

  // Rows deleted by a competing worker would otherwise be re-selected forever.
  it("stops when a page deletes nothing", async () => {
    db.job.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    db.job.deleteMany.mockResolvedValue({ count: 0 });

    await expect(pruneJobs(30, 2)).resolves.toBe(0);
    expect(db.job.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("removeQueueJobs", () => {
  it("does nothing for an empty id list", async () => {
    await expect(removeQueueJobs([])).resolves.toBe(0);
    expect(bull.getJob).not.toHaveBeenCalled();
  });

  it("removes jobs that exist and skips ids that do not", async () => {
    const remove = vi.fn(async () => undefined);
    bull.getJob.mockImplementation((async (id: string) =>
      id === "present" ? { id, remove } : null) as (...args: unknown[]) => Promise<unknown>);

    await expect(removeQueueJobs(["present", "absent"])).resolves.toBe(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  // BullMQ throws for a job a worker still holds. Its row is already gone, so
  // the whole sweep must survive one locked job.
  it("survives a locked job", async () => {
    const remove = vi.fn(async () => {
      throw new Error("Job 1 could not be removed because it is locked by another worker");
    });
    bull.getJob.mockResolvedValue({ id: "1", remove });

    await expect(removeQueueJobs(["1"])).resolves.toBe(0);
  });
});
