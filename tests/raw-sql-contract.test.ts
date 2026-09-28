import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Contract tests for the hand-written raw SQL.
 *
 * None of this has ever run against Postgres: the integration suite is gated
 * behind RUN_INTEGRATION=1, so a mismatched placeholder (`$3` in the text with
 * two parameters bound) or a missing project filter would ship and only fail in
 * production. These assertions need no database — `@/lib/prisma` is replaced
 * with a recorder, and the checks are about the query TEXT and the parameters
 * the code actually binds.
 *
 * Two properties, both of which have bitten this codebase or would bite it:
 *   1. Every `$N` has a parameter and every parameter has a `$N`. A mismatch
 *      is a runtime error on first call, not a compile error.
 *   2. Every statement is scoped to a project. These functions take a
 *      `projectId` and build the SQL by string concatenation, so a forgotten
 *      filter is a cross-tenant read rather than a bug you notice.
 */
const h = vi.hoisted(() => ({
  raw: [] as Array<{ sql: string; params: unknown[] }>,
  rows: [] as unknown[],
}));

vi.mock("@/lib/prisma", () => {
  const client = {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      h.raw.push({ sql, params });
      return h.rows;
    },
    $queryRaw: async () => [{ ok: 1 }],
  };
  return { prisma: () => client, disconnectPrisma: async () => {} };
});

/** Highest `$N` referenced, and every N in between. */
function placeholders(sql: string): number[] {
  const found = new Set<number>();
  for (const m of sql.matchAll(/\$(\d+)/g)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

async function capture<T>(fn: () => Promise<T>): Promise<Array<{ sql: string; params: unknown[] }>> {
  const before = h.raw.length;
  await fn();
  return h.raw.slice(before);
}

beforeEach(() => {
  h.raw.length = 0;
  h.rows.length = 0;
});

describe("raw SQL contract", () => {
  it("findReferences binds exactly as many parameters as it references", async () => {
    const { findReferences } = await import("@/lib/search/structural");
    const calls = await capture(() => findReferences("p1", "OrderService.cancelOrder", 10));
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0]!;
    const used = placeholders(sql);
    expect(used.length).toBe(params.length);
    // No gaps: using $1 and $3 with only two params means $2 was dropped.
    expect(used).toEqual(Array.from({ length: params.length }, (_, i) => i + 1));
    expect(params[0]).toBe("p1");
  });

  it("findTests binds exactly as many parameters as it references", async () => {
    const { findTests } = await import("@/lib/search/structural");
    const calls = await capture(() => findTests("p1", "cancelOrder", 5));
    expect(calls.length).toBeGreaterThan(0);
    for (const { sql, params } of calls) {
      const used = placeholders(sql);
      expect(used).toEqual(Array.from({ length: params.length }, (_, i) => i + 1));
    }
  });

  it("lexicalSearch binds its project, limit and tsquery", async () => {
    const { lexicalSearch } = await import("@/lib/search/lexical");
    const calls = await capture(() => lexicalSearch("p1", "how does order expiry work", { limit: 5 }));
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0]!;
    expect(placeholders(sql)).toEqual([1, 2, 3]);
    expect(params[0]).toBe("p1");
    expect(params[1]).toBe(5);
    // The tsquery is bound, not interpolated, so an operator in the query text
    // cannot become a tsquery operator.
    expect(sql).not.toContain(`${params[2]}`);
    expect(String(params[2])).toContain("|");
  });

  it("lexicalSearch falls back to a bound substring match when no term survives", async () => {
    const { lexicalSearch } = await import("@/lib/search/lexical");
    const calls = await capture(() => lexicalSearch("p1", "*** ... ***", { limit: 5 }));
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0]!;
    expect(placeholders(sql)).toEqual([1, 2, 3]);
    expect(sql).toContain("ILIKE");
  });

  it("symbolNameSearch binds its language filter when one is given", async () => {
    const { symbolNameSearch } = await import("@/lib/search/lexical");
    const calls = await capture(() =>
      symbolNameSearch("p1", "cancelOrder", 10, { languages: ["typescript"] }),
    );
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0]!;
    // Bound as q, q%, %q%, projectId, limit, languages.
    expect(placeholders(sql)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(params[3]).toBe("p1");
    expect(params[4]).toBe(10);
    expect(params[5]).toEqual(["typescript"]);
    // The language filter must be in SQL, not applied in JS after the LIMIT:
    // a post-LIMIT filter can discard every row the query already chose.
    expect(sql).toMatch(/f\.language\s*=/);
  });

  it("symbolNameSearch omits the language placeholder when no filter is given", async () => {
    const { symbolNameSearch } = await import("@/lib/search/lexical");
    const calls = await capture(() => symbolNameSearch("p1", "cancelOrder", 10));
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0]!;
    expect(placeholders(sql)).toEqual([1, 2, 3, 4, 5]);
    expect(params[3]).toBe("p1");
    expect(sql).not.toContain("$6");
  });

  it("metricSummaries binds its names, window and optional project", async () => {
    const { metricSummaries } = await import("@/lib/metrics");
    const global = await capture(() => metricSummaries(24));
    expect(placeholders(global[0]!.sql)).toEqual([1, 2]);

    h.raw.length = 0;
    const scoped = await capture(() => metricSummaries(24, "p1"));
    expect(placeholders(scoped[0]!.sql)).toEqual([1, 2, 3]);
    expect(scoped[0]!.params[2]).toBe("p1");
  });

  it("every raw statement in the search layer is scoped by project", async () => {
    const { findReferences, findTests } = await import("@/lib/search/structural");
    const { lexicalSearch, symbolNameSearch } = await import("@/lib/search/lexical");
    const statements = [
      ...(await capture(() => findReferences("p1", "x", 5))),
      ...(await capture(() => findTests("p1", "x", 5))),
      ...(await capture(() => lexicalSearch("p1", "x", { limit: 5 }))),
      ...(await capture(() => symbolNameSearch("p1", "x", 5))),
    ];
    expect(statements.length).toBeGreaterThanOrEqual(4);
    for (const { sql, params } of statements) {
      // The project must be filtered in SQL — not merely passed in — and on
      // whichever placeholder the caller happened to bind it to.
      const match = sql.match(/"projectId"\s*=\s*\$(\d+)/);
      expect(match, sql.slice(0, 90)).not.toBeNull();
      const index = Number(match![1]) - 1;
      expect(params[index], sql.slice(0, 90)).toBe("p1");
    }
  });
});

describe("lexicalSearch filter binding", () => {
  // Regression: the `languages` filter was an unqualified `AND "language" IN (...)`.
  // The statement joins `file` and LEFT JOINs `symbol`, and both have a
  // `language` column, so Postgres raised `column reference "language" is
  // ambiguous` (42702) at plan time — a deterministic 500 on every
  // language-filtered search, in hybrid and lexical modes alike. It reproduced
  // only when the filter was supplied, and the SELECT list already said
  // `f.language`, so the response shape looked correct and nothing caught it.
  it("qualifies every column in the WHERE clause and binds each list", async () => {
    const { lexicalSearch } = await import("@/lib/search/lexical");
    const calls = await capture(() =>
      lexicalSearch("p1", "cancelOrder", {
        limit: 5,
        languages: ["typescript"],
        chunkTypes: ["code"],
        path: "src/",
      }),
    );
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0]!;

    // Scoped to the WHERE clause: the SELECT list legitimately contains
    // `c."chunkType" AS "chunkType"`, and an output alias is not a column
    // reference. The bug was an unqualified reference in a predicate.
    const where = sql.slice(sql.indexOf("WHERE"));
    expect(where).not.toMatch(/(^|[\s(])"language"/);
    expect(where).not.toMatch(/(^|[\s(])"path"/);
    expect(where).not.toMatch(/(^|[\s(])"chunkType"/);
    expect(where).toMatch(/f\."language" = ANY\(\$5::text\[\]\)/);
    expect(where).toMatch(/c\."chunkType" = ANY\(\$4::text\[\]\)/);

    expect(placeholders(sql)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(params[0]).toBe("p1");
    expect(params[3]).toEqual(["code"]);
    expect(params[4]).toEqual(["typescript"]);
    expect(params[5]).toBe("src/");
  });

  it("omits the placeholders it does not use", async () => {
    const { lexicalSearch } = await import("@/lib/search/lexical");
    const calls = await capture(() => lexicalSearch("p1", "cancelOrder", { limit: 5 }));
    const { sql, params } = calls[0]!;
    expect(placeholders(sql)).toEqual([1, 2, 3]);
    expect(sql).not.toContain("$4");
  });
});
