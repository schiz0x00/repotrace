import { beforeEach, describe, expect, it, vi } from "vitest";

const { searchProject, buildContextBundle } = vi.hoisted(() => ({
  searchProject: vi.fn(),
  buildContextBundle: vi.fn(),
}));

// Hermetic: the index is a stub, so nothing here touches Postgres, Qdrant or
// the network. The point is the scoring and validation rules, not retrieval.
vi.mock("@/lib/search/search", () => ({ searchProject }));
vi.mock("@/lib/search/context", () => ({ buildContextBundle }));

import {
  aggregateResults,
  DEFAULT_SEARCH_MODE,
  evaluateQuestion,
  parseEvalQuestion,
  SEARCH_MODES,
  symbolHitAt,
  type EvalQuestion,
  type QuestionResult,
} from "@/lib/eval/recall";

function item(path: string, symbol: string | null) {
  return { path, symbol };
}

function question(over: Partial<EvalQuestion> = {}): EvalQuestion {
  return {
    id: "q1",
    projectSlug: "order-service",
    query: "where is order expiry scheduled",
    expectedFiles: ["src/orders/expiry.ts"],
    ...over,
  };
}

function result(over: Partial<QuestionResult> = {}): QuestionResult {
  return {
    id: "q1",
    query: "q",
    mode: "hybrid",
    expectedFiles: ["src/orders/expiry.ts"],
    expectedSymbols: [],
    recallFiles: {},
    recallSymbols: {},
    contextHitRate: null,
    topFiles: [],
    ...over,
  };
}

beforeEach(() => {
  searchProject.mockReset();
  buildContextBundle.mockReset();
  searchProject.mockResolvedValue({
    mode: "hybrid",
    query: "q",
    items: [
      item("src/other.ts", "Other.run"),
      item("src/orders/expiry.ts", "OrderService.scheduleExpiry"),
    ],
  });
});

describe("parseEvalQuestion", () => {
  it("accepts a well-formed question and drops the absent optional fields", () => {
    const parsed = parseEvalQuestion(
      {
        id: "expiry",
        projectSlug: "order-service",
        query: "where is order expiry scheduled",
        expectedFiles: ["src/orders/expiry.ts"],
      },
      "q.json question 1",
    );
    expect(parsed).toEqual({
      ok: true,
      question: {
        id: "expiry",
        projectSlug: "order-service",
        query: "where is order expiry scheduled",
        expectedFiles: ["src/orders/expiry.ts"],
        mode: undefined,
        expectedSymbols: undefined,
        notes: undefined,
      },
    });
  });

  it("keeps every mode searchProject actually implements", () => {
    for (const mode of SEARCH_MODES) {
      const parsed = parseEvalQuestion(question({ mode }), "q");
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.question.mode).toBe(mode);
    }
  });

  // searchProject has no error path for a mode it does not know: anything
  // unrecognised falls through to hybrid while the string is echoed back, so
  // the report used to print a mode that was never run.
  it("rejects an unrecognised mode and names the modes that exist", () => {
    const parsed = parseEvalQuestion(
      { id: "q", projectSlug: "p", query: "q", mode: "Hybrid", expectedFiles: ["a.ts"] },
      "data/evals/x.json question 2",
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].path).toBe("data/evals/x.json question 2 -> mode");
    expect(parsed.issues[0].message).toContain('"Hybrid"');
    expect(parsed.issues[0].message).toContain(SEARCH_MODES.join(", "));
    expect(parsed.issues[0].message).toContain(DEFAULT_SEARCH_MODE);
  });

  it("rejects a mode that is not even a string", () => {
    expect(parseEvalQuestion(question({ mode: 7 as never }), "q").ok).toBe(false);
  });

  it("rejects an empty expectedFiles, which would score 1.0", () => {
    const parsed = parseEvalQuestion(question({ expectedFiles: [] }), "q");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0].message).toContain("at least one path");
  });

  // The exact input behind a permanent 1.0 in the symbol columns.
  // An empty expectedSymbols is how a question says "I care about files, not
  // symbols" — and three of the ten questions in the project's own
  // data/evals/sample.json are written that way, so rejecting it made
  // `npm run eval` fail on the shipped fixture. The 1.0 it used to produce is
  // prevented downstream by not scoring symbol recall for such a question.
  it("accepts an empty expectedSymbols as no symbol expectation", () => {
    const parsed = parseEvalQuestion(question({ expectedSymbols: [] }), "q");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.question.expectedSymbols).toBeUndefined();
  });

  it("still rejects an empty expectedFiles, which cannot be scored at all", () => {
    const parsed = parseEvalQuestion(question({ expectedFiles: [] }), "q");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0].path).toBe("q -> expectedFiles");
  });

  it("rejects a misspelled expectation field rather than ignoring it", () => {
    const parsed = parseEvalQuestion(
      { id: "q", projectSlug: "p", query: "q", expectedFiles: ["a.ts"], expectedFile: ["a.ts"] },
      "q",
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.some((i) => i.path === "q -> expectedFile")).toBe(true);
  });

  it("rejects a non-object, a missing query, a missing slug and a bad entry type", () => {
    expect(parseEvalQuestion(["a"], "q").ok).toBe(false);
    expect(parseEvalQuestion("a", "q").ok).toBe(false);
    const parsed = parseEvalQuestion(
      { id: "q", projectSlug: "  ", query: "  ", expectedFiles: ["a.ts", 3] },
      "q",
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.map((i) => i.path).sort()).toEqual([
      "q -> expectedFiles",
      "q -> projectSlug",
      "q -> query",
    ]);
  });

  it("enforces the same 25-path ceiling the API enforces", () => {
    const many = Array.from({ length: 26 }, (_, i) => `src/${i}.ts`);
    const parsed = parseEvalQuestion(question({ expectedFiles: many }), "q");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0].message).toContain("at most 25");
  });

  it("reports every problem at once rather than the first", () => {
    const parsed = parseEvalQuestion({ id: "", mode: "nope", expectedSymbols: [1] }, "q");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe("symbolHitAt", () => {
  it("reports nothing measured instead of a perfect score when there is nothing to score", () => {
    expect(symbolHitAt(["A.b"], [], 5)).toBeNull();
  });

  it("still scores a real expectation", () => {
    expect(symbolHitAt(["OrderService.scheduleExpiry"], ["OrderService"], 5)).toBe(1);
  });
});

describe("evaluateQuestion", () => {
  it("scores file recall and omits symbol recall for a question with no expected symbols", async () => {
    const r = await evaluateQuestion("p1", question(), 10);
    expect(r.error).toBeUndefined();
    expect(r.recallFiles[5]).toBe(1);
    // The whole point: this used to be { 5: 1, 10: 1 } on every API question.
    expect(r.recallSymbols).toEqual({});
    expect(r.expectedSymbols).toEqual([]);
  });

  it("scores symbol recall when the question states expected symbols", async () => {
    const r = await evaluateQuestion("p1", question({ expectedSymbols: ["OrderService"] }), 10);
    expect(r.recallSymbols[5]).toBe(1);
    expect(r.recallSymbols[10]).toBe(1);
  });

  it("reports a partial symbol score as a number, not as 1", async () => {
    searchProject.mockResolvedValue({
      items: [item("src/other.ts", "Other.run")],
    });
    const r = await evaluateQuestion("p1", question({ expectedSymbols: ["OrderService"] }), 10);
    expect(r.recallSymbols[5]).toBe(0);
  });

  it("passes the question's mode to searchProject", async () => {
    await evaluateQuestion("p1", question({ mode: "lexical" }), 5);
    expect(searchProject).toHaveBeenCalledWith("p1", question().query, { mode: "lexical", limit: 5 });
  });

  it("records a search failure without inventing a score", async () => {
    searchProject.mockRejectedValue(new Error("qdrant unreachable"));
    const r = await evaluateQuestion("p1", question(), 10);
    expect(r.error).toBe("qdrant unreachable");
    expect(r.recallFiles).toEqual({});
    expect(r.recallSymbols).toEqual({});
  });

  it("leaves the context hit rate null unless the caller asks for the bundle", async () => {
    expect((await evaluateQuestion("p1", question(), 10)).contextHitRate).toBeNull();
    expect(buildContextBundle).not.toHaveBeenCalled();

    buildContextBundle.mockResolvedValue({
      symbols: [{ path: "src/orders/expiry.ts" }],
      docs: [],
      relatedSymbols: [],
      tests: [],
    });
    const r = await evaluateQuestion("p1", question(), 10, true);
    expect(r.contextHitRate).toBe(1);
  });
});

describe("aggregateResults with unscoreable symbol questions", () => {
  // This is the shape the eval API always produces: the table stores no
  // symbols, so every question has none and the aggregate must not invent a 1.
  it("reports null symbol recall and a zero denominator when no question has symbols", () => {
    const agg = aggregateResults([
      result({ recallFiles: { 5: 1, 10: 1 }, recallSymbols: {} }),
      result({ id: "q2", recallFiles: { 5: 0, 10: 0.5 }, recallSymbols: {} }),
    ]);
    expect(agg.questions).toBe(2);
    expect(agg.recallFilesAt5).toBeCloseTo(0.5, 5);
    expect(agg.recallSymbolsAt5).toBeNull();
    expect(agg.recallSymbolsAt10).toBeNull();
    expect(agg.symbolQuestions).toBe(0);
  });

  it("averages symbols over the questions that had them, and says how many those were", () => {
    const agg = aggregateResults([
      result({ id: "with", recallFiles: { 5: 1 }, recallSymbols: { 5: 1, 10: 1 } }),
      result({ id: "without", recallFiles: { 5: 1 }, recallSymbols: {} }),
      result({ id: "with2", recallFiles: { 5: 1 }, recallSymbols: { 5: 0, 10: 0 } }),
    ]);
    expect(agg.symbolQuestions).toBe(2);
    expect(agg.recallSymbolsAt5).toBeCloseTo(0.5, 5);
    // File recall still averages over all three.
    expect(agg.recallFilesAt5).toBe(1);
  });

  it("does not count a failed question towards the symbol denominator", () => {
    const agg = aggregateResults([
      result({ recallFiles: { 5: 1 }, recallSymbols: { 5: 1, 10: 1 } }),
      result({ id: "boom", error: "down" }),
    ]);
    expect(agg.failed).toBe(1);
    expect(agg.symbolQuestions).toBe(1);
    expect(agg.recallSymbolsAt5).toBe(1);
  });
});
