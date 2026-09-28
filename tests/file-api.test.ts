import { describe, expect, it } from "vitest";
import {
  MAX_FILE_CONTENT_CHARS,
  MAX_FILE_CONTENT_LINES,
  MISSING_LINE_SAMPLE,
  assembleRange,
  capRangeChars,
  chunkBounds,
  clampLineRange,
  normalizeRepoPath,
  type ContentChunk,
} from "@/lib/search/file-outline";

function chunk(startLine: number, endLine: number, content: string): ContentChunk {
  return { startLine, endLine, content };
}

/** A three-chunk file: lines 1-2, 3-4, 5-6. */
const simple: ContentChunk[] = [
  chunk(1, 2, "line one\nline two"),
  chunk(3, 4, "line three\nline four"),
  chunk(5, 6, "line five\nline six"),
];

describe("chunkBounds", () => {
  it("returns null when there are no chunks", () => {
    expect(chunkBounds([])).toBeNull();
  });

  it("spans the first start to the last end regardless of input order", () => {
    const shuffled = [simple[2], simple[0], simple[1]];
    expect(chunkBounds(shuffled)).toEqual({ firstLine: 1, lastLine: 6 });
  });

  it("clamps corrupt non-positive or fractional line numbers", () => {
    expect(chunkBounds([chunk(-5, 3.7, "a\nb")])).toEqual({ firstLine: 1, lastLine: 3 });
  });

  it("skips a chunk with a non-finite extent rather than producing NaN bounds", () => {
    // A corrupt row is dropped, not pinned to line 1: pinning would invent
    // coverage the file does not have.
    expect(chunkBounds([chunk(2, Number.NaN, "a")])).toBeNull();
  });

  it("keeps the sound chunks when one row is corrupt", () => {
    const corrupt = chunk(1, 1, "good");
    expect(chunkBounds([corrupt, chunk(Number.NaN, Number.NaN, "bad")])).toEqual({
      firstLine: 1,
      lastLine: 1,
    });
  });

  it("returns null when no chunk covers a valid line", () => {
    expect(chunkBounds([chunk(Number.NaN, Number.NaN, "a")])).toBeNull();
  });
});

describe("clampLineRange", () => {
  const bounds = { firstLine: 1, lastLine: 400 };

  it("defaults to the whole file when no range is given", () => {
    expect(clampLineRange({ startLine: null, endLine: null }, bounds)).toEqual({
      startLine: 1,
      endLine: 400,
      clampedToBounds: false,
      truncatedByLineCap: false,
    });
  });

  it("passes an in-range request through untouched", () => {
    expect(clampLineRange({ startLine: 10, endLine: 20 }, bounds)).toEqual({
      startLine: 10,
      endLine: 20,
      clampedToBounds: false,
      truncatedByLineCap: false,
    });
  });

  it("clamps an end past the last line", () => {
    const r = clampLineRange({ startLine: 10, endLine: 999_999 }, bounds)!;
    expect(r.endLine).toBe(400);
    expect(r.clampedToBounds).toBe(true);
  });

  it("clamps a start before the first line", () => {
    const r = clampLineRange({ startLine: -20, endLine: 50 }, bounds)!;
    expect(r.startLine).toBe(1);
    expect(r.clampedToBounds).toBe(true);
  });

  it("clamps a start before a file that does not begin at line 1", () => {
    const r = clampLineRange({ startLine: 1, endLine: 60 }, { firstLine: 40, lastLine: 60 })!;
    expect(r.startLine).toBe(40);
    expect(r.clampedToBounds).toBe(true);
  });

  /**
   * The hostile case the endpoint exists to survive: an endLine far past the
   * file must cost the size of the file, not of the request.
   */
  it("does not let a huge endLine allocate beyond the file", () => {
    const r = clampLineRange({ startLine: 1, endLine: 999_999_999 }, bounds)!;
    expect(r.endLine).toBe(400);
    expect(r.endLine - r.startLine + 1).toBe(400);
  });

  it("caps an enormous in-bounds file at the line cap", () => {
    const huge = { firstLine: 1, lastLine: 5_000_000 };
    const r = clampLineRange({ startLine: 1, endLine: null }, huge)!;
    expect(r.endLine).toBe(MAX_FILE_CONTENT_LINES);
    expect(r.truncatedByLineCap).toBe(true);
  });

  it("serves the last line when the start is past the end of the file", () => {
    const r = clampLineRange({ startLine: 500, endLine: 600 }, bounds)!;
    expect(r.startLine).toBe(400);
    expect(r.endLine).toBe(400);
    expect(r.clampedToBounds).toBe(true);
  });

  it("collapses a reversed range rather than inverting it", () => {
    const r = clampLineRange({ startLine: 300, endLine: 100 }, bounds)!;
    expect(r.startLine).toBe(300);
    expect(r.endLine).toBe(300);
    expect(r.clampedToBounds).toBe(true);
  });

  it("coerces fractional input to integers", () => {
    const r = clampLineRange({ startLine: 10.9, endLine: 20.2 }, bounds)!;
    expect(r.startLine).toBe(10);
    expect(r.endLine).toBe(20);
  });

  it("substitutes the bound for a non-finite requested line", () => {
    const r = clampLineRange({ startLine: Number.NaN, endLine: Number.NaN }, bounds)!;
    expect(r).toEqual({
      startLine: 1,
      endLine: 400,
      clampedToBounds: false,
      truncatedByLineCap: false,
    });
  });

  it("honours a file that does not start at line 1", () => {
    const r = clampLineRange({ startLine: null, endLine: null }, { firstLine: 40, lastLine: 60 })!;
    expect(r.startLine).toBe(40);
    expect(r.endLine).toBe(60);
  });
});

describe("assembleRange", () => {
  it("reassembles a full file with correct line numbers", () => {
    const r = assembleRange(simple, 1, 6);
    expect(r.lines).toEqual([
      { lineNumber: 1, text: "line one" },
      { lineNumber: 2, text: "line two" },
      { lineNumber: 3, text: "line three" },
      { lineNumber: 4, text: "line four" },
      { lineNumber: 5, text: "line five" },
      { lineNumber: 6, text: "line six" },
    ]);
    expect(r.missingLineCount).toBe(0);
  });

  it("returns only the requested window", () => {
    const r = assembleRange(simple, 3, 4);
    expect(r.lines).toEqual([
      { lineNumber: 3, text: "line three" },
      { lineNumber: 4, text: "line four" },
    ]);
  });

  /**
   * The reason assembly places chunks by startLine instead of concatenating
   * them: the parser drops whitespace-only chunks, so joining would shift every
   * subsequent line.
   */
  it("keeps line numbers aligned across a gap left by a dropped chunk", () => {
    const withGap = [chunk(1, 1, "header"), chunk(4, 4, "footer")];
    const r = assembleRange(withGap, 1, 4);
    expect(r.lines).toEqual([
      { lineNumber: 1, text: "header" },
      { lineNumber: 2, text: "" },
      { lineNumber: 3, text: "" },
      { lineNumber: 4, text: "footer" },
    ]);
    expect(r.missingLineCount).toBe(2);
    expect(r.missingLines).toEqual([2, 3]);
  });

  it("clamps a window past the end of the file to the last real line", () => {
    // The window is re-clamped here, not trusted: a request for lines 100-102
    // of a 6-line file resolves to the tail rather than to invented blanks.
    const r = assembleRange(simple, 100, 102);
    expect(r.lines).toEqual([{ lineNumber: 6, text: "line six" }]);
    expect(r.missingLineCount).toBe(0);
  });

  it("returns nothing when there are no chunks", () => {
    expect(assembleRange([], 1, 10)).toEqual({
      lines: [],
      missingLineCount: 0,
      missingLines: [],
    });
  });

  it("lets the first chunk win when two chunks overlap", () => {
    const overlapping = [
      chunk(1, 3, "A1\nA2\nA3"),
      chunk(2, 2, "B2"),
    ];
    const r = assembleRange(overlapping, 1, 3);
    expect(r.lines.map((l) => l.text)).toEqual(["A1", "A2", "A3"]);
  });

  it("prefers the enclosing block when a symbol and a module block start together", () => {
    const overlapping = [
      chunk(5, 5, "narrow"),
      chunk(5, 9, "wide1\nwide2\nwide3\nwide4\nwide5"),
    ];
    const r = assembleRange(overlapping, 5, 9);
    expect(r.lines[0].text).toBe("wide1");
  });

  it("handles chunks arriving out of order", () => {
    const r = assembleRange([simple[2], simple[0], simple[1]], 1, 6);
    expect(r.lines.map((l) => l.text)).toEqual([
      "line one",
      "line two",
      "line three",
      "line four",
      "line five",
      "line six",
    ]);
  });

  it("tolerates a chunk whose text is shorter than its declared span", () => {
    // Markdown section bodies are trimmed, so content can be shorter than the
    // recorded endLine. The lines past the text must simply be reported missing.
    const r = assembleRange([chunk(1, 5, "only one line")], 1, 5);
    expect(r.missingLineCount).toBe(4);
    expect(r.lines[0].text).toBe("only one line");
  });

  it("caps the sample of missing line numbers", () => {
    // A real gap wider than the sample size: two chunks at the far ends of a
    // 1000-line file leaves 998 uncovered lines in between.
    const sparse = [chunk(1, 1, "head"), chunk(1000, 1000, "tail")];
    const r = assembleRange(sparse, 1, 1000);
    expect(r.missingLineCount).toBe(998);
    expect(r.missingLines).toHaveLength(MISSING_LINE_SAMPLE);
    expect(r.missingLines[0]).toBe(2);
  });

  it("never returns more lines than the window, for a hostile window", () => {
    const r = assembleRange(simple, 1, 999_999);
    expect(r.lines).toHaveLength(6);
  });
});

describe("capRangeChars", () => {
  it("passes a small range through unchanged", () => {
    const r = assembleRange(simple, 1, 6);
    const c = capRangeChars(r);
    expect(c.content).toBe("line one\nline two\nline three\nline four\nline five\nline six");
    expect(c.truncated).toBe(false);
    expect(c.nextLine).toBeNull();
    expect(c.lines).toHaveLength(6);
  });

  it("keeps content and lines describing the same text after truncation", () => {
    const big = "x".repeat(MAX_FILE_CONTENT_CHARS);
    const r = assembleRange([chunk(1, 1, big), chunk(2, 2, big)], 1, 2);
    const c = capRangeChars(r);
    expect(c.truncated).toBe(true);
    expect(c.lines).toHaveLength(1);
    expect(c.content).toBe(big);
    // The resume point is the first line the caller did not get.
    expect(c.nextLine).toBe(2);
  });

  it("slices a single line that exceeds the cap rather than returning nothing", () => {
    const huge = "y".repeat(MAX_FILE_CONTENT_CHARS + 500);
    const c = capRangeChars(assembleRange([chunk(1, 1, huge)], 1, 1));
    expect(c.lines).toHaveLength(1);
    expect(c.content.length).toBe(MAX_FILE_CONTENT_CHARS);
    expect(c.truncated).toBe(true);
    expect(c.lineTruncated).toBe(true);
    // A partially returned line has no resumable line number.
    expect(c.nextLine).toBeNull();
  });

  it("does not set lineTruncated when whole lines were dropped", () => {
    const c = capRangeChars(assembleRange(simple, 1, 6));
    expect(c.truncated).toBe(false);
    expect(c.lineTruncated).toBe(false);
    expect(c.nextLine).toBeNull();
  });

  it("counts separators so the joined text stays within the cap", () => {
    const line = "z".repeat(1000);
    const chunks = Array.from({ length: 200 }, (_, i) => chunk(i + 1, i + 1, line));
    const c = capRangeChars(assembleRange(chunks, 1, 200));
    expect(c.content.length).toBeLessThanOrEqual(MAX_FILE_CONTENT_CHARS);
    expect(c.truncated).toBe(true);
    expect(c.nextLine).toBe(c.lines.length + 1);
  });

  it("returns an empty result for an empty range", () => {
    const c = capRangeChars({ lines: [], missingLineCount: 0, missingLines: [] });
    expect(c.content).toBe("");
    expect(c.truncated).toBe(false);
    expect(c.nextLine).toBeNull();
  });
});

describe("normalizeRepoPath", () => {
  it("accepts a plain repo-relative path", () => {
    expect(normalizeRepoPath("src/orders/service.ts")).toBe("src/orders/service.ts");
  });

  it("strips leading ./ and /", () => {
    expect(normalizeRepoPath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeRepoPath("/src/a.ts")).toBe("src/a.ts");
    expect(normalizeRepoPath("././src/a.ts")).toBe("src/a.ts");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeRepoPath("  src/a.ts  ")).toBe("src/a.ts");
  });

  it("rejects a traversal segment rather than resolving it", () => {
    expect(normalizeRepoPath("../secrets.env")).toBeNull();
    expect(normalizeRepoPath("src/../../etc/passwd")).toBeNull();
    expect(normalizeRepoPath("src/..")).toBeNull();
  });

  it("rejects empty and whitespace-only paths", () => {
    expect(normalizeRepoPath("")).toBeNull();
    expect(normalizeRepoPath("   ")).toBeNull();
    expect(normalizeRepoPath("/")).toBeNull();
    expect(normalizeRepoPath("./")).toBeNull();
  });

  it("rejects an absurdly long path", () => {
    expect(normalizeRepoPath("a/".repeat(600))).toBeNull();
  });

  it("leaves backslashes alone, since a git filename may contain one", () => {
    expect(normalizeRepoPath("weird\\name.ts")).toBe("weird\\name.ts");
  });

  it("keeps a file whose name merely contains dots", () => {
    expect(normalizeRepoPath("src/a..b.ts")).toBe("src/a..b.ts");
  });
});
