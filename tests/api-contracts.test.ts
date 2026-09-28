import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hermetic coverage for the v1 API contract surface: what a credential is
 * allowed to see, what a filter is allowed to silently do, and what the routes
 * claim about their own work.
 *
 * Nothing here touches Postgres, Qdrant, Redis or an embedding API. Every
 * dependency a route reaches for is replaced, and the replacement is
 * observable: the assertions are about what the route did with the principal
 * it was handed and what it returned, not about strings in the source.
 */

const state = vi.hoisted(() => ({
  /** The principal `requirePrincipal` / `requireScopedProject` hands back. */
  principal: { type: "session", userId: "u1" } as Record<string, unknown>,
  /** What listProjects returns, before any scoping the route applies. */
  projects: [] as Array<{ id: string; slug: string }>,
  createCalls: 0,
  apiKeyQueries: 0,
  apiKeyRows: [] as Array<{ id: string; keyPrefix: string; projectId: string | null }>,
  searchCalls: [] as Array<{ projectId: string; chunkTypes?: string[] }>,
  /** Counting data behind GET /stats. */
  stats: { failedCount: 0, failedRows: [] as Array<{ path: string; error: string | null }> },
  /** Concurrency observed by the eval scorer. */
  inFlight: 0,
  maxInFlight: 0,
  searchDelayMs: 0,
  evalRows: [] as Array<{ id: string; question: string; expectedFiles: string[] }>,
  evalTotal: 0,
  /** Which liveness probe is wedged, if any. */
  wedged: { postgres: false, qdrant: false, queue: false },
}));

vi.mock("@/lib/api/guard", () => ({
  requirePrincipal: async () => state.principal,
  requireScopedProject: async () => ({
    principal: state.principal,
    project: { id: "p1", slug: "one", repository: { lastKnownCommit: null, lastSuccessfulSync: null } },
  }),
  requireScopedProjectId: async () => "p1",
}));

vi.mock("@/lib/projects/service", () => ({
  listProjects: async () => state.projects,
  createProject: async (input: { name: string }) => {
    state.createCalls++;
    return { id: "new", name: input.name, slug: "new" };
  },
  projectToDto: (p: { id: string; slug: string }) => ({ id: p.id, slug: p.slug }),
  updateProject: async () => ({}),
  deleteProject: async () => "job-1",
}));

vi.mock("@/lib/prisma", () => ({
  prisma: () => ({
    $queryRaw: async () => (state.wedged.postgres ? new Promise(() => {}) : [{ ok: 1 }]),
    apiKey: {
      findMany: async () => {
        state.apiKeyQueries++;
        return state.apiKeyRows;
      },
      updateMany: async () => ({ count: 0 }),
    },
    project: { findFirst: async () => ({ id: "p1" }) },
    file: {
      count: async ({ where }: { where?: { status?: string } } = {}) =>
        where?.status === "failed" ? state.stats.failedCount : 0,
      findMany: async () => state.stats.failedRows,
      groupBy: async () => [],
    },
    symbol: { count: async () => 0 },
    chunk: { count: async () => 0 },
    commit: { count: async () => 0 },
    job: { count: async () => 0 },
    evalQuestion: {
      findMany: async () => state.evalRows,
      count: async () => state.evalTotal,
    },
  }),
}));

vi.mock("@/lib/qdrant", () => ({
  qdrantHealth: async () =>
    state.wedged.qdrant ? new Promise(() => {}) : { healthy: true, version: "1.19.0" },
}));

vi.mock("@/lib/jobs/queue", () => ({
  queueDepth: async () => (state.wedged.queue ? new Promise(() => {}) : 0),
}));

// The chunk type list is derived from the Prisma enum, and the enum is a plain
// object with no side effects — so it is rebuilt here from the same source
// rather than pulled in through the search module, which would drag in the
// database and the vector store.
vi.mock("@/lib/search/search", async () => {
  const { ChunkType } = await import("@/generated/prisma/enums");
  return {
    CHUNK_TYPE_VALUES: Object.values(ChunkType),
    searchProject: async (projectId: string, q: string, opts: { chunkTypes?: string[] }) => {
      state.searchCalls.push({ projectId, chunkTypes: opts.chunkTypes });
      return {
        mode: "hybrid",
        query: q,
        project: { id: projectId, slug: "one", name: "One" },
        items: [],
        sources: { vector: 0, lexical: 0, symbol: 0 },
        tookMs: 1,
      };
    },
  };
});

vi.mock("@/lib/eval/recall", () => ({
  K_VALUES: [5, 10],
  aggregateResults: (results: unknown[]) => ({ questions: results.length, failed: 0 }),
  evaluateQuestion: async (
    projectId: string,
    q: { id: string; query: string; expectedFiles: string[] },
  ) => {
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    state.searchCalls.push({ projectId });
    await new Promise((resolve) => setTimeout(resolve, state.searchDelayMs));
    state.inFlight--;
    return {
      id: q.id,
      query: q.query,
      mode: "hybrid",
      expectedFiles: q.expectedFiles,
      expectedSymbols: [],
      recallFiles: { 5: 1, 10: 1 },
      recallSymbols: {},
      contextHitRate: null,
      topFiles: [],
    };
  },
}));

// @/lib/auth builds a better-auth instance at module scope, which the real
// @/lib/authn imports. Nothing authenticates through it here.
vi.mock("@/lib/mailer", () => ({ sendMail: async () => {} }));

const req = (url: string, init?: RequestInit) => new Request(`http://localhost${url}`, init);
const params = <T,>(value: T) => ({ params: Promise.resolve(value) });

const scopedKey = { type: "api_key", apiKeyId: "k1", projectId: "p1" };
const unscopedKey = { type: "api_key", apiKeyId: "k2", projectId: null };
const session = { type: "session", userId: "u1" };

beforeEach(() => {
  state.principal = session;
  state.projects = [
    { id: "p1", slug: "one" },
    { id: "p2", slug: "two" },
    { id: "p3", slug: "three" },
  ];
  state.createCalls = 0;
  state.apiKeyQueries = 0;
  state.apiKeyRows = [{ id: "k1", keyPrefix: "rt_abcdefgh", projectId: "p1" }];
  state.searchCalls = [];
  state.stats = { failedCount: 0, failedRows: [] };
  state.inFlight = 0;
  state.maxInFlight = 0;
  state.searchDelayMs = 0;
  state.evalRows = [];
  state.evalTotal = 0;
  state.wedged = { postgres: false, qdrant: false, queue: false };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GET /api/v1/projects — a project-scoped API key", () => {
  it("sees only the project it is scoped to", async () => {
    const { GET } = await import("@/app/api/v1/projects/route");
    state.principal = scopedKey;

    const res = await GET(req("/api/v1/projects"));
    expect(res.status).toBe(200);
    const body = await res.json();

    // The principal used to be discarded here, so this returned all three
    // projects — the only listing in the API that ignored the scoping every
    // other route enforces.
    expect(body.projects).toEqual([{ id: "p1", slug: "one" }]);
  });

  it("still narrows when stats are included, rather than skipping the filter", async () => {
    const { GET } = await import("@/app/api/v1/projects/route");
    state.principal = scopedKey;

    const body = await (await GET(req("/api/v1/projects?includeStats=true"))).json();
    expect(body.projects.map((p: { id: string }) => p.id)).toEqual(["p1"]);
  });

  it("sees every project as a session user and as an unscoped key", async () => {
    const { GET } = await import("@/app/api/v1/projects/route");

    state.principal = session;
    expect((await (await GET(req("/api/v1/projects"))).json()).projects).toHaveLength(3);

    // An unscoped key is owner-level by the same rule every other route uses
    // (canAccessProject), so it must not be narrowed here either.
    state.principal = unscopedKey;
    expect((await (await GET(req("/api/v1/projects"))).json()).projects).toHaveLength(3);
  });
});

describe("POST /api/v1/projects — who may create one", () => {
  const body = JSON.stringify({ name: "new", repoUrl: "https://github.com/a/b" });

  it("is refused for a project-scoped key, and creates nothing", async () => {
    const { POST } = await import("@/app/api/v1/projects/route");
    state.principal = scopedKey;

    const res = await POST(req("/api/v1/projects", { method: "POST", body }));
    // 403, not 401: the key is valid, it simply is not allowed to do this.
    expect(res.status).toBe(403);
    const payload = await res.json();
    expect(payload.error.code).toBe("project_create_forbidden");
    // The project it would have created is one that key could then neither
    // list nor reach through any other route.
    expect(state.createCalls).toBe(0);
  });

  it("is allowed for a session and for an unscoped key", async () => {
    const { POST } = await import("@/app/api/v1/projects/route");

    for (const principal of [session, unscopedKey]) {
      state.principal = principal;
      const res = await POST(req("/api/v1/projects", { method: "POST", body }));
      expect(res.status).toBe(201);
      expect((await res.json()).project).toEqual({ id: "new", slug: "new" });
    }
    expect(state.createCalls).toBe(2);
  });
});

describe("/api/v1/api-keys — a key may not manage keys", () => {
  it("refuses to list them for an API key caller, and reads nothing", async () => {
    const { GET } = await import("@/app/api/v1/api-keys/route");
    state.principal = scopedKey;

    const res = await GET(req("/api/v1/api-keys"));
    expect(res.status).toBe(403);
    // Same code and status the POST and DELETE siblings already returned.
    expect((await res.json()).error.code).toBe("forbidden");
    // Not even after the refusal.
    expect(state.apiKeyQueries).toBe(0);
  });

  it("still lists them for a session", async () => {
    const { GET } = await import("@/app/api/v1/api-keys/route");
    state.principal = session;

    const res = await GET(req("/api/v1/api-keys"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apiKeys).toHaveLength(1);
    expect(state.apiKeyQueries).toBe(1);
  });

  it("refuses POST and DELETE for an API key caller, with the same code", async () => {
    const list = await import("@/app/api/v1/api-keys/route");
    const del = await import("@/app/api/v1/api-keys/[id]/route");
    state.principal = scopedKey;

    const created = await list.POST(
      req("/api/v1/api-keys", { method: "POST", body: JSON.stringify({ name: "x" }) }),
    );
    const revoked = await del.DELETE(req("/api/v1/api-keys/k1"), params({ id: "k1" }));

    for (const res of [created, revoked]) {
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("forbidden");
    }
  });
});

describe("search — chunkTypes is a filter, not a suggestion", () => {
  const call = async (index: 0 | 1, query: string) => {
    const [top, project] = await Promise.all([
      import("@/app/api/v1/search/route"),
      import("@/app/api/v1/projects/[idOrSlug]/search/route"),
    ]);
    // The top-level route takes the project as a query parameter; the nested
    // one takes it from the path. Both take the filters below identically,
    // which is the point of running every case through both.
    const filters = query.replace(/^\?/, "");
    if (index === 0) return top.GET(req(`/api/v1/search?project=p1&${filters}`));
    return project.GET(req(`/api/v1/projects/p1/search?${filters}`), params({ idOrSlug: "p1" }));
  };

  it("rejects an unknown value instead of running unfiltered and reporting success", async () => {
    for (const index of [0, 1] as const) {
      state.searchCalls = [];
      const res = await call(index, "?q=hello&chunkTypes=cdoe");

      expect(res.status).toBe(400);
      const body = await res.json();
      // Reported through the same validation path as every other bad query
      // parameter on these routes.
      expect(body.error.code).toBe("validation_failed");
      expect(JSON.stringify(body.error.details)).toMatch(/cdoe/);
      // The heart of it: the search never ran. Before, the typo was dropped
      // and the caller got an unfiltered result set and a 200.
      expect(state.searchCalls).toEqual([]);
    }
  });

  it("rejects the whole list when only one value is wrong", async () => {
    for (const index of [0, 1] as const) {
      state.searchCalls = [];
      const res = await call(index, "?q=hello&chunkTypes=code,nope,test");
      expect(res.status).toBe(400);
      // Silently keeping the valid half would still be a filter the caller did
      // not ask for, answered with a 200.
      expect(state.searchCalls).toEqual([]);
    }
  });

  it("passes a valid list through, ignoring blanks and duplicates", async () => {
    for (const index of [0, 1] as const) {
      state.searchCalls = [];
      expect((await call(index, "?q=hello&chunkTypes=code,,test,code")).status).toBe(200);
      expect(state.searchCalls).toEqual([{ projectId: "p1", chunkTypes: ["code", "test"] }]);
    }
  });

  it("treats an empty or absent parameter as no filter at all", async () => {
    for (const index of [0, 1] as const) {
      for (const query of ["?q=hello", "?q=hello&chunkTypes=", "?q=hello&chunkTypes=,,,"]) {
        state.searchCalls = [];
        expect((await call(index, query)).status).toBe(200);
        // Nothing was asked for, so nothing is filtered — the point being that
        // this is not the shape a rejected typo used to collapse into.
        expect(state.searchCalls).toEqual([{ projectId: "p1", chunkTypes: undefined }]);
      }
    }
  });

  it("accepts every chunk type the index actually defines", async () => {
    const { CHUNK_TYPE_VALUES } = await import("@/lib/search/search");
    const { ChunkType } = await import("@/generated/prisma/enums");
    // Guards the list the rejection above validates against: if the two drift,
    // a real chunk type starts being refused.
    expect(CHUNK_TYPE_VALUES).toEqual(Object.values(ChunkType));

    const res = await call(1, `?q=hello&chunkTypes=${CHUNK_TYPE_VALUES.join(",")}`);
    expect(res.status).toBe(200);
    expect(state.searchCalls[0].chunkTypes).toEqual(CHUNK_TYPE_VALUES);
  });

  it("still refuses the other query parameters it always did", async () => {
    // The chunkTypes change must not have loosened the enum or the bounds.
    expect((await call(1, "?q=hello&mode=nonsense")).status).toBe(400);
    expect((await call(1, "?q=hello&limit=0")).status).toBe(400);
    expect((await call(1, "?q=hello&limit=51")).status).toBe(400);
  });
});

describe("GET /api/v1/projects/:idOrSlug/stats — failedFiles", () => {
  it("is the count every client already types it as", async () => {
    const { GET } = await import("@/app/api/v1/projects/[idOrSlug]/stats/route");
    state.stats = {
      failedCount: 137,
      failedRows: [{ path: "src/a.ts", error: "embedding failed" }],
    };

    const body = await (
      await GET(req("/api/v1/projects/p1/stats"), params({ idOrSlug: "p1" }))
    ).json();

    // It used to be the array of up to 50 rows this query read instead, so the
    // dashboard's `stats.failedFiles > 0` compared an array to zero and the
    // "N files failed to index" alert could never fire.
    expect(body.stats.failedFiles).toBe(137);
    // The per-file detail is kept, under a name that says what it is.
    expect(body.stats.failedFileDetail).toEqual([{ path: "src/a.ts", error: "embedding failed" }]);
  });

  it("is zero, not an empty array, on a healthy project", async () => {
    const { GET } = await import("@/app/api/v1/projects/[idOrSlug]/stats/route");
    state.stats = { failedCount: 0, failedRows: [] };

    const body = await (
      await GET(req("/api/v1/projects/p1/stats"), params({ idOrSlug: "p1" }))
    ).json();
    expect(body.stats.failedFiles).toBe(0);
    expect(body.stats.failedFileDetail).toEqual([]);
  });
});

describe("GET /api/v1/health — a dependency that never answers", () => {
  it("fails fast instead of holding every unauthenticated request open", async () => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("@/app/api/v1/health/route");

    for (const component of ["postgres", "qdrant", "queue"] as const) {
      state.wedged[component] = true;
      const pending = GET(req("/api/v1/health"));
      // The three probe timers are armed synchronously; let the auth-free path
      // settle, then step past the ceiling.
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);

      const res = await pending;
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe("degraded");
      // The contract is unchanged: component booleans, no detail. Unbounded,
      // this request simply never came back.
      expect(Object.values(body.checks).every((v) => typeof v === "boolean")).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|localhost/);
      expect(body.checks[component]).toBe(false);
      // The reason is logged server-side, never returned to a public caller.
      expect(logged.mock.calls.flat().join(" ")).toContain(`${component} check failed`);
      state.wedged[component] = false;
    }
  });

  it("still answers 200 when every dependency answers", async () => {
    const { GET } = await import("@/app/api/v1/health/route");
    const res = await GET(req("/api/v1/health"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("healthy");
    expect(body.checks).toEqual({ postgres: true, qdrant: true, queue: true });
  });

  it("is public — a probe bound must not have become an auth check", async () => {
    // A container healthcheck and a load balancer cannot present a credential.
    // The ceiling added here is about wedged dependencies, not about callers.
    const { GET } = await import("@/app/api/v1/health/route");
    expect((await GET(req("/api/v1/health"))).status).toBe(200);
  });
});

describe("GET /api/v1/projects/:idOrSlug/evals — bounded live scoring", () => {
  const questions = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `q${i}`,
      question: `question ${i}`,
      expectedFiles: [`src/${i}.ts`],
    }));

  it("never runs more than a few searches at once for one request", async () => {
    const { GET } = await import("@/app/api/v1/projects/[idOrSlug]/evals/route");
    state.evalRows = questions(12);
    state.evalTotal = 12;
    state.searchDelayMs = 25;

    const pending = GET(req("/api/v1/projects/p1/evals"), params({ idOrSlug: "p1" }));
    // One macrotask in: a `Promise.all` over every question would already have
    // started all twelve, each one an embedding call and a set of queries.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(state.inFlight).toBe(4);
    expect(state.searchCalls).toHaveLength(4);

    const res = await pending;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(state.maxInFlight).toBe(4);
    // Every question is still scored — the bound is on concurrency, not on how
    // much of the request gets answered.
    expect(body.questions).toHaveLength(12);
  });

  it("says how much was actually scored", async () => {
    const { GET } = await import("@/app/api/v1/projects/[idOrSlug]/evals/route");
    state.evalRows = questions(60);
    state.evalTotal = 60;

    const body = await (
      await GET(req("/api/v1/projects/p1/evals"), params({ idOrSlug: "p1" }))
    ).json();
    // 60 stored, 50 scored: the aggregate is a mean over those 50, and the
    // response has to say so rather than leaving it to be inferred.
    expect(body.scored).toBe(50);
    expect(body.total).toBe(60);
    expect(body.notScored).toBe(10);
    // The documented field keeps its meaning.
    expect(body.truncated).toBe(10);
    expect(body.questions).toHaveLength(50);
  });

  it("reports a full set as nothing left out", async () => {
    const { GET } = await import("@/app/api/v1/projects/[idOrSlug]/evals/route");
    state.evalRows = questions(3);
    state.evalTotal = 3;

    const body = await (
      await GET(req("/api/v1/projects/p1/evals"), params({ idOrSlug: "p1" }))
    ).json();
    expect(body.scored).toBe(3);
    expect(body.notScored).toBe(0);
    expect(body.truncated).toBeUndefined();
  });

  it("counts the project's questions rather than the page it read", async () => {
    const { GET } = await import("@/app/api/v1/projects/[idOrSlug]/evals/route");
    // A project holding more questions than the route reads in one request.
    state.evalRows = questions(500);
    state.evalTotal = 900;

    const body = await (
      await GET(req("/api/v1/projects/p1/evals"), params({ idOrSlug: "p1" }))
    ).json();
    // Derived from the rows read, this said 450 unscored; the real number is
    // 850 and that is what the field now reports.
    expect(body.total).toBe(900);
    expect(body.notScored).toBe(850);
  });
});
