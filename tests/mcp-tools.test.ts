import { describe, expect, it } from "vitest";
import {
  emptyCommitPage,
  endOfCommitHistory,
  formatGraph,
  formatLineRange,
  formatOutline,
  formatSearch,
  formatSymbol,
  readRange,
} from "@/lib/mcp/server";
import type { SearchResponse } from "@/lib/search/search";
import type { DependencyGraph, SymbolHit } from "@/lib/search/structural";
import { redactUrl } from "@/lib/git/git";

/**
 * These cover the pure formatting helpers behind the MCP tools — no database,
 * no network. The tools themselves need a scoped Principal and a live project
 * to exercise, so what is tested here is the part that decides what an agent
 * actually reads: whether a line number means what it says, and whether a
 * partial answer is ever presented as a whole one.
 */

function symbolHit(over: Partial<SymbolHit> = {}): SymbolHit {
  return {
    id: "s1",
    name: "cancelOrder",
    qualifiedName: "OrderService.cancelOrder",
    kind: "method",
    language: "typescript",
    path: "src/orders/service.ts",
    startLine: 10,
    endLine: 30,
    parentName: "OrderService",
    calls: ["findOrder", "emitEvent"],
    imports: [],
    extends: [],
    implements: [],
    ...over,
  };
}

function searchResponse(over: Partial<SearchResponse> = {}): SearchResponse {
  return {
    mode: "hybrid",
    query: "cancel order",
    project: { id: "p1", slug: "shop", name: "Shop" },
    items: [],
    sources: { vector: 0, lexical: 0, symbol: 0 },
    tookMs: 3,
    ...over,
  };
}

function item(over: Partial<SearchResponse["items"][number]> = {}) {
  return {
    chunkId: "c1",
    fileId: "f1",
    path: "src/orders/service.ts",
    language: "typescript",
    symbol: "OrderService.cancelOrder",
    symbolKind: "method",
    startLine: 10,
    endLine: 30,
    content: "async cancelOrder(id) { return db.order.cancel(id); }",
    chunkType: "code" as const,
    score: 1,
    hybridScore: 0.93,
    provenance: ["hybrid" as const],
    ...over,
  };
}

describe("formatSearch", () => {
  it("reports an empty result set without a phantom hit", () => {
    const text = formatSearch(searchResponse());
    expect(text).toContain("No results.");
    expect(text).not.toContain("###");
  });

  // Regression: the header interpolated `${item.symbol ?? item.path}` followed
  // by `${item.symbol ? "" : ""}` — both branches of that ternary were the empty
  // string, so it contributed nothing and only obscured the intent.
  it("emits exactly one header line per hit with no stray interpolation", () => {
    const text = formatSearch(
      searchResponse({ items: [item(), item({ path: "src/orders/repo.ts", symbol: null })] }),
    );
    const headers = text.split("\n").filter((l) => l.startsWith("### "));
    expect(headers).toEqual(["### OrderService.cancelOrder", "### src/orders/repo.ts"]);
  });

  it("falls back to the path when a hit has no symbol", () => {
    const text = formatSearch(searchResponse({ items: [item({ symbol: null })] }));
    expect(text).toContain("### src/orders/service.ts");
  });

  it("points at get_file_range instead of printing a blank line for a contentless hit", () => {
    const text = formatSearch(searchResponse({ items: [item({ content: "" })] }));
    expect(text).toContain("get_file_range");
    // No header line may be followed by an empty line: that is the exact
    // failure mode this case exists to prevent.
    const lines = text.split("\n");
    const headerIdx = lines.findIndex((l) => l.startsWith("### "));
    expect(lines[headerIdx + 1]).toContain("src/orders/service.ts:10-30");
    expect(lines[headerIdx + 2]).not.toBe("");
  });

  it("truncates a long body and says so", () => {
    const text = formatSearch(searchResponse({ items: [item({ content: "x".repeat(5000) })] }));
    expect(text).toContain("… (truncated)");
    expect(text.length).toBeLessThan(2000);
  });
});

describe("formatSymbol", () => {
  it("renders a SymbolHit without intersecting it into a nullable union", () => {
    const text = formatSymbol(symbolHit());
    expect(text).toBe(
      [
        "OrderService.cancelOrder (method, typescript)",
        "src/orders/service.ts:10-30",
        "parent: OrderService",
        "calls: findOrder, emitEvent",
      ].join("\n"),
    );
  });

  it("omits the optional lines rather than printing nulls", () => {
    const text = formatSymbol(
      symbolHit({ parentName: null, calls: [], imports: ["zod", "next/server"] }),
    );
    expect(text).not.toContain("parent:");
    expect(text).not.toContain("calls:");
    expect(text).toContain("imports: zod, next/server");
  });
});

describe("readRange + formatLineRange", () => {
  const file = {
    path: "src/a.ts",
    language: "typescript",
    lastIndexedCommit: "abcdef1234",
    chunks: [
      { startLine: 1, endLine: 5, content: "a\nb\nc\nd\ne" },
    ],
  };
  const ten = {
    ...file,
    chunks: [
      {
        startLine: 1,
        endLine: 10,
        content: Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"),
      },
    ],
  };

  it("returns null for a file with no indexed chunks", () => {
    const empty = { path: file.path, language: file.language, lastIndexedCommit: file.lastIndexedCommit };
    const view = readRange({ ...file, chunks: [] }, 1, 10, 100);
    expect(view).toBeNull();
    expect(formatLineRange(empty, view)).toContain("No indexed content for this file.");
  });

  it("numbers every line against the requested start", () => {
    const view = readRange(file, 2, 4, 100)!;
    expect(view.from).toBe(2);
    expect(view.to).toBe(4);
    expect(view.missingLineCount).toBe(0);
    const text = formatLineRange(file, view);
    expect(text).toContain("--- src/a.ts (typescript, indexed commit abcdef12) ---");
    expect(text).toContain("2 | b\n3 | c\n4 | d");
    expect(text).not.toContain("1 | a");
  });

  it("clamps a request that runs past the end of the indexed file and says so", () => {
    const view = readRange(ten, 8, 500, 100)!;
    expect(view.to).toBe(10);
    expect(view.clampedToBounds).toBe(true);
    const text = formatLineRange(ten, view);
    expect(text).toContain("the indexed file ends at line 10; showing 8-10");
    expect(text).not.toContain("[truncated");
  });

  // The clamped-to-bounds notice used to sit in the same if/else-if chain as the
  // truncation notices, so the character cap firing in the same call silenced
  // it: the agent asked for lines 1-500, was handed a short slice, and was
  // never told the indexed file stopped at line 10.
  it("reports the character cap and the end of the file in the same call", () => {
    // Two 60,000-character lines against a 100,000-character cap: line 1 fits,
    // line 2 does not, so the cap cuts between lines and reports line 2.
    const chunky = {
      ...ten,
      chunks: [
        {
          startLine: 1,
          endLine: 10,
          content: Array.from({ length: 10 }, (_, i) => `${i + 1}`.repeat(60_000)).join("\n"),
        },
      ],
    };
    const view = readRange(chunky, 1, 500, 20)!;
    expect(view.clampedToBounds).toBe(true);
    expect(view.nextLine).toBe(2);
    const text = formatLineRange(chunky, view);
    expect(text).toContain("[truncated of the requested 1-500: showing 1-1 of 1-10. Continue with startLine=2.]");
    expect(text).toContain("the indexed file ends at line 10; showing 1-1");
  });

  it("reports the maxLines cut and the end of the file together", () => {
    // maxLines cuts at line 9 and the file has 10 lines, so line 10 is still
    // there to read: the resume point is real, and both notices are true at once.
    const view = readRange(ten, 1, 500, 9)!;
    expect(view.truncatedByMaxLines).toBe(true);
    expect(view.clampedToBounds).toBe(true);
    const text = formatLineRange(ten, view);
    expect(text).toContain("showing 1-9. Continue with startLine=10.");
    expect(text).toContain("the indexed file ends at line 10; showing 1-9");
  });

  it("reports a start line before the indexed extent", () => {
    const view = readRange({ ...file, chunks: [{ startLine: 10, endLine: 12, content: "j\nk\nl" }] }, 1, 3, 100)!;
    expect(view.clampedToBounds).toBe(true);
    expect(formatLineRange(file, view)).toContain("fell outside the indexed lines 10-12");
  });

  it("truncates to the tool's maxLines and hands back the resume point", () => {
    const view = readRange(ten, 1, 10, 4)!;
    expect(view.truncatedByMaxLines).toBe(true);
    expect(view.lines.map((l) => l.lineNumber)).toEqual([1, 2, 3, 4]);
    const text = formatLineRange(ten, view);
    expect(text).toContain("truncated of the requested 1-10: showing 1-4. Continue with startLine=5.");
  });

  it("defaults endLine to the cap rather than to the end of the file", () => {
    const view = readRange(ten, 1, undefined, 4)!;
    expect(view.truncatedByMaxLines).toBe(true);
    expect(view.to).toBe(4);
    // No endLine was given, so the notice must not invent one.
    expect(formatLineRange(ten, view)).toContain("[truncated: showing 1-4. Continue with startLine=5.]");
  });

  it("reads a default endLine without truncating when the file is short enough", () => {
    const view = readRange(ten, 1, undefined, 100)!;
    expect(view.to).toBe(10);
    expect(view.truncatedByMaxLines).toBe(false);
    expect(view.clampedToBounds).toBe(false);
    expect(formatLineRange(ten, view)).not.toContain("[");
  });

  it("distinguishes an index gap from a blank source line", () => {
    // Lines 1-2 and 5-6 are indexed; 3-4 sit in a hole between two chunks.
    const holed = {
      ...file,
      chunks: [
        { startLine: 1, endLine: 2, content: "a\nb" },
        { startLine: 5, endLine: 6, content: "e\nf" },
      ],
    };
    const view = readRange(holed, 1, 6, 100)!;
    expect(view.clampedToBounds).toBe(false);
    expect(view.missingLineCount).toBe(2);
    const text = formatLineRange(holed, view);
    expect(text).toContain("3 | \n4 | ");
    expect(text).toContain("2 lines in this range are not in the index and are shown blank");
  });

  it("uses the singular for a single missing line", () => {
    const holed = {
      ...file,
      chunks: [
        { startLine: 1, endLine: 2, content: "a\nb" },
        { startLine: 4, endLine: 4, content: "d" },
      ],
    };
    const view = readRange(holed, 1, 4, 100)!;
    expect(view.missingLineCount).toBe(1);
    expect(formatLineRange(holed, view)).toContain("1 line in this range are not in the index");
  });

  it("reads a single line as a one-line range", () => {
    const view = readRange(file, 2, 2, 10)!;
    expect(formatLineRange(file, view)).toContain("2 | b");
    expect(view.missingLineCount).toBe(0);
  });
});

describe("formatOutline", () => {
  const file = { path: "src/a.ts", language: "typescript", lastIndexedCommit: "abcdef1234" };

  it("lists symbols in order with line ranges and calls", () => {
    // Ordered by startLine, as the query returns them.
    const text = formatOutline(file, [
      {
        name: "OrderService",
        qualifiedName: "OrderService",
        kind: "class",
        startLine: 1,
        endLine: 60,
        parentName: null,
        metadata: null,
      },
      {
        name: "cancelOrder",
        qualifiedName: "OrderService.cancelOrder",
        kind: "method",
        startLine: 10,
        endLine: 30,
        parentName: "OrderService",
        metadata: { calls: ["findOrder", "emitEvent"] },
      },
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toContain("src/a.ts (typescript, indexed commit abcdef12) — 2 symbols");
    expect(lines[1]).toContain("class OrderService");
    expect(lines[2]).toContain("method OrderService.cancelOrder in OrderService");
    expect(lines[2]).toContain("calls: findOrder, emitEvent");
  });

  it("uses the singular for a one-symbol file", () => {
    const text = formatOutline(file, [
      {
        name: "a",
        qualifiedName: "a",
        kind: "function",
        startLine: 1,
        endLine: 2,
        parentName: null,
        metadata: null,
      },
    ]);
    expect(text).toContain("— 1 symbol ---");
  });

  it("never presents a truncated outline as the whole file", () => {
    const text = formatOutline(
      file,
      [
        {
          name: "a",
          qualifiedName: "a",
          kind: "function",
          startLine: 1,
          endLine: 2,
          parentName: null,
          metadata: null,
        },
      ],
      true,
    );
    expect(text).toContain("[truncated: showing the first 1 symbols. Narrow the file or raise `limit`.]");
  });

  it("handles a file with no indexed symbols", () => {
    const text = formatOutline(file, []);
    expect(text).toContain("No symbols indexed for this file.");
  });

  it("survives a malformed metadata column", () => {
    const text = formatOutline(file, [
      {
        name: "a",
        qualifiedName: "a",
        kind: "function",
        startLine: 1,
        endLine: 2,
        parentName: null,
        metadata: { calls: "not-an-array" },
      },
    ]);
    expect(text).toContain("function a");
    expect(text).not.toContain("calls:");
  });
});

describe("formatGraph", () => {
  function graph(over: Partial<DependencyGraph> = {}): DependencyGraph {
    return {
      root: {
        id: "s1",
        name: "cancelOrder",
        qualifiedName: "OrderService.cancelOrder",
        kind: "method",
        language: "typescript",
        path: "src/orders/service.ts",
        startLine: 10,
        endLine: 30,
        depth: 0,
      },
      nodes: [
        {
          id: "s1",
          name: "cancelOrder",
          qualifiedName: "OrderService.cancelOrder",
          kind: "method",
          language: "typescript",
          path: "src/orders/service.ts",
          startLine: 10,
          endLine: 30,
          depth: 0,
        },
        {
          id: "s2",
          name: "findOrder",
          qualifiedName: "findOrder",
          kind: "function",
          language: "typescript",
          path: "src/orders/repo.ts",
          startLine: 1,
          endLine: 5,
          depth: 1,
        },
      ],
      edges: [
        { from: "OrderService.cancelOrder", to: "findOrder", kind: "calls", resolved: true },
        { from: "OrderService.cancelOrder", to: "zod", kind: "imports", resolved: false },
      ],
      truncated: false,
      truncation: { nodes: false, edges: false },
      ...over,
    };
  }

  it("shows the root, the reachable nodes and every edge", () => {
    const text = formatGraph(graph());
    expect(text).toContain("Dependency graph for OrderService.cancelOrder (method)");
    expect(text).toContain("src/orders/service.ts:10-30");
    expect(text).toContain("findOrder (function) src/orders/repo.ts:1-5");
    expect(text).toContain("OrderService.cancelOrder --calls--> findOrder");
  });

  // An unresolved edge is a library import. Dropping it would hide the
  // coupling; the node list cannot show it because no node exists.
  it("keeps unresolved edges and labels them", () => {
    const text = formatGraph(graph());
    expect(text).toContain("OrderService.cancelOrder --imports--> zod  (unresolved: outside this project)");
  });

  it("says so when the node cap truncated the walk", () => {
    const text = formatGraph(graph({ truncated: true, truncation: { nodes: true, edges: false } }));
    expect(text).toContain("[truncated: node cap reached.");
    // The lever must be one the schema actually accepts: `maxNodes` runs 1-200.
    expect(text).toContain("maxNodes");
  });

  // The previous edge-cap message told the caller to "lower depth". The schema
  // accepts depth 1-3 and defaults to 1, so anyone using the defaults is
  // already at the floor and cannot act on it: the one piece of advice a
  // truncated-graph message most needs to give is advice that works.
  it("never tells a default caller to lower depth, which is already at its floor", () => {
    const text = formatGraph(graph({ truncated: true, truncation: { nodes: false, edges: true } }));
    expect(text).toContain("[truncated: edge cap reached.");
    expect(text).not.toMatch(/[Ll]ower(ing)? `depth` is the reliable lever/);
    // It should say what does work instead.
    expect(text).toMatch(/Narrow `symbol`/);
  });

  // Raising `maxNodes` is not a lever for the edge cap either. The walk's budget
  // is `4 * maxNodes` with a floor of 64, so the default 60 already gives 240 —
  // exactly the number of edges the tool prints, at every `maxNodes`. Raising it
  // changes which edges are printed, never how many, so a message that sends
  // the agent off to raise it is spending a round trip on a no-op.
  it("does not offer maxNodes as a lever for the edge cap", () => {
    const text = formatGraph(graph({ truncated: true, truncation: { nodes: false, edges: true } }));
    expect(text).not.toMatch(/raising `maxNodes` raises it too/);
    expect(text).toMatch(/at the default of 60 the walk's budget is already the 240 edges this tool prints/);
    // `maxNodes` may still be named, but only to say it will not help.
    expect(text).toMatch(/Raising `maxNodes` will not show you more/);
  });

  it("does not claim the node cap can be relieved by lowering depth either", () => {
    const text = formatGraph(graph({ truncated: true, truncation: { nodes: true, edges: false } }));
    // Raising maxNodes genuinely does admit more symbols, so that advice stays.
    expect(text).toMatch(/Raise `maxNodes` \(accepted range 1-200\)/);
    // But `depth` defaults to 1, the schema minimum, so it is not a lever.
    expect(text).toMatch(/`depth` is not a lever here/);
  });

  it("names both bounds when both were hit", () => {
    const text = formatGraph(graph({ truncated: true, truncation: { nodes: true, edges: true } }));
    expect(text).toContain("node cap reached");
    expect(text).toContain("edge cap reached");
  });

  it("bounds the edge list and says how many were dropped", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      from: "a",
      to: `b${i}`,
      kind: "calls" as const,
      resolved: true,
    }));
    const text = formatGraph(graph({ edges: many }));
    expect(text).toContain("… 160 more edges not shown");
    // The honest claim here is that nothing on the tool raises the print ceiling.
    // Raising `maxNodes` is what makes these hidden edges exist at all, but it
    // cannot show more of them, so the message must not send the agent there.
    expect(text).toContain("no argument raises that");
  });

  it("reports a missing root symbol", () => {
    expect(
      formatGraph({
        root: null,
        nodes: [],
        edges: [],
        truncated: false,
        truncation: { nodes: false, edges: false },
      }),
    ).toBe("Symbol not found.");
  });
});

describe("list_commits paging messages", () => {
  // An empty page is the same zero rows in two different situations, and the
  // advice is opposite: one says "nothing was ever indexed here", the other says
  // "stop, you have read everything there is". Telling an agent that paged to
  // the end that history is captured during indexing sends it off to re-index a
  // branch it has already finished reading.
  it("tells a caller that paged to the end that it reached the end", () => {
    const text = emptyCommitPage("main", true);
    expect(text).toMatch(/^No more commits recorded for branch main\./);
    expect(text).toContain("reached the end of the history captured during indexing");
    expect(text).not.toContain("never indexed");
  });

  it("tells a first-time caller that nothing was recorded for the branch", () => {
    const text = emptyCommitPage("main", false);
    expect(text).toMatch(/^No commits recorded for branch main\./);
    expect(text).toContain("never indexed");
    expect(text).not.toContain("reached the end");
  });

  it("marks a short page as the end of the recorded history", () => {
    expect(endOfCommitHistory("main")).toBe("[end of recorded history for branch main]");
  });
});

describe("repository URL redaction in MCP output", () => {
  // A repository URL is whatever the operator typed. For a private repository
  // that is routinely https://user:token@host/org/repo.git. The REST project
  // DTO strips the userinfo; the MCP tools selected the raw column and
  // returned it, so list_projects and get_project handed the credential to
  // every client holding the project's key — the one surface that did not
  // redact.
  it("strips userinfo from a repository URL", () => {
    expect(redactUrl("https://x-access-token:ghp_supersecret@github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git",
    );
    expect(redactUrl("https://github.com/org/repo.git")).toBe("https://github.com/org/repo.git");
  });

  it("leaves an ssh remote alone, since its username is not a credential", () => {
    expect(redactUrl("ssh://git@github.com/org/repo.git")).toBe("ssh://git@github.com/org/repo.git");
  });

  it("never emits the token, whatever the shape", () => {
    const secret = "ghp_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    for (const url of [
      `https://x-access-token:${secret}@github.com/org/repo.git`,
      `https://${secret}@github.com/org/repo.git`,
      `https://user:${secret}@github.com/org/repo.git`,
    ]) {
      expect(redactUrl(url), url).not.toContain(secret);
    }
  });
});
