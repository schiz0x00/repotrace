import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `findSymbol` and `findSymbolsBatch` answer the same question — "which symbol
 * does this name mean?" — and both are on the request path of a search: the
 * single lookup from the MCP `find_symbol` tool and the dependency graph, the
 * batched one from the context builder, which replaced a per-symbol waterfall
 * of up to 42 round trips.
 *
 * They must therefore resolve a name to the *same symbol*. Where they differ,
 * the context builder describes a symbol the user never asked for, or the graph
 * resolves an edge to a different definition than the MCP tool names — and
 * because both return a plausible-looking hit either way, nothing reports it.
 *
 * The preference itself used to disagree: both were a `findFirst`/`findMany`
 * over `qualifiedName OR name` with no ordering, so a project holding both
 * `OrderService` and `service.OrderService` answered with whichever row the
 * planner emitted first. `findSymbol` now asks the qualified clause alone and
 * falls back to the short one; the batch layers a qualified index over a
 * name index. The tests below pin that they agree, and pin the two places they
 * deliberately do not.
 *
 * Hermetic: `@/lib/prisma` is an in-memory store. No database, no network.
 */

const h = vi.hoisted(() => {
  type NameClause = { qualifiedName: string } | { name: string };
  interface Where {
    projectId?: string;
    OR?: NameClause[];
    [key: string]: unknown;
  }
  const symbols: Array<Record<string, unknown>> = [];
  const files = new Map<string, string>();
  /** Every query the two functions issued, for shape assertions. */
  const queries: Array<{ op: "findFirst" | "findMany"; where: Where }> = [];

  // Mirrors the two `where` shapes structural.ts actually builds: an exact
  // `qualifiedName` or `name` match list, plus a `projectId` scope. Anything it
  // does not understand matches nothing, so a filter added to the library shows
  // up here as a failure rather than a silent pass.
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
    file: { path: files.get(String(s.fileId)) ?? "" },
  });

  return {
    symbols,
    files,
    queries,
    client: {
      symbol: {
        // Unordered, like the real thing: neither query carries an ORDER BY, so
        // the row that comes back first is the planner's choice.
        findFirst: async ({ where }: { where: Where }) => {
          queries.push({ op: "findFirst", where });
          const row = symbols.find((s) => matches(where, s));
          return row ? attach(row) : null;
        },
        findMany: async ({ where }: { where: Where }) => {
          queries.push({ op: "findMany", where });
          return symbols.filter((s) => matches(where, s)).map(attach);
        },
      },
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: () => h.client }));

const { findSymbol, findSymbolsBatch } = await import("@/lib/search/structural");

const PROJECT = "p1";

function sym(id: string, name: string, qualifiedName: string, projectId = PROJECT) {
  const fileId = `f:${id}`;
  h.files.set(fileId, `src/${id}.ts`);
  return {
    id,
    name,
    qualifiedName,
    kind: "method",
    language: "typescript",
    startLine: 1,
    endLine: 20,
    parentName: null,
    projectId,
    fileId,
    metadata: { calls: [], imports: [], extends: [], implements: [] },
  };
}

function seed(...rows: Array<Record<string, unknown>>): void {
  h.symbols.push(...rows);
}

/** Runs both lookups and asserts they named the same symbol. */
async function expectAgreement(name: string): Promise<string> {
  const single = await findSymbol(PROJECT, name);
  const batch = await findSymbolsBatch(PROJECT, [name]);
  const fromBatch = batch.get(name);
  expect(fromBatch?.id ?? null).toEqual(single?.id ?? null);
  return fromBatch?.id ?? "";
}

beforeEach(() => {
  h.symbols.length = 0;
  h.files.clear();
  h.queries.length = 0;
});

describe("findSymbol and findSymbolsBatch agree on a qualified-name match", () => {
  // The case the preference is for: a caller naming `OrderService.cancelOrder`
  // means the method, not the class of the same simple name.
  it("resolves a qualified name the same way from both", async () => {
    seed(
      sym("method", "cancelOrder", "OrderService.cancelOrder"),
      sym("class", "OrderService", "OrderService"),
    );
    expect(await expectAgreement("OrderService.cancelOrder")).toBe("method");
  });

  // The case the preference is *not* about, and the one that used to differ:
  // a name that is some other symbol's qualified name AND this symbol's short
  // name. The qualified match is the one the caller meant.
  it("prefers the qualified match over a short-name match, in both row orders", async () => {
    for (const order of [
      [sym("short", "OrderService", "orders.OrderService"), sym("qualified", "OrderService", "OrderService")],
      [sym("qualified", "OrderService", "OrderService"), sym("short", "OrderService", "orders.OrderService")],
    ]) {
      h.symbols.length = 0;
      seed(...order);
      expect(await expectAgreement("OrderService")).toBe("qualified");
    }
  });

  // A name that only matches one way: a top-level declaration has
  // `qualifiedName === name`, and a method looked up by its simple name has no
  // qualified match at all. Neither path may fall through to nothing.
  it("falls back to the short name when nothing matches a qualified name", async () => {
    seed(sym("a", "cancelOrder", "OrderService.cancelOrder"));
    expect(await expectAgreement("cancelOrder")).toBe("a");
  });

  it("resolves a name that matches nothing to nothing, without erroring", async () => {
    seed(sym("a", "cancelOrder", "OrderService.cancelOrder"));
    expect(await findSymbol(PROJECT, "no.such.symbol")).toBeNull();
    expect((await findSymbolsBatch(PROJECT, ["no.such.symbol"])).size).toBe(0);
  });

  it("keeps a project-scoped key out of another project's symbols", async () => {
    seed(sym("mine", "OrderService", "OrderService"), sym("theirs", "OrderService", "OrderService", "p2"));
    expect(await expectAgreement("OrderService")).toBe("mine");
    expect((await findSymbolsBatch("p2", ["OrderService"])).get("OrderService")!.id).toBe("theirs");
  });
});

describe("findSymbol and findSymbolsBatch in a batch", () => {
  // The batch is the whole point: one query for every name, not one per name.
  it("answers each name of a mixed batch exactly as the single lookup would", async () => {
    seed(
      sym("svc", "OrderService", "OrderService"),
      sym("method", "cancelOrder", "OrderService.cancelOrder"),
      sym("other", "other", "module.other"),
      sym("dupShort", "cancelOrder", "Legacy.cancelOrder"),
    );
    const names = [
      "OrderService",
      "cancelOrder",
      "module.other",
      "no.such.symbol",
      "OrderService",
      "  OrderService  ",
    ];
    const batch = await findSymbolsBatch(PROJECT, names);
    // Exactly one query, whatever the batch size.
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0].op).toBe("findMany");

    // Four names asked, three answered: duplicates collapse and the padded
    // spelling resolves to the same key as the bare one.
    expect(batch.size).toBe(3);
    expect([...batch.keys()]).toEqual(["OrderService", "cancelOrder", "module.other"]);
    expect(batch.get("OrderService")!.id).toBe((await findSymbol(PROJECT, "OrderService"))!.id);
    expect(batch.get("cancelOrder")!.id).toBe("method");
    expect(batch.get("module.other")!.id).toBe("other");
    expect(batch.has("no.such.symbol")).toBe(false);
  });

  it("collapses duplicates and drops blanks before querying", async () => {
    seed(sym("a", "Foo", "Foo"));
    const batch = await findSymbolsBatch(PROJECT, ["Foo", "Foo", "", "   ", "  Foo  "]);
    expect([...batch.keys()]).toEqual(["Foo"]);
    // Two OR clauses per unique, non-blank name — the same shape
    // `findSymbol` builds, which is what the dependency-graph query matcher
    // models.
    expect(h.queries[0].where.OR).toEqual([{ qualifiedName: "Foo" }, { name: "Foo" }]);
  });

  it("answers an empty batch with an empty map and no query at all", async () => {
    seed(sym("a", "Foo", "Foo"));
    expect((await findSymbolsBatch(PROJECT, [])).size).toBe(0);
    expect((await findSymbolsBatch(PROJECT, ["", "   "])).size).toBe(0);
    expect(h.queries).toHaveLength(0);
  });

  // The batch is how the context builder resolves a top symbol *and* its
  // callees, so a name that matches one way and a sibling that matches the
  // other way must both be honoured in the same map.
  it("resolves a mixed batch where several names match both ways", async () => {
    seed(
      sym("q1", "Service", "OrderService"),
      sym("n1", "OrderService", "orders.OrderService"),
      sym("n2", "Repository", "repo.Repository"),
      sym("q2", "Repository", "Repository"),
    );
    const batch = await findSymbolsBatch(PROJECT, ["OrderService", "Repository"]);
    expect(batch.get("OrderService")!.id).toBe("q1");
    expect(batch.get("Repository")!.id).toBe("q2");
    expect(await expectAgreement("OrderService")).toBe("q1");
    expect(await expectAgreement("Repository")).toBe("q2");
  });
});

describe("deliberate differences between the two lookups", () => {
  // Neither query is ordered, and two functions that issue different queries
  // get their rows in a different order from Postgres: `findSymbol` asks for
  // one clause and can walk `@@index([projectId, qualifiedName])`, while the
  // batch asks for a long OR list and usually gets a bitmap scan plus a sort.
  // For two rows sharing the *same* match kind — an overload set, a name
  // reused across files — the winner is therefore unspecified on both sides and
  // is not the same row. Pinned here so nobody "fixes" one into a documented
  // guarantee it does not make, and so nobody relies on it either.
  it("leaves the choice among equally-matching rows unspecified on both sides", async () => {
    seed(sym("overload-1", "handler", "Service.handler"), sym("overload-2", "handler", "Service.handler"));
    const single = await findSymbol(PROJECT, "Service.handler");
    const batch = await findSymbolsBatch(PROJECT, ["Service.handler"]);
    // One of the two, not a mix, and not a fabricated third.
    expect(["overload-1", "overload-2"]).toContain(single!.id);
    expect(["overload-1", "overload-2"]).toContain(batch.get("Service.handler")!.id);
  });

  // The one behavioural difference the two lookups had, and the only reason a
  // name could resolve in a context bundle and then find nothing through the
  // MCP `find_symbol` tool: the batch trimmed, the single lookup did not. Both
  // trim now. Neither the parsers nor `qualifiedName` produce names with
  // whitespace at their edges, so nothing that matched before stops matching —
  // what changes is that the two paths can no longer disagree.
  it("trims whitespace in both, and answers a blank name with nothing", async () => {
    seed(sym("a", "OrderService", "OrderService"));
    expect((await findSymbolsBatch(PROJECT, ["  OrderService  "])).get("OrderService")!.id).toBe("a");
    expect((await findSymbol(PROJECT, "  OrderService  "))!.id).toBe("a");
    // A blank name matches nothing, and costs no query to find out.
    expect(await findSymbol(PROJECT, "   ")).toBeNull();
    expect((await findSymbolsBatch(PROJECT, ["  "])).size).toBe(0);
    const before = h.queries.length;
    await findSymbol(PROJECT, "   ");
    expect(h.queries).toHaveLength(before);
  });

  // And the round trips, which is what the batch was written for: one query
  // for N names, against at most two for one.
  it("asks the qualified clause alone, then the short one", async () => {
    seed(sym("a", "cancelOrder", "OrderService.cancelOrder"));
    await findSymbol(PROJECT, "OrderService.cancelOrder");
    expect(h.queries).toEqual([
      { op: "findFirst", where: { projectId: PROJECT, OR: [{ qualifiedName: "OrderService.cancelOrder" }] } },
    ]);

    h.queries.length = 0;
    await findSymbol(PROJECT, "cancelOrder");
    expect(h.queries.map((q) => q.where.OR)).toEqual([
      [{ qualifiedName: "cancelOrder" }],
      [{ name: "cancelOrder" }],
    ]);
  });
});
