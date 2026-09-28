import { describe, expect, it } from "vitest";
import {
  aggregateResults,
  normalizePath,
  recallAt,
  symbolHitAt,
  type QuestionResult,
} from "@/lib/eval/recall";

/**
 * The dashboard and `npm run eval` both score through this module, so these
 * assertions pin the single definition of recall that both depend on.
 */
describe("normalizePath", () => {
  it("strips a leading ./", () => {
    expect(normalizePath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizePath("src/a.ts")).toBe("src/a.ts");
  });
});

describe("recallAt", () => {
  it("is the fraction of expected files present in the top k", () => {
    expect(recallAt(["a", "b", "c"], ["a", "b"], 2)).toBe(1);
    expect(recallAt(["a", "b", "c"], ["a", "z"], 2)).toBe(0.5);
    expect(recallAt(["a"], ["a", "b", "c"], 5)).toBeCloseTo(1 / 3, 5);
  });

  it("only counts hits inside the top k", () => {
    expect(recallAt(["x", "y", "a"], ["a"], 2)).toBe(0);
    expect(recallAt(["x", "y", "a"], ["a"], 3)).toBe(1);
  });

  it("normalises paths on both sides", () => {
    expect(recallAt(["./src/a.ts"], ["src/a.ts"], 5)).toBe(1);
  });

  it("treats an empty expectation as fully recalled", () => {
    expect(recallAt(["a"], [], 5)).toBe(1);
  });
});

describe("symbolHitAt", () => {
  it("matches a symbol, its members, or its parent", () => {
    expect(symbolHitAt(["OrderService.cancelOrder"], ["OrderService.cancelOrder"], 5)).toBe(1);
    expect(symbolHitAt(["OrderService.cancelOrder"], ["OrderService"], 5)).toBe(1);
    expect(symbolHitAt(["OrderService"], ["OrderService.cancelOrder"], 5)).toBe(1);
  });

  it("does not match an unrelated symbol", () => {
    expect(symbolHitAt(["OrderService.cancelOrder"], ["Invoice.total"], 5)).toBe(0);
  });

  it("ignores null symbol slots and respects the cutoff", () => {
    expect(symbolHitAt([null, null], ["Order"], 5)).toBe(0);
    expect(symbolHitAt([null, "Order"], ["Order"], 2)).toBe(1);
    expect(symbolHitAt(["Order"], ["Order"], 0)).toBe(0);
  });
});

function result(over: Partial<QuestionResult>): QuestionResult {
  return {
    id: "q",
    query: "q",
    mode: "hybrid",
    expectedFiles: [],
    expectedSymbols: [],
    recallFiles: {},
    recallSymbols: {},
    contextHitRate: null,
    topFiles: [],
    ...over,
  };
}

describe("aggregateResults", () => {
  it("averages recall across questions that actually ran", () => {
    const agg = aggregateResults([
      result({ recallFiles: { 5: 1, 10: 1 }, recallSymbols: { 5: 1, 10: 1 } }),
      result({ recallFiles: { 5: 0, 10: 0.5 }, recallSymbols: { 5: 0, 10: 0.5 } }),
    ]);
    expect(agg.questions).toBe(2);
    expect(agg.failed).toBe(0);
    expect(agg.recallFilesAt5).toBeCloseTo(0.5, 5);
    expect(agg.recallFilesAt10).toBeCloseTo(0.75, 5);
    expect(agg.recallSymbolsAt5).toBeCloseTo(0.5, 5);
  });

  // A question that errored has no scores; counting it as zero would make a
  // dependency outage look like a retrieval regression.
  it("excludes failed questions from the averages and counts them separately", () => {
    const agg = aggregateResults([
      result({ recallFiles: { 5: 1, 10: 1 } }),
      result({ error: "qdrant unreachable" }),
    ]);
    expect(agg.failed).toBe(1);
    expect(agg.recallFilesAt5).toBe(1);
    expect(agg.recallFilesAt10).toBe(1);
  });

  it("reports null rather than 0 when nothing ran", () => {
    const agg = aggregateResults([result({ error: "boom" })]);
    expect(agg.recallFilesAt5).toBeNull();
    expect(agg.recallFilesAt10).toBeNull();
    expect(agg.contextHitRate).toBeNull();
  });

  it("averages the context hit rate only where it was computed", () => {
    const agg = aggregateResults([
      result({ recallFiles: { 5: 1 }, contextHitRate: 1 }),
      result({ recallFiles: { 5: 1 }, contextHitRate: 0 }),
      result({ recallFiles: { 5: 1 }, contextHitRate: null }),
    ]);
    expect(agg.contextHitRate).toBeCloseTo(0.5, 5);
  });
});
