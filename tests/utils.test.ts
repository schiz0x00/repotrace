import { describe, expect, it } from "vitest";
import { mergeAndRerank, type SearchResultItem } from "@/lib/search/hybrid";
import type { VectorHit } from "@/lib/qdrant";
import type { LexicalHit } from "@/lib/search/lexical";
import { buildTsQuery } from "@/lib/search/lexical";

function payload(path: string, startLine: number, content = "chunk"): VectorHit["payload"] {
  return {
    project_id: "p1",
    file_id: "f1",
    chunk_id: `${path}:${startLine}`,
    path,
    symbol: null,
    kind: null,
    language: "typescript",
    module: null,
    start_line: startLine,
    end_line: startLine + 4,
    content_hash: "hash",
    embedding_model: "mock",
    embedding_version: 1,
    chunk_type: "code",
    content,
  };
}

function lexicalHit(path: string, startLine: number, score: number): LexicalHit {
  return {
    chunkId: `${path}:${startLine}`,
    fileId: "f1",
    path,
    language: "typescript",
    symbol: null,
    symbolKind: null,
    startLine,
    endLine: startLine + 4,
    content: "chunk",
    chunkType: "code",
    score,
  };
}

function names(items: SearchResultItem[]) {
  return items.map((i) => `${i.path}:${i.startLine}`);
}

describe("mergeAndRerank", () => {
  it("normalizes a single lexical hit to a score of 1", () => {
    const result = mergeAndRerank(
      { vectorHits: [], lexicalHits: [lexicalHit("a.ts", 1, 2)], symbolHits: [] },
      { limit: 5 },
    );
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.score).toBe(1);
    expect(item.provenance).toEqual(["lexical"]);
    expect(result.sources).toEqual({ vector: 0, lexical: 1, symbol: 0 });
  });

  it("dedupes vector and lexical hits for the same chunk and boosts provenance", () => {
    const result = mergeAndRerank(
      {
        vectorHits: [{ score: 0.8, payload: payload("a.ts", 1) }],
        lexicalHits: [lexicalHit("a.ts", 1, 0.5)],
        symbolHits: [],
      },
      { limit: 5 },
    );
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.provenance).toEqual(["vector", "lexical"]);
    expect(item.score).toBe(1);
    expect(result.sources.vector).toBe(1);
    expect(result.sources.lexical).toBe(1);
    expect(item.hybridScore).toBeGreaterThan(item.score);
  });

  it("keeps distinct chunks separate and orders by hybridScore", () => {
    const result = mergeAndRerank(
      {
        vectorHits: [
          { score: 0.9, payload: payload("vector-only.ts", 1) },
          { score: 0.6, payload: payload("shared.ts", 10) },
        ],
        lexicalHits: [lexicalHit("shared.ts", 10, 0.5)],
        symbolHits: [],
      },
      { limit: 5, lexicalWeight: 0.45 },
    );
    expect(result.items).toHaveLength(2);
    expect(names(result.items)).toContain("vector-only.ts:1");
    expect(names(result.items)).toContain("shared.ts:10");
    const shared = result.items.find((i) => i.path === "shared.ts");
    expect(shared!.provenance).toContain("vector");
    expect(shared!.provenance).toContain("lexical");
  });

  it("respects the limit and counts sources across all items", () => {
    const result = mergeAndRerank(
      {
        vectorHits: [
          { score: 1, payload: payload("a.ts", 1) },
          { score: 0.5, payload: payload("b.ts", 1) },
          { score: 0.2, payload: payload("c.ts", 1) },
        ],
        lexicalHits: [lexicalHit("a.ts", 1, 1), lexicalHit("d.ts", 5, 1)],
        symbolHits: [],
      },
      { limit: 2 },
    );
    expect(result.items).toHaveLength(2);
    expect(result.sources.vector).toBeGreaterThan(0);
    expect(result.sources.lexical).toBeGreaterThan(0);
  });

  // Regression: the rerank used `item.score` as BOTH the vector and the lexical
  // contribution. A chunk found by both sources had its single max score
  // counted twice, so dual-source hits were inflated past their actual evidence
  // and the separate multi-source bonus was paid on top of a double count.
  it("scores a dual-source hit using each source's own score, not the max twice", () => {
    // "dual.ts" ranks first by vector (normalised 1.0) but only second by
    // lexical (normalised 0.4), so the two contributions genuinely differ.
    //   old: 0.55*max(1.0,0.4) + 0.45*max(1.0,0.4) = 0.55 + 0.45 = 1.00
    //   new: 0.55*1.0            + 0.45*0.4        = 0.55 + 0.18 = 0.73
    const result = mergeAndRerank(
      {
        vectorHits: [
          { score: 1.0, payload: payload("dual.ts", 1) },
          { score: 0.9, payload: payload("solo.ts", 1) },
        ],
        lexicalHits: [lexicalHit("other.ts", 1, 1.0), lexicalHit("dual.ts", 1, 0.4)],
        symbolHits: [],
      },
      { limit: 5, lexicalWeight: 0.45 },
    );
    const dual = result.items.find((i) => i.path === "dual.ts")!;
    // + multiSource (0.30) + rrf*0.3 (~0.010)
    expect(dual.hybridScore).toBeCloseTo(0.73 + 0.3 + 0.0104, 3);
    // A double-counted max would land near 1.31.
    expect(dual.hybridScore).toBeLessThan(1.2);
  });

  it("ranks a single-source hit below a comparable dual-source hit", () => {
    const result = mergeAndRerank(
      {
        vectorHits: [
          { score: 1.0, payload: payload("both.ts", 1) },
          { score: 0.95, payload: payload("only-vector.ts", 1) },
        ],
        lexicalHits: [lexicalHit("both.ts", 1, 1.0)],
        symbolHits: [],
      },
      { limit: 5 },
    );
    expect(result.items[0].path).toBe("both.ts");
  });

  it("is deterministic: identical inputs give identical ordering", () => {
    const build = () =>
      mergeAndRerank(
        {
          vectorHits: [
            { score: 0.5, payload: payload("tie-b.ts", 1) },
            { score: 0.5, payload: payload("tie-a.ts", 1) },
            { score: 0.5, payload: payload("tie-c.ts", 1) },
          ],
          lexicalHits: [],
          symbolHits: [],
        },
        { limit: 5 },
      );
    const first = names(build().items);
    for (let i = 0; i < 5; i++) expect(names(build().items)).toEqual(first);
  });
});
describe("buildTsQuery", () => {
  // Regression: the lexical leg built its tsquery with `to_tsquery('simple', q)`
  // and handed the raw query string over, so whitespace became `&` and
  // "how does order expiry work" demanded a chunk containing all five words.
  // Natural-language search — the product's reason for existing — returned
  // nothing from the lexical leg.
  it("ORs the terms so a natural-language query matches any of them", () => {
    expect(buildTsQuery("how does order expiry work").tsQuery).toBe(
      "how | does | order | expiry | work",
    );
  });

  it("keeps a single identifier as one lexeme", () => {
    expect(buildTsQuery("cancelOrder").tsQuery).toBe("cancelOrder");
  });

  it("splits punctuation and camelCase is preserved verbatim", () => {
    expect(buildTsQuery("OrderService.cancelOrder").terms).toEqual([
      "OrderService",
      "cancelOrder",
    ]);
    expect(buildTsQuery("a.b,c;d").terms).toEqual(["a", "b", "c", "d"]);
  });

  // tsquery operators must never survive sanitisation: a query containing
  // `& | ! ( ) : *` is otherwise a syntax error or, worse, a different query.
  it("strips tsquery operators so the parser cannot see them", () => {
    const { tsQuery } = buildTsQuery("foo & bar | baz ! (qux) :* ");
    expect(tsQuery).toBe("foo | bar | baz | qux");
    expect(tsQuery).not.toMatch(/[&!():*\\]/);
  });

  it("reports no tsquery for a query with no usable term", () => {
    expect(buildTsQuery("").tsQuery).toBeNull();
    expect(buildTsQuery("   ...  ***  ").tsQuery).toBeNull();
  });

  it("caps the term count so a huge query cannot build an enormous tsquery", () => {
    const many = Array.from({ length: 200 }, (_, i) => `t${i}`).join(" ");
    expect(buildTsQuery(many).terms).toHaveLength(16);
  });
});
