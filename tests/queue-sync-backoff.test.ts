import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hermetic tests for the scheduled-sync failure backoff.
 *
 * `status: { not: "error" }` on the project row never fires for a repository
 * whose credentials were revoked or whose branch was deleted: the sync job
 * throws before any project status is written, so the sweep re-enqueued it
 * every SYNC_SWEEP_INTERVAL_MS forever. The streak helpers are what stop that.
 *
 * Prisma, BullMQ and ioredis are mocked at the module boundary: no database,
 * no Redis, no network.
 */

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
  isSyncRetryAllowed,
  syncFailureStreak,
  syncRetryDelayMs,
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_MAX_MS,
} = await import("@/lib/jobs/queue");

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);
const HOUR = 3600_000;

/** A repository_sync job row as the streak reader sees it. */
function attempt(status: string, ageMs: number, now = NOW) {
  const at = new Date(now - ageMs);
  return { status, createdAt: at, completedAt: status === "queued" || status === "running" ? null : at };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.job.create.mockImplementation(async () => ({ id: "job-1" }));
  db.job.findFirst.mockResolvedValue(null);
  db.job.findMany.mockResolvedValue([]);
  db.project.findMany.mockResolvedValue([]);
  db.job.deleteMany.mockResolvedValue({ count: 0 });
  bull.getJob.mockResolvedValue(null);
});

describe("syncFailureStreak", () => {
  it("counts the leading run of failures, newest first", () => {
    const streak = syncFailureStreak([attempt("failed", 0), attempt("failed", HOUR), attempt("completed", 2 * HOUR)]);
    expect(streak.failures).toBe(2);
  });

  // A single success ends the run: the repository is healthy again, and the
  // delay has to fall back to nothing.
  it("stops counting at the first non-failure", () => {
    const streak = syncFailureStreak([attempt("failed", 0), attempt("completed", HOUR), attempt("failed", 2 * HOUR)]);
    expect(streak.failures).toBe(1);
  });

  it("reports when the newest failure finished", () => {
    const streak = syncFailureStreak([attempt("failed", HOUR)]);
    expect(streak.lastFailureAt?.getTime()).toBe(NOW - HOUR);
  });

  it("falls back to createdAt when completedAt is null", () => {
    const streak = syncFailureStreak([{ status: "failed", createdAt: new Date(NOW - 5 * HOUR), completedAt: null }]);
    expect(streak.lastFailureAt?.getTime()).toBe(NOW - 5 * HOUR);
  });

  it("sees no streak for an empty or healthy history", () => {
    expect(syncFailureStreak([])).toEqual({ failures: 0, lastFailureAt: null });
    expect(syncFailureStreak([attempt("completed", 0), attempt("completed", HOUR)]).failures).toBe(0);
  });

  // Past the probe limit the delay is pinned at the cap, so the exact count
  // stops changing the outcome — but it must not read as "healthy".
  it("still reports a streak when the history is longer than the probe limit", () => {
    const many = Array.from({ length: 30 }, () => attempt("failed", 0));
    expect(syncFailureStreak(many, 12).failures).toBe(12);
  });
});

describe("syncRetryDelayMs", () => {
  it("is zero with no failures", () => {
    expect(syncRetryDelayMs(0)).toBe(0);
    expect(syncRetryDelayMs(-1)).toBe(0);
  });

  it("doubles per consecutive failure", () => {
    expect(syncRetryDelayMs(1)).toBe(SYNC_RETRY_BASE_MS);
    expect(syncRetryDelayMs(2)).toBe(SYNC_RETRY_BASE_MS * 2);
    expect(syncRetryDelayMs(3)).toBe(SYNC_RETRY_BASE_MS * 4);
  });

  it("is capped, so a permanently broken repo is still retried occasionally", () => {
    expect(syncRetryDelayMs(50)).toBe(SYNC_RETRY_MAX_MS);
  });

  // A streak longer than the cap must not overflow to Infinity and pin the
  // repository out of the sweep for good.
  it("stays finite for an absurd streak", () => {
    expect(Number.isFinite(syncRetryDelayMs(1000))).toBe(true);
    expect(syncRetryDelayMs(1000)).toBe(SYNC_RETRY_MAX_MS);
  });
});

describe("isSyncRetryAllowed", () => {
  it("always allows a repository that has not failed", () => {
    expect(isSyncRetryAllowed({ failures: 0, lastFailureAt: null }, NOW)).toBe(true);
  });

  it("blocks a retry inside the delay window", () => {
    expect(
      isSyncRetryAllowed({ failures: 1, lastFailureAt: new Date(NOW - HOUR) }, NOW),
    ).toBe(false);
  });

  it("allows the retry once the delay has elapsed", () => {
    expect(
      isSyncRetryAllowed({ failures: 1, lastFailureAt: new Date(NOW - SYNC_RETRY_BASE_MS) }, NOW),
    ).toBe(true);
  });

  // A missing timestamp is a bookkeeping gap, not a reason to abandon a
  // repository: attempt, and let the streak it earns gate the next sweep.
  it("allows an attempt when the last failure has no timestamp", () => {
    expect(isSyncRetryAllowed({ failures: 4, lastFailureAt: null }, NOW)).toBe(true);
  });
});

describe("enqueueScheduledSyncs backoff", () => {
  it("skips a repository whose failures are still inside the backoff window", async () => {
    db.project.findMany.mockResolvedValue([{ id: "p1", repository: { lastSuccessfulSync: null } }]);
    db.job.findMany.mockResolvedValue([attempt("failed", HOUR), attempt("failed", 7 * HOUR)]);

    await expect(enqueueScheduledSyncs(NOW)).resolves.toBe(0);
    expect(bull.add).not.toHaveBeenCalled();
  });

  it("retries the same repository once the backoff has elapsed", async () => {
    db.project.findMany.mockResolvedValue([{ id: "p1", repository: { lastSuccessfulSync: null } }]);
    db.job.findMany.mockResolvedValue([attempt("failed", 2 * SYNC_RETRY_BASE_MS)]);

    await expect(enqueueScheduledSyncs(NOW)).resolves.toBe(1);
    expect(bull.add).toHaveBeenCalledTimes(1);
  });

  // A repo whose indexing errored once must not be backed off: a later
  // successful sync resets the streak and it is swept normally again.
  it("resumes sweeping after a success", async () => {
    db.project.findMany.mockResolvedValue([{ id: "p1", repository: { lastSuccessfulSync: null } }]);
    db.job.findMany.mockResolvedValue([attempt("completed", HOUR), attempt("failed", 2 * HOUR)]);

    await expect(enqueueScheduledSyncs(NOW)).resolves.toBe(1);
  });

  it("reads the streak for this project only, newest first and bounded", async () => {
    db.project.findMany.mockResolvedValue([{ id: "p1", repository: { lastSuccessfulSync: null } }]);
    await enqueueScheduledSyncs(NOW);

    const query = db.job.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ projectId: "p1", type: "repository_sync" });
    expect(query.orderBy).toEqual({ createdAt: "desc" });
    expect(query.take).toBeGreaterThan(0);
    expect(query.take).toBeLessThanOrEqual(50);
  });

  // The streak query is an extra round trip per due project; it must not run
  // for a project already known to be in flight.
  it("does not read the streak for a project with an active job", async () => {
    db.project.findMany.mockResolvedValue([{ id: "p1", repository: { lastSuccessfulSync: null } }]);
    db.job.findFirst.mockResolvedValue({ id: "job-running" });

    await expect(enqueueScheduledSyncs(NOW)).resolves.toBe(0);
    expect(db.job.findMany).not.toHaveBeenCalled();
  });
});
