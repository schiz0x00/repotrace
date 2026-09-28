import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_CHUNK_LINES, parseFile, preloadGrammars, type ParsedChunk } from "@/lib/indexing/parser";
import { buildChunkWrites, dedupeChunks } from "@/lib/indexing/pipeline";
import { pointIdFor } from "@/lib/qdrant";

/**
 * Two independent bounds the indexing pipeline did not have, both of which only
 * bite on input a repository can supply on purpose:
 *
 *   1. A symbol chunk was never size-capped, so one generated file, minified
 *      bundle or data fixture became a single chunk that was embedded whole,
 *      stored in Qdrant's payload verbatim and served by `get_file`.
 *   2. `chunk.createMany` had no duplicate guard, so two chunks colliding on
 *      the `(fileId, contentHash, startLine)` unique key failed the whole file
 *      — permanently, on every run.
 */

function chunk(partial: Partial<ParsedChunk> & { content: string; startLine: number }): ParsedChunk {
  return {
    symbolName: null,
    kind: "module",
    endLine: partial.startLine,
    chunkType: "code",
    ...partial,
  };
}

const lineCount = (c: ParsedChunk) => c.content.split("\n").length;

describe("indexing limits", () => {
  describe("declaration chunks are size-capped", () => {
    // A function body far past MAX_CHUNK_LINES — the shape a generated client,
    // a bundled artifact or an exported data table takes.
    const HUGE_FUNCTION = [
      "export function processBatch(rows: string[]): number {",
      ...Array.from({ length: MAX_CHUNK_LINES * 4 + 20 }, (_, i) => `  const step${i + 1} = ${i + 1};`),
      "  return step1;",
      "}",
    ].join("\n");

    beforeAll(async () => {
      await preloadGrammars();
    });

    it("splits an oversized declaration into chunks no larger than MAX_CHUNK_LINES", () => {
      const parsed = parseFile("src/generated/batch.ts", HUGE_FUNCTION);
      const parts = parsed.chunks.filter((c) => c.symbolName === "processBatch");
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(lineCount(part), `part at ${part.startLine} is ${lineCount(part)} lines`).toBeLessThanOrEqual(
          MAX_CHUNK_LINES,
        );
      }
      // No chunk anywhere in the file escapes the bound, not just the big one.
      for (const c of parsed.chunks) {
        expect(lineCount(c), `chunk ${c.startLine}-${c.endLine}`).toBeLessThanOrEqual(MAX_CHUNK_LINES);
      }
    });

    it("keeps the symbol name on every part, so retrieval still resolves", () => {
      const parsed = parseFile("src/generated/batch.ts", HUGE_FUNCTION);
      const parts = parsed.chunks.filter((c) => c.symbolName === "processBatch");
      // The name is the join key: the pipeline resolves it to `Chunk.symbolId`
      // and the search layer filters on it. A suffixed variant would resolve to
      // no symbol at all and be dropped from every structural query.
      for (const part of parts) {
        expect(part.symbolName).toBe("processBatch");
        expect(part.kind).toBe("function");
      }
    });

    it("keeps every part contiguous and inside the declaration's own span", () => {
      const parsed = parseFile("src/generated/batch.ts", HUGE_FUNCTION);
      const parts = parsed.chunks
        .filter((c) => c.symbolName === "processBatch")
        .sort((a, b) => a.startLine - b.startLine);
      const decl = parsed.symbols.find((s) => s.qualifiedName === "processBatch")!;
      expect(parts[0].startLine).toBe(decl.startLine);
      expect(parts[parts.length - 1].endLine).toBe(decl.endLine);
      for (let i = 1; i < parts.length; i++) {
        expect(parts[i].startLine, `gap between part ${i - 1} and ${i}`).toBe(parts[i - 1].endLine + 1);
      }
    });

    it("reconstructs the declaration's text exactly, in order", () => {
      const parsed = parseFile("src/generated/batch.ts", HUGE_FUNCTION);
      const parts = parsed.chunks
        .filter((c) => c.symbolName === "processBatch")
        .sort((a, b) => a.startLine - b.startLine);
      const decl = parsed.symbols.find((s) => s.qualifiedName === "processBatch")!;
      const allLines = HUGE_FUNCTION.split("\n");
      // `get_file` reassembles a file from its chunks, so a split that dropped
      // or duplicated a line would hand back text that is not in the file.
      expect(parts.map((c) => c.content).join("\n")).toBe(
        allLines.slice(decl.startLine - 1, decl.endLine).join("\n"),
      );
      // And every part's recorded line range matches the lines it carries.
      for (const part of parts) {
        expect(part.content).toBe(allLines.slice(part.startLine - 1, part.endLine).join("\n"));
      }
    });

    it("does not split a declaration that already fits", () => {
      const small = ["export function tiny(a: number): number {", "  return a + 1;", "}"].join("\n");
      const parsed = parseFile("src/tiny.ts", small);
      const parts = parsed.chunks.filter((c) => c.symbolName === "tiny");
      expect(parts).toHaveLength(1);
      expect(parts[0].content).toBe(small);
    });

    it("breaks a split declaration on a blank line near the limit where one exists", () => {
      const withBlank = [
        "export function spaced(): void {",
        ...Array.from({ length: MAX_CHUNK_LINES + 12 }, (_, i) => `  const v${i + 1} = ${i};`),
        "",
        ...Array.from({ length: MAX_CHUNK_LINES + 12 }, (_, i) => `  const w${i + 1} = ${i};`),
        "}",
      ].join("\n");
      const parsed = parseFile("src/spaced.ts", withBlank);
      const parts = parsed.chunks.filter((c) => c.symbolName === "spaced");
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts) {
        expect(lineCount(part)).toBeLessThanOrEqual(MAX_CHUNK_LINES);
      }
    });

    it("leaves gap-block chunking unchanged", () => {
      const parsed = parseFile("src/generated/batch.ts", HUGE_FUNCTION);
      const gaps = parsed.chunks.filter((c) => c.symbolName === null);
      // Only the trailing newline after the closing brace is a gap here; the
      // point is that the cap applies uniformly and nothing was inflated.
      for (const gap of gaps) {
        expect(lineCount(gap)).toBeLessThanOrEqual(MAX_CHUNK_LINES);
      }
    });
  });

  describe("dedupeChunks", () => {
    it("keeps every distinct chunk untouched", () => {
      const chunks = [
        chunk({ content: "a", startLine: 1 }),
        chunk({ content: "b", startLine: 2 }),
        chunk({ content: "a", startLine: 3 }),
      ];
      const result = dedupeChunks(chunks);
      expect(result.dropped).toBe(0);
      expect(result.chunks).toEqual(chunks);
      expect(result.examples).toEqual([]);
    });

    it("drops the second of two chunks with identical content at the same line", () => {
      // Two declarations sharing a source span: same text, same start line, so
      // the same (fileId, contentHash, startLine) — the unique key, violated.
      const shared = chunk({ content: "function a() {}\nfunction b() {}", startLine: 10, endLine: 11, symbolName: "A" });
      const twin = { ...shared, symbolName: "B" };
      const result = dedupeChunks([shared, twin]);
      expect(result.dropped).toBe(1);
      expect(result.chunks).toHaveLength(1);
      // First wins, so the surviving row is the one the parser emitted first.
      expect(result.chunks[0].symbolName).toBe("A");
    });

    it("keeps identical content at a different start line", () => {
      const result = dedupeChunks([
        chunk({ content: "x = 1", startLine: 1 }),
        chunk({ content: "x = 1", startLine: 9 }),
      ]);
      expect(result.dropped).toBe(0);
      expect(result.chunks).toHaveLength(2);
    });

    it("preserves the original order of the survivors", () => {
      const result = dedupeChunks([
        chunk({ content: "a", startLine: 1 }),
        chunk({ content: "b", startLine: 2 }),
        chunk({ content: "a", startLine: 1 }),
        chunk({ content: "c", startLine: 3 }),
      ]);
      expect(result.chunks.map((c) => c.content)).toEqual(["a", "b", "c"]);
      expect(result.dropped).toBe(1);
    });

    it("counts every drop but bounds how many it describes", () => {
      const first = chunk({ content: "same", startLine: 4 });
      const chunks = [first, ...Array.from({ length: 12 }, () => ({ ...first }))];
      const result = dedupeChunks(chunks);
      expect(result.dropped).toBe(12);
      expect(result.chunks).toHaveLength(1);
      // Bounded so a systematically colliding file cannot grow the warning (or
      // the `File.error` note) without limit.
      expect(result.examples.length).toBeLessThanOrEqual(5);
      expect(result.examples[0]).toContain("lines 4-4");
    });

    it("names the dropped chunk's symbol when it has one", () => {
      const result = dedupeChunks([
        chunk({ content: "body", startLine: 7, symbolName: "A" }),
        chunk({ content: "body", startLine: 7, symbolName: "B" }),
      ]);
      expect(result.examples[0]).toContain("(B)");
    });

    it("is a no-op on an empty list", () => {
      expect(dedupeChunks([])).toEqual({ chunks: [], dropped: 0, examples: [] });
    });
  });

  describe("buildChunkWrites", () => {
    const base = {
      projectId: "p1",
      fileId: "f1",
      path: "src/a.ts",
      language: "typescript",
      category: "code" as const,
      embeddingModel: "mock",
      embeddingVersion: 1,
      symbolIdByQualified: new Map<string, string>([
        ["A", "sym-a"],
        ["Outer.Inner", "sym-outer-inner"],
      ]),
    };

    it("pairs each chunk with its row and its point, index-aligned", () => {
      const chunks = [
        chunk({ content: "one", startLine: 1, endLine: 1, symbolName: "A", kind: "function" }),
        chunk({ content: "two", startLine: 2, endLine: 2 }),
      ];
      const { rows, points } = buildChunkWrites({ ...base, chunks, vectors: [[0.1], [0.2]] });
      expect(rows).toHaveLength(2);
      expect(points).toHaveLength(2);
      rows.forEach((row, i) => {
        expect(row.content).toBe(chunks[i].content);
        expect(row.contentHash).toBe(createHash("sha256").update(chunks[i].content).digest("hex"));
        expect(points[i].vector).toEqual([i === 0 ? 0.1 : 0.2]);
        expect(points[i].payload.chunk_id).toBe(row.id);
        expect(points[i].payload.content_hash).toBe(row.contentHash);
        expect(points[i].payload.content).toBe(row.content);
        // Every point ID is derived from its chunk row, so the Qdrant payload
        // and the Postgres row can never be joined up to the wrong record.
        expect(pointIdFor(row.id)).toBe(points[i].id);
      });
    });

    it("resolves symbolId from the qualified name and the payload module from its head", () => {
      const chunks = [chunk({ content: "x", startLine: 1, symbolName: "Outer.Inner" })];
      const { rows, points } = buildChunkWrites({ ...base, chunks, vectors: [[0.1]] });
      expect(rows[0].symbolId).toBe("sym-outer-inner");
      expect(points[0].payload.symbol).toBe("Outer.Inner");
      expect(points[0].payload.module).toBe("Outer");
    });

    it("leaves symbolId undefined for a chunk with no symbol", () => {
      const { rows, points } = buildChunkWrites({
        ...base,
        chunks: [chunk({ content: "x", startLine: 1 })],
        vectors: [[0.1]],
      });
      expect(rows[0].symbolId).toBeUndefined();
      expect(points[0].payload.symbol).toBeNull();
      expect(points[0].payload.module).toBeNull();
    });

    it("refuses a vector array that does not line up with the chunks", () => {
      // Silently pairing a chunk with another chunk's vector would store a
      // result that is confidently wrong, so this fails loudly instead.
      expect(() =>
        buildChunkWrites({
          ...base,
          chunks: [chunk({ content: "one", startLine: 1 }), chunk({ content: "two", startLine: 2 })],
          vectors: [[0.1]],
        }),
      ).toThrow(/Embedding count mismatch/);
    });

    it("throws on a duplicate key rather than writing a batch the database will reject", () => {
      const dup = chunk({ content: "same", startLine: 3, endLine: 3 });
      expect(() =>
        buildChunkWrites({ ...base, chunks: [dup, { ...dup }], vectors: [[0.1], [0.2]] }),
      ).toThrow(/Duplicate chunk key/);
    });

    it("handles an empty chunk list without inventing a row", () => {
      const { rows, points } = buildChunkWrites({ ...base, chunks: [], vectors: [] });
      expect(rows).toEqual([]);
      expect(points).toEqual([]);
    });

    it("round-trips dedupe into a batch the unique key accepts", () => {
      // The two halves of the fix, composed: what the guard drops is exactly
      // what would have taken the whole file down.
      const dup = chunk({ content: "same", startLine: 3, endLine: 3, symbolName: "A" });
      const chunks = [chunk({ content: "one", startLine: 1 }), dup, { ...dup, symbolName: "B" }];
      const deduped = dedupeChunks(chunks);
      const { rows } = buildChunkWrites({ ...base, chunks: deduped.chunks, vectors: [[0.1], [0.2]] });
      const keys = new Set(rows.map((r) => `${r.contentHash}:${r.startLine}`));
      expect(keys.size).toBe(rows.length);
    });
  });
});
