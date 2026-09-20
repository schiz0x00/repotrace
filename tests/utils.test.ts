import { describe, expect, it } from "vitest";
import { mergeAndRerank, type SearchResultItem } from "@/lib/search/hybrid";
import type { VectorHit } from "@/lib/qdrant";
import type { LexicalHit } from "@/lib/search/lexical";

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
});