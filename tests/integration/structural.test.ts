import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendLine,
  cleanupProject,
  createProjectRow,
  gitCommit,
  makeTempRepoCopy,
  randomSuffix,
  requireInfra,
} from "../helpers";

const run = process.env.RUN_INTEGRATION === "1";

const TEST_FILE = `import { OrderService } from './service';

describe('orders', () => {
  it('cancels an order', () => {
    const svc = new OrderService();
    svc.cancelOrder('o-1');
  });
});
`;

describe.runIf(run)("structural + search", () => {
  let projectId = "";
  let repoDir = "";

  beforeAll(async () => {
    await requireInfra(["db", "qdrant", "embeddings"]);
    // The worker preloads grammars before processing jobs; replicate that here.
    const { preloadGrammars } = await import("@/lib/indexing/parser");
    await preloadGrammars();
    repoDir = await makeTempRepoCopy();
    await appendLine(join(repoDir, "src/orders/orders.test.ts"), TEST_FILE);
    // The pipeline indexes tracked files (git ls-files); commit the new file.
    await gitCommit(repoDir, "add test file");
    const project = await createProjectRow(`test-${randomSuffix()}`, `file://${repoDir}`);
    projectId = project.id;
    const { runIndexJob } = await import("@/lib/indexing/pipeline");
    await runIndexJob({ projectId, mode: "initial" });
  });

  afterAll(async () => {
    if (projectId) await cleanupProject(projectId);
    if (repoDir) await rm(repoDir, { recursive: true, force: true });
  });

  it("finds symbols by exact name and qualified name", async () => {
    const { findSymbol } = await import("@/lib/search/structural");

    const byName = await findSymbol(projectId, "Order");
    expect(byName).not.toBeNull();
    expect(byName!.kind).toBe("interface");
    expect(byName!.path.endsWith("model.ts")).toBe(true);

    const byQualified = await findSymbol(projectId, "OrderRepository.findById");
    expect(byQualified!.kind).toBe("method");
    expect(byQualified!.parentName).toBe("OrderRepository");

    expect(await findSymbol(projectId, "no.such.symbol")).toBeNull();
  });

  it("searches symbols by prefix", async () => {
    const { searchSymbols } = await import("@/lib/search/structural");
    const hits = await searchSymbols(projectId, "Order", { limit: 20 });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.qualifiedName.startsWith("Order")).toBe(true);
    const names = hits.map((h) => h.qualifiedName);
    expect(names).toContain("OrderRepository");
    expect(names).toContain("OrderRepository.findById");
  });

  it("finds references by segment: a.b.c references a, a.b and a.b.c", async () => {
    const { findReferences } = await import("@/lib/search/structural");

    const exact = (await findReferences(projectId, "Order.findById")).map((h) => h.qualifiedName);
    expect(exact).toContain("OrderService.cancelOrder");

    const mid = (await findReferences(projectId, "Order.find")).map((h) => h.qualifiedName);
    expect(mid).toContain("OrderService.listPending");
    expect(mid).not.toContain("OrderService.cancelOrder");

    const simple = (await findReferences(projectId, "Order")).map((h) => h.qualifiedName);
    expect(simple).toContain("OrderService.cancelOrder");
    expect(simple).toContain("OrderService.listPending");

    const deep = (await findReferences(projectId, "notify.sendExpiring")).map((h) => h.qualifiedName);
    expect(deep).toContain("OrderService.cancelOrder");
  });

  it("returns a symbol's dependencies: calls plus file-level imports", async () => {
    const { findDependencies } = await import("@/lib/search/structural");

    const service = await findDependencies(projectId, "OrderService");
    expect(service).not.toBeNull();
    // Top-level symbols inherit the file's imports.
    expect(service!.imports).toContain("./model");
    expect(service!.imports).toContain("../notify/service");
    // The class node covers its whole subtree, so method calls show up here.
    expect(service!.calls).toContain("Order.findById");

    const cancel = await findDependencies(projectId, "OrderService.cancelOrder");
    expect(cancel!.calls).toContain("Order.findById");
    expect(cancel!.calls).toContain("notify.sendExpiring");
    expect(cancel!.imports).toEqual([]);

    expect(await findDependencies(projectId, "missing.symbol")).toBeNull();
  });

  it("dedupes calls in the stored symbol metadata", async () => {
    const { prisma } = await import("@/lib/prisma");
    const row = await prisma().symbol.findFirst({
      where: { projectId, qualifiedName: "OrderService.listPending" },
    });
    expect(row).not.toBeNull();
    const meta = (row!.metadata ?? {}) as { calls: string[] };
    expect(meta.calls).toEqual(["Order.find"]);
  });

  it("lists test files and filters them by a path fragment", async () => {
    const { findTests } = await import("@/lib/search/structural");

    const all = await findTests(projectId);
    expect(all).toHaveLength(1);
    expect(all[0].path).toContain("orders.test.ts");

    const matching = await findTests(projectId, "orders");
    expect(matching).toHaveLength(1);
    expect(matching[0].path).toContain("orders.test.ts");

    expect(await findTests(projectId, "zzz-no-such-path")).toHaveLength(0);
  });

  it("performs lexical search over chunk content", async () => {
    const { lexicalSearch } = await import("@/lib/search/lexical");
    const hits = await lexicalSearch(projectId, "cancelled", { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    const withMatch = hits.find((h) => h.content.includes("cancelled"));
    expect(withMatch).not.toBeUndefined();
  });

  it("serves symbol-mode project search", async () => {
    const { searchProject } = await import("@/lib/search/search");
    const res = await searchProject(projectId, "OrderRepository", { mode: "symbol", limit: 5 });
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items.map((i) => i.symbol)).toContain("OrderRepository");
  });

  it("runs hybrid search end-to-end (embeddings + lexical)", async () => {
    const { searchProject } = await import("@/lib/search/search");
    const res = await searchProject(projectId, "expiring", { mode: "hybrid", limit: 5 });
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.sources.lexical).toBeGreaterThan(0);
  });
});