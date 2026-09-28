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

  it("walks a dependency graph out from a symbol", async () => {
    const { dependencyGraph } = await import("@/lib/search/structural");

    const graph = await dependencyGraph(projectId, "OrderService");
    expect(graph.root).not.toBeNull();
    expect(graph.root!.qualifiedName).toBe("OrderService");
    expect(graph.root!.depth).toBe(0);
    // The root is also nodes[0], so a renderer can draw from one list.
    expect(graph.nodes[0].id).toBe(graph.root!.id);
    expect(graph.truncated).toBe(false);

    // Calls and imports both become edges out of the root; `extends` is empty
    // for this fixture so it is not asserted here.
    const fromRoot = graph.edges.filter((e) => e.from === "OrderService");
    expect(fromRoot.map((e) => e.to)).toContain("Order.findById");
    expect(fromRoot.map((e) => e.to)).toContain("notify.sendExpiring");
    expect(fromRoot.some((e) => e.kind === "imports")).toBe(true);

    // A call is resolved by its last segment, so `Order.findById` reaches the
    // method actually named findById one level down.
    const call = fromRoot.find((e) => e.to === "Order.findById")!;
    expect(call.resolved).toBe(true);
    const reached = graph.nodes.find((n) => n.qualifiedName === "OrderRepository.findById")!;
    expect(reached).toBeDefined();
    expect(reached.depth).toBe(1);
    expect(reached.path.endsWith("model.ts")).toBe(true);

    // An unresolved edge is kept and labelled rather than dropped: an import of
    // something outside the repo is exactly what a reader needs to see.
    const external = fromRoot.find((e) => e.to === "notify.sendExpiring")!;
    expect(external.resolved).toBe(false);
    expect(graph.nodes.some((n) => n.qualifiedName === "notify.sendExpiring")).toBe(false);

    // Every edge endpoint is either the root or a name it referenced; a
    // duplicated node would mean the visited-set stopped working. A resolved
    // edge resolves by the *last segment* of the name, so it is matched on the
    // node's simple `name` rather than on the qualified name it was asked for.
    expect(new Set(graph.nodes.map((n) => n.id)).size).toBe(graph.nodes.length);
    for (const edge of graph.edges) {
      if (!edge.resolved) continue;
      expect(graph.nodes.some((n) => n.name === edge.to.split(".").pop()), edge.to).toBe(true);
    }
  });

  it("returns an empty graph rather than throwing for an unknown root", async () => {
    const { dependencyGraph } = await import("@/lib/search/structural");
    const graph = await dependencyGraph(projectId, "no.such.symbol");
    expect(graph.root).toBeNull();
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.truncated).toBe(false);
  });

  it("honours the requested depth, and clamps a nonsensical one to the first level", async () => {
    const { dependencyGraph } = await import("@/lib/search/structural");

    const one = await dependencyGraph(projectId, "OrderService", { depth: 1 });
    expect(one.nodes.every((n) => n.depth <= 1)).toBe(true);
    expect(one.nodes.map((n) => n.qualifiedName)).toContain("OrderRepository.findById");

    // depth is clamped into [1, 4], so 0 and -5 must mean "one level", not
    // "root only" and not an unbounded walk.
    const zero = await dependencyGraph(projectId, "OrderService", { depth: 0 });
    const negative = await dependencyGraph(projectId, "OrderService", { depth: -5 });
    expect(zero.nodes.map((n) => n.id)).toEqual(one.nodes.map((n) => n.id));
    expect(negative.nodes.map((n) => n.id)).toEqual(one.nodes.map((n) => n.id));

    // A deeper walk can only add to the shallower one.
    const four = await dependencyGraph(projectId, "OrderService", { depth: 99 });
    expect(four.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(one.nodes.map((n) => n.id)));
    for (const node of four.nodes) expect(node.depth).toBeLessThanOrEqual(4);
  });

  it("truncates the walk at the node limit and says so", async () => {
    const { dependencyGraph } = await import("@/lib/search/structural");
    // limit is clamped to >= 1, so a request of 0 still yields the root and
    // still has to report that the walk was cut short.
    const graph = await dependencyGraph(projectId, "OrderService", { limit: 0 });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].qualifiedName).toBe("OrderService");
    expect(graph.truncated).toBe(true);
  });

  it("reassembles a stored file's chunks back onto the real file's line numbers", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { chunkBounds, assembleRange } = await import("@/lib/search/file-outline");
    const { workspaceForProject } = await import("@/lib/git/workspace");
    const { readFile } = await import("node:fs/promises");
    const db = prisma();

    // The unit tests in tests/file-api.test.ts drive these helpers with
    // synthetic chunks. This one runs them over what the pipeline actually
    // stored: overlapping declaration chunks, a gap block for the file's
    // leading imports, and a whitespace-only tail chunk that the parser drops.
    const file = await db.file.findFirst({
      where: { projectId, path: "src/orders/service.ts" },
    });
    expect(file).not.toBeNull();
    const chunks = await db.chunk.findMany({
      where: { fileId: file!.id },
      select: { content: true, startLine: true, endLine: true },
      orderBy: { startLine: "asc" },
    });
    expect(chunks.length).toBeGreaterThan(1);

    const source = (
      await readFile(join(workspaceForProject(projectId), "src/orders/service.ts"), "utf8")
    ).split("\n");

    const bounds = chunkBounds(chunks);
    expect(bounds).not.toBeNull();
    expect(bounds!.firstLine).toBe(1);
    expect(bounds!.lastLine).toBeLessThanOrEqual(source.length);

    const assembled = assembleRange(chunks, bounds!.firstLine, bounds!.lastLine);
    expect(assembled.lines).toHaveLength(bounds!.lastLine - bounds!.firstLine + 1);
    // Every line of this file is covered: the leading import block and the class
    // body span the whole thing. A gap here would mean the tools report a hole
    // in a file that has none.
    expect(assembled.missingLineCount).toBe(0);

    // The property that matters: line N of the reconstruction is line N of the
    // file. Concatenating the chunks would shift everything after the first
    // gap, which is exactly what placing chunks by their recorded startLine
    // prevents.
    const mismatches = assembled.lines
      .filter((line) => line.text !== source[line.lineNumber - 1])
      .map((line) => `${line.lineNumber}: ${JSON.stringify(line.text)} != ${JSON.stringify(source[line.lineNumber - 1])}`);
    expect(mismatches).toEqual([]);
    expect(assembled.lines[assembled.lines.length - 1].text.trim()).toBe("}");
  });

  it("bounds a hostile line window against the chunks' real extent", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { chunkBounds, assembleRange, MAX_FILE_CONTENT_LINES } = await import("@/lib/search/file-outline");
    const db = prisma();
    const file = await db.file.findFirst({ where: { projectId, path: "src/orders/service.ts" } });
    const chunks = await db.chunk.findMany({
      where: { fileId: file!.id },
      select: { content: true, startLine: true, endLine: true },
    });
    const bounds = chunkBounds(chunks)!;

    // assembleRange allocates one entry per line in the window, so a caller
    // passing endLine=999999999 against a 17-line file would otherwise build a
    // million-element array before any cap could apply. This is the path the
    // get_file_range MCP tool and the content route both take.
    const assembled = assembleRange(chunks, 0, 999_999_999);
    expect(assembled.lines.length).toBeLessThanOrEqual(MAX_FILE_CONTENT_LINES);
    expect(assembled.lines.length).toBe(bounds.lastLine - bounds.firstLine + 1);
    expect(assembled.lines[0].lineNumber).toBe(bounds.firstLine);
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

  it("finds tests by the symbols they mention, not by a path fragment", async () => {
    const { findTests } = await import("@/lib/search/structural");

    const all = await findTests(projectId);
    expect(all).toHaveLength(1);
    expect(all[0].path).toContain("orders.test.ts");

    // The fixture calls svc.cancelOrder(...). "cancelOrder" appears nowhere in
    // the file's path, so this used to return nothing: candidates were
    // pre-filtered with `path.includes(target)` before the mention count that
    // actually did the work ever ran.
    const bySymbol = await findTests(projectId, "cancelOrder");
    expect(bySymbol.map((t) => t.path)).toContain("orders.test.ts");

    expect(await findTests(projectId, "zzzNoSuchSymbolAnywhere")).toHaveLength(0);
  });

  it("resolves many symbols in one batched query", async () => {
    const { findSymbolsBatch, findSymbol } = await import("@/lib/search/structural");

    const names = ["OrderService", "OrderRepository.findById", "no.such.symbol", "OrderService"];
    const batch = await findSymbolsBatch(projectId, names);
    // Duplicates collapse; unresolvable names are simply absent.
    expect(batch.size).toBe(2);
    expect(batch.get("OrderService")!.kind).toBe("class");
    expect(batch.get("OrderRepository.findById")!.kind).toBe("method");

    // The batch must agree with the single lookup it replaces.
    const single = await findSymbol(projectId, "OrderRepository.findById");
    expect(batch.get("OrderRepository.findById")!.id).toBe(single!.id);

    expect((await findSymbolsBatch(projectId, [])).size).toBe(0);
  });

  it("applies the language filter to semantic search, not just lexical", async () => {
    const { semanticSearch } = await import("@/lib/search/semantic");
    // The filter used to be accepted by searchVectors and dropped, so the same
    // query returned rows in every language.
    const ts = await semanticSearch(projectId, "order", { limit: 10, languages: ["typescript"] });
    expect(ts.length).toBeGreaterThan(0);
    for (const hit of ts) expect(hit.payload.language).toBe("typescript");

    const none = await semanticSearch(projectId, "order", { limit: 10, languages: ["cobol"] });
    expect(none).toHaveLength(0);
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