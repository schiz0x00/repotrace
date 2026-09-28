import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hermetic coverage for GET /api/v1/health/status.
 *
 * Every dependency the route reaches for is replaced: no Postgres, no Qdrant,
 * no Redis, no embedding API, and no environment file. The suite is about the
 * two properties the route exists to get right — a diagnostic that always
 * answers once the caller is authenticated, and a 401 that is never reported as
 * a broken database — and about the probe ceiling, which cannot be observed
 * without a probe that genuinely never settles.
 *
 * The public sibling (/api/v1/health, covered in audit-fixes.test.ts) has no
 * authentication and no probe ceiling, so neither of those is testable there.
 */

const PROBE_TIMEOUT_MS = 10_000;

const ENV_OK = {
  WORKER_CONCURRENCY: 4,
  EMBEDDING_API_URL: "",
  EMBEDDING_API_KEY: "",
  EMBEDDING_MODEL: "",
};

type Never = "never";
const HANG: Never = "never";

const state = vi.hoisted(() => ({
  /** How `requirePrincipal` behaves. */
  auth: "ok" as "ok" | "unauthorized" | "throws" | typeof HANG,
  /** How the `SELECT 1` probe behaves. */
  postgres: "ok" as "ok" | "refuses" | "throws" | typeof HANG,
  qdrant: { healthy: true, version: "1.19.0" } as { healthy: boolean; version?: string; error?: string },
  depth: 0 as number,
  depthThrows: false,
  repos: [] as Array<{ syncStatus: string }>,
  reposThrows: false,
  activeJobs: 3,
  recentCompleted: 7,
  envThrows: false,
  embeddingConfig: { apiUrl: "", apiKey: "", model: "" } as {
    apiUrl: string;
    apiKey: string;
    model: string;
  },
  embeddingConfigThrows: false,
  /** "ok" | "http500" | never settling. */
  embeddingApi: "ok" as "ok" | "http500" | typeof HANG,
  fetches: [] as string[],
  metrics: [] as Array<{ name: string; value: number }>,
}));

vi.mock("@/lib/api/guard", async () => {
  // Imported inside the factory, not at the top of this file: the route keys
  // its 401-vs-503 split on `cause instanceof AppError`, which only holds while
  // the guard and the route share one instance of @/lib/errors. Reaching for a
  // statically imported class here would hand the route a second copy and turn
  // every 401 into a 503.
  const { unauthorized } = await import("@/lib/errors");
  return {
    requirePrincipal: async (request: Request) => {
      void request;
      if (state.auth === "unauthorized") {
        throw unauthorized("authentication_required", "Authenticate with a session cookie or an API key");
      }
      if (state.auth === "throws") {
        // What a Prisma transport failure looks like to requirePrincipal: a
        // plain Error, not an AppError, so the route cannot mistake it for a
        // rejected credential.
        throw new Error("Timed out trying to reach a server");
      }
      if (state.auth === HANG) {
        return new Promise(() => {});
      }
      return { kind: "session", userId: "u1" } as never;
    },
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: () => ({
    $queryRaw: async () => {
      if (state.postgres === HANG) return new Promise(() => {});
      if (state.postgres === "refuses") throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      if (state.postgres === "throws") throw new Error("P2024 Timed out fetching a connection");
      return [{ "?column?": 1 }];
    },
    repository: {
      findMany: async () => {
        if (state.reposThrows) throw new Error("relation \"Repository\" does not exist");
        return state.repos;
      },
    },
    job: {
      count: async ({ where }: { where?: { status?: unknown } } = {}) => {
        // Two shapes: `{ status: { in: [...] } }` for the active-job probe and
        // `{ status: "completed", completedAt: {...} }` for the recent one.
        const status = where?.status;
        if (typeof status === "string") return status === "completed" ? state.recentCompleted : 0;
        if (status && typeof status === "object" && Array.isArray((status as { in?: unknown }).in)) {
          return state.activeJobs;
        }
        return 0;
      },
    },
  }),
}));

vi.mock("@/lib/qdrant", () => ({
  qdrantHealth: async () => {
    // Thrown rather than returned, to exercise the case the real wrapper
    // already swallows: a throw from inside qdrantHealth must land in the same
    // place as any other probe failure.
    if (state.qdrant.healthy) return state.qdrant;
    throw new Error("qdrant client raised while probing versionInfo");
  },
}));

vi.mock("@/lib/jobs/queue", () => ({
  queueDepth: async () => {
    if (state.depthThrows) throw new Error("ECONNRESET 127.0.0.1:6379");
    return state.depth;
  },
}));

// The route reads env() inside a probe, so a broken configuration has to be
// expressible without breaking module load.
vi.mock("@/lib/env", () => ({
  env: () => {
    if (state.envThrows) throw new Error("Invalid environment configuration: EMBEDDING_MODEL: Required");
    return ENV_OK;
  },
  isTest: () => true,
}));

vi.mock("@/lib/embedding/provider", () => ({
  resolveEmbeddingConfig: async () => {
    if (state.embeddingConfigThrows) throw new Error("column \"embeddingApiKeyEnc\" does not exist");
    return state.embeddingConfig;
  },
}));

vi.mock("@/lib/metrics", () => ({
  recordMetric: async (name: string, value: number) => {
    state.metrics.push({ name, value });
  },
}));

const route = () => import("@/app/api/v1/health/status/route");
const request = () => new Request("http://localhost/api/v1/health/status");

type Body = {
  status: string;
  version: string;
  tookMs: number;
  checks: {
    postgres: { healthy: boolean; error?: string };
    qdrant: { healthy: boolean; version?: string; error?: string };
    queue: { healthy: boolean; depth: number; error?: string };
    embedding: { healthy: boolean; configured: boolean; httpStatus?: number; error?: string };
    repositorySync: { healthy: boolean; repositories: number; failures: number; error?: string };
    workers: {
      activeJobs: number;
      recentCompleted: number;
      configuredConcurrency?: number;
      error?: string;
    };
  };
};

const realFetch = globalThis.fetch;
let consoleError: ReturnType<typeof vi.spyOn>;

/**
 * Runs a request that is waiting on the probe ceiling and steps the fake clock
 * past it. The zero-length steps let the auth promise and the probe promises
 * settle before the clock moves, so the 10s timer exists by the time it jumps.
 */
async function pastTheProbeCeiling<T>(pending: Promise<T>): Promise<T> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
  return pending;
}

beforeEach(() => {
  state.auth = "ok";
  state.postgres = "ok";
  state.qdrant = { healthy: true, version: "1.19.0" };
  state.depth = 0;
  state.depthThrows = false;
  state.repos = [];
  state.reposThrows = false;
  state.activeJobs = 3;
  state.recentCompleted = 7;
  state.envThrows = false;
  state.embeddingConfig = { apiUrl: "", apiKey: "", model: "" };
  state.embeddingConfigThrows = false;
  state.embeddingApi = "ok";
  state.fetches = [];
  state.metrics = [];
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    state.fetches.push(String(input));
    if (state.embeddingApi === HANG) return new Promise(() => {});
    if (state.embeddingApi === "http500") return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  consoleError.mockRestore();
  vi.useRealTimers();
  // Deliberately NOT vi.resetModules(). Vitest caches a mock factory's result,
  // so after a reset the guard mock would still be throwing an AppError built
  // from the previous registry's @/lib/errors while the route reads the new
  // one — `cause instanceof AppError` would be false and every 401 test would
  // see the 503. The route holds no module state, so one instance for the file
  // is both correct and what production does.
});

describe("GET /api/v1/health/status — healthy system", () => {
  it("answers 200 with a complete body for an authenticated caller", async () => {
    state.repos = [{ syncStatus: "ready" }, { syncStatus: "ready" }];
    state.embeddingConfig = { apiUrl: "https://embed.example/v1", apiKey: "sk-test", model: "m" };
    const { GET } = await route();

    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;

    expect(body.status).toBe("healthy");
    expect(body.version).toBe("1.0.0");
    expect(typeof body.tookMs).toBe("number");
    expect(body.checks.postgres).toEqual({ healthy: true });
    expect(body.checks.qdrant).toEqual({ healthy: true, version: "1.19.0" });
    expect(body.checks.queue).toEqual({ healthy: true, depth: 0 });
    expect(body.checks.repositorySync).toEqual({ healthy: true, repositories: 2, failures: 0 });
    expect(body.checks.workers).toEqual({
      activeJobs: 3,
      recentCompleted: 7,
      configuredConcurrency: 4,
    });
    expect(body.checks.embedding).toEqual({ healthy: true, configured: true, httpStatus: 200 });
    // The live probe is a real outbound call to the configured provider, with
    // the base URL's trailing slash trimmed and `/embeddings` appended.
    expect(state.fetches).toEqual(["https://embed.example/v1/embeddings"]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("reports the queue depth as a metric without awaiting the write", async () => {
    state.depth = 12;
    const { GET } = await route();
    await GET(request());
    // Fired and forgotten: the queue check must not be held up by the write.
    expect(state.metrics).toEqual([{ name: "queue_depth", value: 12 }]);
  });

  it("still reports healthy when nothing about the index needs attention", async () => {
    // `status` is the three infrastructure dependencies only, as before: a
    // repository stuck in the error state does not make the service
    // unreachable, and uptime monitoring reads this field.
    state.repos = [{ syncStatus: "ready" }, { syncStatus: "error" }];
    const { GET } = await route();
    const body = (await (await GET(request())).json()) as Body;
    expect(body.status).toBe("healthy");
    expect(body.checks.repositorySync).toEqual({ healthy: false, repositories: 2, failures: 1 });
  });
});

describe("GET /api/v1/health/status — a dependency is down", () => {
  // Once the caller is authenticated the route always answers 200, whatever the
  // infrastructure is doing: `checks.*.healthy` is the signal. A 503 here would
  // make a dashboard poll look like an auth problem.
  it("answers 200 with postgres unhealthy when Postgres refuses connections", async () => {
    state.postgres = "refuses";
    const { GET } = await route();

    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;

    expect(body.status).toBe("degraded");
    expect(body.checks.postgres.healthy).toBe(false);
    expect(body.checks.postgres.error).toMatch(/ECONNREFUSED/);
    // The detail is allowed here (the endpoint is authenticated) and is what
    // the route exists to show.
    expect(JSON.stringify(body)).toMatch(/127\.0\.0\.1:5432/);
    // Nothing else was dragged down by it.
    expect(body.checks.qdrant.healthy).toBe(true);
    expect(body.checks.queue).toEqual({ healthy: true, depth: 0 });
  });

  it("reports a driver timeout as a Postgres failure, not as a healthy probe", async () => {
    // A Prisma timeout throws rather than refusing the connection, so it takes
    // the other branch of the probe — the reason in the body is what tells an
    // operator which of the two they are looking at.
    state.postgres = "throws";
    const { GET } = await route();
    const body = (await (await GET(request())).json()) as Body;
    expect(body.status).toBe("degraded");
    expect(body.checks.postgres).toEqual({
      healthy: false,
      error: "P2024 Timed out fetching a connection",
    });
  });

  it("reports an unhealthy Qdrant with the reason it gave", async () => {
    state.qdrant = { healthy: false, error: "connect ECONNREFUSED 127.0.0.1:6333" };
    const { GET } = await route();
    const body = (await (await GET(request())).json()) as Body;
    expect(body.status).toBe("degraded");
    expect(body.checks.qdrant).toEqual({
      healthy: false,
      // The thrown message, not the `error` qdrantHealth would have returned —
      // the wrapper's own value never exists once it throws.
      error: "qdrant client raised while probing versionInfo",
    });
  });

  it("turns queueDepth's -1 sentinel into an unhealthy queue rather than zero jobs", async () => {
    state.depth = -1;
    const { GET } = await route();
    const body = (await (await GET(request())).json()) as Body;
    expect(body.status).toBe("degraded");
    expect(body.checks.queue).toEqual({ healthy: false, depth: -1, error: "queue depth unavailable" });
  });

  it("reports a queueDepth throw as a queue failure with the reason", async () => {
    state.depthThrows = true;
    const { GET } = await route();
    const body = (await (await GET(request())).json()) as Body;
    expect(body.checks.queue.healthy).toBe(false);
    expect(body.checks.queue.depth).toBe(-1);
    expect(body.checks.queue.error).toMatch(/ECONNRESET/);
  });

  it("does not read repository counts from a database it could not reach", async () => {
    state.reposThrows = true;
    const { GET } = await route();
    const body = (await (await GET(request())).json()) as Body;
    // Zero repositories would read as "healthy, nothing indexed"; the error
    // keeps it from being misread.
    expect(body.checks.repositorySync).toEqual({
      healthy: false,
      repositories: 0,
      failures: 0,
      error: expect.stringMatching(/does not exist/),
    });
  });

  it("surfaces a failed embedding call as an unhealthy check, not a failed request", async () => {
    state.embeddingConfig = { apiUrl: "https://embed.example/v1", apiKey: "", model: "m" };
    state.embeddingApi = "http500";
    const { GET } = await route();
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.checks.embedding).toEqual({ healthy: false, configured: true, httpStatus: 500 });
  });

  it("makes no outbound call when no embedding provider is configured", async () => {
    const { GET } = await route();
    const body = (await (await GET(request())).json()) as Body;
    expect(body.checks.embedding).toEqual({ healthy: false, configured: false });
    expect(state.fetches).toEqual([]);
  });
});

describe("GET /api/v1/health/status — a probe that never settles", () => {
  it("gives up on a wedged Postgres and still answers 200", async () => {
    vi.useFakeTimers();
    state.postgres = HANG;
    const { GET } = await route();

    const res = await pastTheProbeCeiling(GET(request()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;

    expect(body.status).toBe("degraded");
    expect(body.checks.postgres).toEqual({
      healthy: false,
      error: `probe timed out after ${PROBE_TIMEOUT_MS}ms`,
    });
    // The other probes in the same batch were not held up by it.
    expect(body.checks.qdrant.healthy).toBe(true);
    expect(body.checks.queue.healthy).toBe(true);
  });

  it("gives up on an embedding API that never answers", async () => {
    vi.useFakeTimers();
    state.embeddingConfig = { apiUrl: "https://embed.example/v1", apiKey: "", model: "m" };
    state.embeddingApi = HANG;
    const { GET } = await route();

    const res = await pastTheProbeCeiling(GET(request()));
    const body = (await res.json()) as Body;
    expect(res.status).toBe(200);
    // `status` stays "healthy": it is the three infrastructure dependencies
    // only, which is what uptime monitoring reads. The third-party embedding
    // API is a per-check detail, and it is reported as such.
    expect(body.status).toBe("healthy");
    expect(body.checks.embedding).toEqual({
      healthy: false,
      configured: true,
      error: `probe timed out after ${PROBE_TIMEOUT_MS}ms`,
    });
  });

  it("bounds authentication too, and answers 503 when it is the thing that hangs", async () => {
    // Authentication is a Prisma query like any other. Left unbounded, a
    // Postgres that accepts connections and then stops answering hung this
    // endpoint — and the dashboard Health page, which fetches it with the
    // session cookie — so the one diagnostic that would explain the outage was
    // the thing that hung.
    vi.useFakeTimers();
    state.auth = HANG;
    const { GET } = await route();

    const res = await pastTheProbeCeiling(GET(request()));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("diagnostic_unavailable");
    // Reported as infrastructure, not as a per-check detail: nothing was
    // measured, so there is no honest `checks` to return.
    expect(body.checks).toBeUndefined();
  });
});

describe("GET /api/v1/health/status — authentication", () => {
  it("answers 401 for a rejected credential, and does not call it a broken database", async () => {
    state.auth = "unauthorized";
    const { GET } = await route();

    const res = await GET(request());
    expect(res.status).toBe(401);
    const body = await res.json();

    // The AppError is rethrown and rendered by the normal error path.
    expect(body.error.code).toBe("authentication_required");
    expect(body.status).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/diagnostic_unavailable|wedged|503/);
  });

  it("answers 401 without touching a single dependency", async () => {
    state.auth = "unauthorized";
    const { GET } = await route();
    await GET(request());
    // No probe ran, so nothing was called out and no dependency reported a
    // failure: the only log line is the auth check itself, so a bad credential
    // never shows up as a database error.
    expect(state.fetches).toEqual([]);
    expect(state.metrics).toEqual([]);
    expect(consoleError.mock.calls.flat().map(String)).toEqual([
      "[health:status] auth check failed: Authenticate with a session cookie or an API key",
    ]);
  });

  it("answers 503 when authentication fails for a reason that is not a credential", async () => {
    // A plain Error from the auth query is the database being unreachable, not
    // the caller being wrong. Reporting it as a wedged database is the point.
    state.auth = "throws";
    const { GET } = await route();

    const res = await GET(request());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("diagnostic_unavailable");
    expect(body.error.message).toMatch(/database is very likely unreachable or wedged/);
  });

  it("falls back to the environment when the per-project config lookup fails", async () => {
    // The `__probe__` sentinel matches no project, so this query is expected to
    // succeed in production; it is here to cover the failure the route's own
    // comment calls non-fatal. It must not escape the probe and become the
    // request's error.
    state.embeddingConfigThrows = true;
    const { GET } = await route();
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.checks.embedding).toEqual({ healthy: false, configured: false });
  });
});

describe("GET /api/v1/health/status — broken environment", () => {
  it("reports a configuration error as a check and still answers 200", async () => {
    state.envThrows = true;
    const { GET } = await route();

    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.checks.embedding.healthy).toBe(false);
    expect(body.checks.embedding.error).toMatch(/Invalid environment configuration/);
    // WORKER_CONCURRENCY came from the same failed call, so it is omitted
    // rather than reported as a default the route never read.
    expect(body.checks.workers.configuredConcurrency).toBeUndefined();
    // Worker counts did not depend on env() and are still reported.
    expect(body.checks.workers.activeJobs).toBe(3);
    expect(body.checks.workers.recentCompleted).toBe(7);
  });
});
