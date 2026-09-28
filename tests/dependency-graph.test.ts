import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hermetic tests for the structural-search SQL shape and the dependency-graph
 * bounds. No database, no network: `@/lib/prisma` is replaced with an
 * in-memory store, so the assertions are about the queries the code builds and
 * the accounting it applies, not about what Postgres returns.
 */
const h = vi.hoisted(() => ({
  symbols: [] as Array<Record<string, unknown>>,
  files: new Map<string, string>(),
  /** Every `$queryRawUnsafe` call, as `{ sql, params }`. */
  raw: [] as Array<{ sql: string; params: unknown[] }>,
  /** `OR` clause count of every `symbol.findMany`, i.e. the size of each batch. */
  batches: [] as number[],
  /** `where` of every `file.findMany`. */
  fileQueries: [] as Array<Record<string, unknown>>,
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/prisma", () => {
  /** The exact-match `OR` entries structural.ts builds, plus the scope key. */
  type NameClause = { qualifiedName: string } | { name: string };
  interface Where {
    projectId?: string;
    OR?: NameClause[];
    [key: string]: unknown;
  }

  // Mirrors the two `where` shapes structural.ts actually builds: an exact
  // `qualifiedName` or `name` match list, plus a `projectId` scope. Anything
  // it does not understand matches nothing, so a new filter added to the
  // library shows up here as a test failure rather than a silent pass.
  const matches = (where: Where, s: Record<string, unknown>): boolean => {
    if (where.projectId !== undefined && s.projectId !== where.projectId) return false;
    if (where.OR === undefined) return true;
    return where.OR.some(
      (c) =>
        ("qualifiedName" in c && s.qualifiedName === c.qualifiedName) ||
        ("name" in c && s.name === c.name),
    );
  };

  const attach = (s: Record<string, unknown>) => ({
    ...s,
    file: { path: h.files.get(s.fileId as string) ?? "" },
  });

  const client = {
    symbol: {
      findFirst: async ({ where }: { where: Where }) => {
        const row = h.symbols.find((s) => matches(where, s));
        return row ? attach(row) : null;
      },
      findMany: async ({ where }: { where: Where }) => {
        h.batches.push(where.OR?.length ?? 0);
        return h.symbols.filter((s) => matches(where, s)).map(attach);
      },
    },
    file: {
      findMany: async ({ where }: { where: Where }) => {
        h.fileQueries.push(where);
        return [];
      },
    },
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      h.raw.push({ sql, params });
      return h.rows;
    },
  };

  return { prisma: () => client };
});

const {
  MAX_GRAPH_EDGES,
  REFERENCE_KEYS,
  TEST_PATH_PREDICATE,
  buildFindReferencesSql,
  buildFindTestsSql,
  buildReferenceScoreSql,
  dependencyGraph,
  findReferences,
  findTests,
  graphEdgeLimit,
  outgoingRelations,
  simpleNameOf,
} = await import("@/lib/search/structural");

const PROJECT = "p1";

interface SymSpec {
  id: string;
  qualifiedName: string;
  name?: string;
  calls?: string[];
  imports?: string[];
  extends?: string[];
  projectId?: string;
  fileId?: string;
}

function seed(specs: SymSpec[]): void {
  for (const s of specs) {
    const fileId = s.fileId ?? `f:${s.qualifiedName}`;
    h.files.set(fileId, `src/${s.qualifiedName}.ts`);
    h.symbols.push({
      id: s.id,
      name: s.name ?? s.qualifiedName.split(".").pop(),
      qualifiedName: s.qualifiedName,
      kind: "function",
      language: "typescript",
      startLine: 1,
      endLine: 20,
      parentName: null,
      projectId: s.projectId ?? PROJECT,
      fileId,
      metadata: {
        calls: s.calls ?? [],
        imports: s.imports ?? [],
        extends: s.extends ?? [],
        implements: [],
      },
    });
  }
}

beforeEach(() => {
  h.symbols = [];
  h.files.clear();
  h.raw = [];
  h.batches = [];
  h.fileQueries = [];
  h.rows = [];
});

describe("simpleNameOf", () => {
  it("takes the trailing dot-separated segment", () => {
    expect(simpleNameOf("OrderService.cancelOrder")).toBe("cancelOrder");
    expect(simpleNameOf("a.b.c.d")).toBe("d");
  });

  it("passes an unqualified name through unchanged", () => {
    expect(simpleNameOf("cancelOrder")).toBe("cancelOrder");
  });

  // `split` never yields an empty trailing element for input without dots, and
  // the `?? name` arm in the original was dead code. These pin the actual
  // behaviour so a future "fix" to it is a deliberate change.
  it("returns an empty string for a trailing dot rather than the whole name", () => {
    expect(simpleNameOf("a.b.")).toBe("");
  });
});

describe("buildReferenceScoreSql", () => {
  const score = buildReferenceScoreSql();

  // Regression: the key placeholder was substituted with String#replace over a
  // fixed key list. A missed key silently scored that metadata array as 0,
  // hiding every reference of that kind.
  it("substitutes every metadata key and leaves no placeholder behind", () => {
    expect(score).not.toContain("@KEY@");
    for (const key of REFERENCE_KEYS) {
      expect(score, key).toContain(`s.metadata->'${key}'`);
    }
  });

  it("scans each key exactly once", () => {
    expect(score.match(/jsonb_array_elements_text/g)).toHaveLength(REFERENCE_KEYS.length);
    for (const key of REFERENCE_KEYS) {
      expect(score.split(`s.metadata->'${key}'`).length - 1, key).toBe(1);
    }
  });

  // Symbol names contain `_` and `$`, which are LIKE wildcards and regex
  // metacharacters; a pattern match would report references that do not exist.
  it("matches on exact array membership, not on a LIKE or regex pattern", () => {
    expect(score).toContain("$2::text = ANY(string_to_array(e.value, '.'))");
    expect(score).not.toMatch(/\bLIKE\b/i);
    expect(score).not.toMatch(/~\s*'|regexp|similar to/i);
  });

  // Regression: a bare parameter appearing only inside `= ANY(...)` has no
  // inferable type, and Postgres raised "could not determine data type of
  // parameter" at execution time. The casts are load-bearing.
  it("casts both text parameters explicitly", () => {
    expect(score).toContain("$2::text");
    expect(score).toContain("$3::text");
  });
});

describe("buildFindReferencesSql", () => {
  const sql = buildFindReferencesSql();

  it("scopes the scan to the resolved project id", () => {
    expect(sql).toContain(`s."projectId" = $1::text`);
  });

  // Regression: the comment claimed the jsonb expression was evaluated once,
  // but a CTE referenced a single time is inlined by the planner, which
  // substituted the expression into the outer query where both WHERE and
  // ORDER BY read it. MATERIALIZED is what makes the claim true.
  it("materializes the scored CTE so the jsonb expression is evaluated once", () => {
    expect(sql).toContain("WITH scored AS MATERIALIZED (");
    expect(sql).not.toMatch(/WITH\s+scored\s+AS\s*\(/i);
  });

  it("keeps the ordering contract: highest score first, qualified name as tiebreak", () => {
    expect(sql).toContain("WHERE score > 0");
    expect(sql).toContain('ORDER BY score DESC, "qualifiedName" ASC');
  });

  it("applies the limit as a parameter and casts it", () => {
    expect(sql).toContain("LIMIT $4::int");
  });

  // The positional parameters are bound in the order they appear here; a
  // mismatch is a wrong answer, not an error, because all four are text/int.
  it("uses $1..$4 in order with no gaps or strays", () => {
    const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort();
    expect(used).toEqual([1, 2, 3, 4]);
  });
});

describe("buildFindTestsSql", () => {
  const sql = buildFindTestsSql();

  it("scopes the scan to the resolved project id", () => {
    expect(sql).toContain(`f."projectId" = $1::text`);
  });

  it("matches through the indexed tsvector column", () => {
    expect(sql).toContain("c.content_tsv @@ plainto_tsquery('simple', $2::text)");
  });

  // Ranking by mention count with a stable path tiebreak is the contract: the
  // file that talks about the symbol most comes first, ties are deterministic.
  it("orders by mention count descending, then path", () => {
    expect(sql).toContain("GROUP BY f.id, f.path, f.language");
    expect(sql).toContain("ORDER BY COUNT(c.id) DESC, f.path ASC");
  });

  it("applies the limit as a parameter and casts it", () => {
    expect(sql).toContain("LIMIT $3::int");
  });

  it("uses $1..$3 in order with no gaps or strays", () => {
    const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort();
    expect(used).toEqual([1, 2, 3]);
  });

  // `_` is a single-character wildcard to LIKE, so `_test.` would also match
  // `atest.ts`. Every alternative is a literal `position()`.
  it("detects test paths by literal position, never by LIKE", () => {
    expect(sql).toContain(TEST_PATH_PREDICATE);
    expect(TEST_PATH_PREDICATE).not.toMatch(/\bLIKE\b/i);
    expect(TEST_PATH_PREDICATE.match(/position\(/g)).toHaveLength(6);
  });
});

describe("findReferences parameter binding", () => {
  it("binds project, simple name, qualified target and limit in the SQL's order", async () => {
    await findReferences(PROJECT, "OrderService.cancelOrder", 7);
    expect(h.raw).toHaveLength(1);
    const { sql, params } = h.raw[0];
    expect(sql).toBe(buildFindReferencesSql());
    // $1 projectId, $2 simple name, $3 qualified target, $4 limit.
    expect(params).toEqual([PROJECT, "cancelOrder", "OrderService.cancelOrder", 7]);
  });

  it("defaults the limit when the caller does not pass one", async () => {
    await findReferences(PROJECT, "cancelOrder");
    expect(h.raw[0].params[3]).toBe(50);
  });
});

describe("findTests parameter binding", () => {
  it("binds project, simple name and limit in the SQL's order", async () => {
    await findTests(PROJECT, "OrderService.cancelOrder", 9);
    expect(h.raw).toHaveLength(1);
    expect(h.raw[0].sql).toBe(buildFindTestsSql());
    expect(h.raw[0].params).toEqual([PROJECT, "cancelOrder", 9]);
  });

  // The no-target path uses Prisma rather than raw SQL, so it has no
  // projectId parameter to mis-bind — but it does have to stay scoped, and its
  // predicate set has to match the raw SQL one. A file matched by one path and
  // not the other makes `findTests(x)` and `findTests(x, "sym")` disagree about
  // which files are tests.
  //
  // The whole set is asserted, in order, rather than spot-checked: the previous
  // version used `toContainEqual` on five of the eight arms, so dropping
  // `.spec.`, `_test.` or `/test/` from `TEST_PATH_WHERE` left the suite green
  // while `findTests(x)` and `findTests(x, "sym")` started disagreeing.
  it("applies the same test-path set, project-scoped, on the no-target path", async () => {
    await findTests(PROJECT, undefined, 25);
    expect(h.raw).toHaveLength(0);
    expect(h.fileQueries).toHaveLength(1);
    const where = h.fileQueries[0];
    expect(where.projectId).toBe(PROJECT);
    expect(where.OR).toEqual([
      { path: { contains: ".test." } },
      { path: { contains: ".spec." } },
      { path: { contains: "_test." } },
      // `__tests__` is matched as a whole path SEGMENT, in both arms. The old
      // `contains: "__tests__"` also matched `__tests__helper.ts` and
      // `foo__tests__bar.ts`, which are ordinary source, so findTests listed
      // them as tests. A directory at the repository root needs the separate
      // startsWith arm because there is no leading slash to anchor on.
      { path: { contains: "/__tests__/" } },
      { path: { startsWith: "__tests__/" } },
      { path: { contains: "/tests/" } },
      { path: { contains: "/test/" } },
      { path: { startsWith: "test_" } },
    ]);
    // The whole-segment form, never the bare substring.
    expect(where.OR).not.toContainEqual({ path: { contains: "__tests__" } });
  });

  // The equivalence the test above is named for: every Prisma arm has to have a
  // counterpart in the raw-SQL predicate, so the two paths cannot drift apart
  // while both keep their own tests green. `__tests__` is the one SQL arm that
  // covers two Prisma arms — the SQL concatenates a leading slash, which
  // matches a root-level directory for free.
  it("keeps the Prisma and SQL test-path predicates equivalent", () => {
    const sqlArmFor: Array<[string, string]> = [
      ["contains:.test.", "position('.test.' in f.path) > 0"],
      ["contains:.spec.", "position('.spec.' in f.path) > 0"],
      ["contains:_test.", "position('_test.' in f.path) > 0"],
      ["contains:/__tests__/", "position('/__tests__/' in '/' || f.path) > 0"],
      ["startsWith:__tests__/", "position('/__tests__/' in '/' || f.path) > 0"],
      ["contains:/tests/", "position('/tests/' in f.path) > 0"],
      ["contains:/test/", "position('/test/' in f.path) > 0"],
      ["startsWith:test_", "left(f.path, 5) = 'test_'"],
    ];
    for (const [prismaArm, sqlArm] of sqlArmFor) {
      expect(TEST_PATH_PREDICATE, prismaArm).toContain(sqlArm);
    }
    // And nothing beyond them: the SQL has seven alternatives for the same
    // eight Prisma arms, so a ninth predicate would have no Prisma counterpart.
    expect(TEST_PATH_PREDICATE.match(/\bOR\b/g)).toHaveLength(6);
  });
});

describe("graphEdgeLimit", () => {
  it("scales with the node limit", () => {
    expect(graphEdgeLimit(100)).toBe(400);
    expect(graphEdgeLimit(200)).toBe(800);
  });

  it("has a floor so a tiny node limit does not also mean a tiny edge budget", () => {
    expect(graphEdgeLimit(1)).toBe(64);
    expect(graphEdgeLimit(4)).toBe(64);
  });

  it("never exceeds the absolute ceiling, whatever the node limit", () => {
    expect(graphEdgeLimit(1000)).toBe(MAX_GRAPH_EDGES);
    expect(graphEdgeLimit(5000)).toBe(MAX_GRAPH_EDGES);
  });
});

describe("outgoingRelations", () => {
  const symbol = {
    qualifiedName: "OrderService.cancel",
    calls: ["notify"],
    imports: ["zod", "node:fs"],
    extends: ["BaseError"],
  } as never;

  it("emits calls, then imports, then extends", () => {
    expect(outgoingRelations(symbol)).toEqual([
      { from: "OrderService.cancel", to: "notify", kind: "calls" },
      { from: "OrderService.cancel", to: "zod", kind: "imports" },
      { from: "OrderService.cancel", to: "node:fs", kind: "imports" },
      { from: "OrderService.cancel", to: "BaseError", kind: "extends" },
    ]);
  });

  it("emits nothing for a symbol with no recorded relationships", () => {
    expect(
      outgoingRelations({ qualifiedName: "x", calls: [], imports: [], extends: [] } as never),
    ).toEqual([]);
  });
});

describe("dependencyGraph", () => {
  it("reports a missing root as an empty, untruncated graph", async () => {
    seed([{ id: "s1", qualifiedName: "other" }]);
    const graph = await dependencyGraph(PROJECT, "missing");
    expect(graph.root).toBeNull();
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.truncated).toBe(false);
    expect(graph.truncation).toEqual({ nodes: false, edges: false });
  });

  it("walks breadth-first and records depth", async () => {
    seed([
      { id: "s1", qualifiedName: "a", calls: ["b"] },
      { id: "s2", qualifiedName: "b", calls: ["c"] },
      { id: "s3", qualifiedName: "c" },
    ]);
    const graph = await dependencyGraph(PROJECT, "a", { depth: 3 });
    expect(graph.nodes.map((n) => [n.qualifiedName, n.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    expect(graph.edges).toEqual([
      { from: "a", to: "b", kind: "calls", resolved: true },
      { from: "b", to: "c", kind: "calls", resolved: true },
    ]);
    expect(graph.truncation).toEqual({ nodes: false, edges: false });
  });

  // An import of something outside the repo is exactly what a reader needs to
  // see, so unresolved edges are kept rather than dropped.
  it("keeps unresolved edges with resolved: false", async () => {
    seed([{ id: "s1", qualifiedName: "a", imports: ["node:fs", "zod"] }]);
    const graph = await dependencyGraph(PROJECT, "a");
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toEqual([
      { from: "a", to: "node:fs", kind: "imports", resolved: false },
      { from: "a", to: "zod", kind: "imports", resolved: false },
    ]);
    expect(graph.truncated).toBe(false);
  });

  it("does not repeat a symbol reachable by two paths", async () => {
    seed([
      { id: "s1", qualifiedName: "a", calls: ["shared", "other"] },
      { id: "s2", qualifiedName: "shared", calls: ["other"] },
      { id: "s3", qualifiedName: "other" },
    ]);
    const graph = await dependencyGraph(PROJECT, "a", { depth: 3 });
    expect(graph.nodes.map((n) => n.qualifiedName)).toEqual(["a", "shared", "other"]);
    // Both edges exist even though the target node is only added once.
    expect(graph.edges).toHaveLength(3);
  });

  it("never returns a symbol from another project", async () => {
    seed([
      { id: "s1", qualifiedName: "a", calls: ["foreign"] },
      { id: "s2", qualifiedName: "foreign", projectId: "other-project" },
    ]);
    const graph = await dependencyGraph(PROJECT, "a");
    expect(graph.nodes.map((n) => n.qualifiedName)).toEqual(["a"]);
    // The edge survives — the coupling is real — but it is not resolved.
    expect(graph.edges).toEqual([{ from: "a", to: "foreign", kind: "calls", resolved: false }]);
  });

  it("stops at the node limit and says so", async () => {
    seed([
      { id: "s1", qualifiedName: "a", calls: ["b", "c", "d", "e", "f"] },
      { id: "s2", qualifiedName: "b" },
      { id: "s3", qualifiedName: "c" },
      { id: "s4", qualifiedName: "d" },
      { id: "s5", qualifiedName: "e" },
      { id: "s6", qualifiedName: "f" },
    ]);
    const graph = await dependencyGraph(PROJECT, "a", { limit: 3 });
    expect(graph.nodes).toHaveLength(3);
    expect(graph.truncation).toEqual({ nodes: true, edges: false });
    expect(graph.truncated).toBe(true);
  });

  it("does not report truncation when a fully-returned graph happens to sit at the cap", async () => {
    // limit=2 is satisfied exactly by root + one callee. Nothing was dropped,
    // so claiming truncation would send a caller hunting for a graph they
    // already have in full.
    seed([
      { id: "s1", qualifiedName: "a", calls: ["b"] },
      { id: "s2", qualifiedName: "b" },
    ]);
    const graph = await dependencyGraph(PROJECT, "a", { limit: 2, depth: 4 });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.truncation).toEqual({ nodes: false, edges: false });
    expect(graph.truncated).toBe(false);
  });

  // Regression: `limit` bounded `nodes` but nothing bounded `edges`. A symbol
  // with 5000 imports emitted 5000 edges at that level and every level below,
  // so the serialized response was sized by the repository rather than by the
  // caller — and the `wanted` list feeding the batched resolution query grew
  // with it, since each name became two OR clauses in one round trip.
  it("bounds the edge array no matter how wide a symbol is", async () => {
    const fanout = 5000;
    seed([
      {
        id: "s1",
        qualifiedName: "hub",
        imports: Array.from({ length: fanout }, (_, i) => `pkg${i}`),
      },
    ]);
    const graph = await dependencyGraph(PROJECT, "hub", { depth: 4, limit: 1000 });

    expect(graph.edges).toHaveLength(MAX_GRAPH_EDGES);
    expect(graph.edges.length).toBeLessThan(fanout);
    expect(graph.truncation).toEqual({ nodes: false, edges: true });
    expect(graph.truncated).toBe(true);
  });

  it("bounds the batched resolution query by the same budget it bounds the edges", async () => {
    seed([
      {
        id: "s1",
        qualifiedName: "hub",
        imports: Array.from({ length: 5000 }, (_, i) => `pkg${i}`),
      },
    ]);
    await dependencyGraph(PROJECT, "hub", { depth: 4, limit: 1000 });

    // One batched query for the level, two OR clauses per name.
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]).toBe(MAX_GRAPH_EDGES * 2);
    expect(h.batches[0]).toBeLessThan(5000 * 2);
  });

  // Regression: the edge budget was tested at the top of the level loop,
  // before the frontier was looked at. A level that spent the budget exactly
  // and left behind symbols with no recorded relations stopped there and was
  // reported truncated, so a caller told to raise the edge budget got back the
  // identical graph — the one outcome this field exists to rule out.
  it("does not claim edge truncation for a level that merely has nothing to expand", async () => {
    const local = Array.from({ length: 10 }, (_, i) => `local${i}`);
    const external = Array.from({ length: 70 }, (_, i) => `pkg${i}`);
    seed([
      { id: "s1", qualifiedName: "a", calls: [...local, ...external] },
      ...local.map((n) => ({ id: `s:${n}`, qualifiedName: n })),
    ]);

    // limit=20 buys an edge budget of exactly 80, which level 1 spends to the
    // edge. The 10 surviving nodes have no relations at all.
    expect(graphEdgeLimit(20)).toBe(80);
    const graph = await dependencyGraph(PROJECT, "a", { limit: 20, depth: 4 });

    expect(graph.edges).toHaveLength(80);
    expect(graph.nodes).toHaveLength(1 + local.length);
    expect(graph.truncation).toEqual({ nodes: false, edges: false });
    expect(graph.truncated).toBe(false);
    // The empty level never reached the resolution query.
    expect(h.batches).toHaveLength(1);
  });

  it("keeps one edge budget across levels rather than resetting it per level", async () => {
    // A root with 500 callees (level 1) whose own callees number 20 each — ten
    // times what remains of the 2000-edge budget. The level-2 names are left
    // unindexed deliberately, so the node cap never binds and the only bound
    // this test can fail on is the edge one.
    const specs: SymSpec[] = [{ id: "s1", qualifiedName: "a", calls: [] }];
    for (let i = 0; i < 5; i++) {
      const callees = Array.from({ length: 100 }, (_, j) => `l1_${i}_${j}`);
      specs[0].calls!.push(...callees);
      for (const c of callees) {
        specs.push({
          id: `s:${c}`,
          qualifiedName: c,
          calls: Array.from({ length: 20 }, (_, k) => `l2_${c}_${k}`),
        });
      }
    }
    seed(specs);

    const graph = await dependencyGraph(PROJECT, "a", { depth: 4, limit: 1000 });
    expect(graph.truncation).toEqual({ nodes: false, edges: true });

    // Level 1 leaves budget behind, so level 2 runs and issues its own query.
    // A per-level cap would have given it a fresh 2000 instead of the 1500
    // that remained, and the test would only have one batch to look at.
    expect(h.batches).toHaveLength(2);
    const [level1, level2] = h.batches;
    // Two OR clauses per name.
    expect(level1).toBe(500 * 2);
    expect(level2).toBe((MAX_GRAPH_EDGES - 500) * 2);
    expect(graph.edges).toHaveLength(MAX_GRAPH_EDGES);
    // No single level's query is allowed past the whole budget.
    for (const size of h.batches) expect(size).toBeLessThanOrEqual(MAX_GRAPH_EDGES * 2);
  });
});
