/**
 * Pure helpers for reading one indexed file: its symbol outline, and the
 * reassembly of its text from stored chunks over a line range.
 *
 * Deliberately free of any Prisma import. The MCP `get_file` tool needs the
 * same chunk-joining logic, and pulling the database client into an MCP module
 * for a string operation would be a needless dependency.
 */

/** The subset of a Chunk row this module needs. */
export interface ContentChunk {
  content: string;
  startLine: number;
  endLine: number;
}

/** Inclusive 1-based line extent of the indexed content of a file. */
export interface LineBounds {
  firstLine: number;
  lastLine: number;
}

/**
 * Upper bound on characters returned by a single file read. Mirrors the cap
 * the MCP `get_file` tool applies: an entire file can be ~1MB, which overflows
 * an agent's context window, so the read has to have a ceiling.
 */
export const MAX_FILE_CONTENT_CHARS = 100_000;

/**
 * Upper bound on lines returned by a single file read.
 *
 * The character cap alone does not bound the work: a file can be millions of
 * lines of very short text, and the caller's `endLine` is attacker-controlled.
 * Both caps are enforced, and each is reported separately so a caller can tell
 * which one it hit.
 */
export const MAX_FILE_CONTENT_LINES = 5_000;

/**
 * Computes the line extent covered by a file's chunks.
 *
 * Returns null when there is nothing to read, which is a real state and not
 * just a guard. The parser emits no chunks at all for a file whose content is
 * entirely whitespace: `fallbackChunks` returns an empty array for blank
 * content, `parseMarkdown` drops a section whose body is empty, and the
 * tree-sitter path's "keep at least one chunk per file" branch only fires when
 * it already produced chunks. The pipeline still upserts the file row, so such
 * a file is indexed with zero chunks. It also returns null when every chunk
 * was skipped for having no finite line extent — see the loop below.
 */
export function chunkBounds(chunks: readonly ContentChunk[]): LineBounds | null {
  if (chunks.length === 0) return null;
  let firstLine = Number.POSITIVE_INFINITY;
  let lastLine = 0;
  for (const chunk of chunks) {
    if (!Number.isFinite(chunk.startLine) || !Number.isFinite(chunk.endLine)) continue;
    // Defend against a corrupt row rather than trusting the column: a 0 or
    // negative startLine would otherwise widen the addressable range. A row
    // with no usable extent is skipped instead of being pinned to line 1, which
    // would invent coverage the file does not have.
    const start = Math.max(1, Math.trunc(chunk.startLine));
    const end = Math.max(start, Math.trunc(chunk.endLine));
    if (start < firstLine) firstLine = start;
    if (end > lastLine) lastLine = end;
  }
  if (!Number.isFinite(firstLine) || lastLine < firstLine) return null;
  return { firstLine, lastLine };
}

/**
 * Truncates to an integer, substituting a fallback for a non-finite value.
 * Deliberately does not clamp to a minimum: callers compare the result against
 * the file's real bounds to decide whether clamping happened, and pre-clamping
 * here would make an out-of-range request indistinguishable from an in-range
 * one.
 */
function toLineNumber(value: number | null | undefined, fallback: number): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  return Math.trunc(value);
}

export interface LineRangeRequest {
  /** 1-based, inclusive. Null means "from the start of the file". */
  startLine: number | null;
  /** 1-based, inclusive. Null means "to the end of the file". */
  endLine: number | null;
}

export interface ClampedRange {
  startLine: number;
  endLine: number;
  /** The request fell outside the indexed extent and was pulled in. */
  clampedToBounds: boolean;
  /** MAX_FILE_CONTENT_LINES cut the range short. */
  truncatedByLineCap: boolean;
}

/**
 * Resolves a requested line range against the file's real extent.
 *
 * Every input is untrusted, so the result is bounded on both ends: the range is
 * pulled inside `bounds`, then capped at MAX_FILE_CONTENT_LINES. A request of
 * `startLine=1&endLine=999999999` against a 400-line file therefore yields 400
 * lines of work, not a billion.
 *
 * Returns null when there is no indexed content to clamp against.
 */
export function clampLineRange(
  request: LineRangeRequest,
  bounds: LineBounds,
): ClampedRange | null {
  const firstLine = Math.max(1, Math.trunc(bounds.firstLine));
  const lastLine = Math.max(firstLine, Math.trunc(bounds.lastLine));
  if (!Number.isFinite(firstLine) || !Number.isFinite(lastLine)) return null;

  let startLine = toLineNumber(request.startLine, firstLine);
  let endLine = toLineNumber(request.endLine, lastLine);

  let clampedToBounds = false;
  if (startLine < firstLine) {
    startLine = firstLine;
    clampedToBounds = true;
  }
  if (startLine > lastLine) {
    // The caller asked for lines past the end. Serve the last line rather than
    // an empty body, so the response still points somewhere real.
    startLine = lastLine;
    clampedToBounds = true;
  }
  if (endLine > lastLine) {
    endLine = lastLine;
    clampedToBounds = true;
  }
  // A reversed or fully out-of-range request (start past the end, or
  // end before start) collapses to a single line instead of inverting the
  // range, which would make the slice arithmetic below walk backwards.
  if (endLine < startLine) {
    endLine = startLine;
    clampedToBounds = true;
  }

  let truncatedByLineCap = false;
  if (endLine - startLine + 1 > MAX_FILE_CONTENT_LINES) {
    endLine = startLine + MAX_FILE_CONTENT_LINES - 1;
    truncatedByLineCap = true;
  }

  return { startLine, endLine, clampedToBounds, truncatedByLineCap };
}

export interface AssembledLine {
  lineNumber: number;
  text: string;
}

export interface AssembledRange {
  lines: AssembledLine[];
  /** Total lines in range that no chunk covered. */
  missingLineCount: number;
  /** First `MISSING_LINE_SAMPLE` such line numbers, for diagnosis. */
  missingLines: number[];
}

/** How many missing line numbers to name explicitly in a response. */
export const MISSING_LINE_SAMPLE = 100;

/**
 * Reassembles a line range from a file's chunks.
 *
 * Chunks are placed by their recorded `startLine` rather than concatenated, so
 * a range read lines up with the real file. Concatenating would not: the parser
 * drops whitespace-only chunks, and markdown section bodies are trimmed, so
 * the join loses and shifts lines.
 *
 * The window is re-clamped against the chunks' own extent here rather than
 * trusted from the caller. This function allocates one entry per line in the
 * window, so a caller passing endLine=999999999 to a 400-line file would
 * otherwise build a million-element array before any cap could apply.
 *
 * Lines covered by no chunk are emitted as empty text and counted, because an
 * index gap is indistinguishable from a genuinely blank line in the stored
 * data and the caller should not read one as the other.
 */
export function assembleRange(
  chunks: readonly ContentChunk[],
  startLine: number,
  endLine: number,
): AssembledRange {
  const bounds = chunkBounds(chunks);
  if (!bounds) {
    return { lines: [], missingLineCount: 0, missingLines: [] };
  }
  // Clamp to the real extent, then to the line cap: the result is bounded by
  // MAX_FILE_CONTENT_LINES whatever the caller asked for.
  const clamped =
    clampLineRange({ startLine, endLine }, bounds) ??
    clampLineRange({ startLine: null, endLine: null }, bounds);
  if (!clamped) {
    return { lines: [], missingLineCount: 0, missingLines: [] };
  }
  const from = clamped.startLine;
  const to = clamped.endLine;

  const text = new Map<number, string>();
  // First writer wins. Sorting widest-first for equal starts means an enclosing
  // block beats a narrower one starting on the same line, which is the reading
  // that matches the source when a symbol and a module block overlap.
  const ordered = [...chunks].sort(
    (a, b) => a.startLine - b.startLine || b.endLine - a.endLine,
  );
  for (const chunk of ordered) {
    const chunkStart = Math.max(1, toLineNumber(chunk.startLine, 1));
    const lines = chunk.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lineNumber = chunkStart + i;
      if (lineNumber < from) continue;
      if (lineNumber > to) break;
      if (!text.has(lineNumber)) text.set(lineNumber, lines[i]);
    }
  }

  const lines: AssembledLine[] = [];
  const missingLines: number[] = [];
  let missingLineCount = 0;
  for (let lineNumber = from; lineNumber <= to; lineNumber++) {
    const value = text.get(lineNumber);
    if (value === undefined) {
      missingLineCount++;
      if (missingLines.length < MISSING_LINE_SAMPLE) missingLines.push(lineNumber);
      lines.push({ lineNumber, text: "" });
    } else {
      lines.push({ lineNumber, text: value });
    }
  }
  return { lines, missingLineCount, missingLines };
}

export interface CharCappedRange {
  /** Line-numbered text, truncated to MAX_FILE_CONTENT_CHARS. */
  lines: AssembledLine[];
  /** The same text joined with newlines. */
  content: string;
  /** True when the character cap dropped content from the tail. */
  truncated: boolean;
  /** Where to resume, or null when nothing was dropped or only a partial line was. */
  nextLine: number | null;
  /** True when a single line was too long and was itself sliced. */
  lineTruncated: boolean;
}

/**
 * Drops lines from the tail of an assembled range until the joined text fits
 * MAX_FILE_CONTENT_CHARS.
 *
 * `lines` and `content` are always derived from the same kept set, so they
 * can never disagree about what was returned. `nextLine` is the first line
 * that was dropped, which is what makes the truncation actionable instead of a
 * silent loss.
 */
export function capRangeChars(range: AssembledRange): CharCappedRange {
  const kept: AssembledLine[] = [];
  let chars = 0;
  let hitCap = false;
  for (const line of range.lines) {
    // Every line after the first costs a separator as well as its own text.
    const cost = line.text.length + (kept.length > 0 ? 1 : 0);
    if (chars + cost > MAX_FILE_CONTENT_CHARS) {
      hitCap = true;
      break;
    }
    chars += cost;
    kept.push(line);
  }
  // A single line longer than the whole budget (a minified bundle, a data file)
  // would otherwise yield an empty body, which reads as "the file is empty".
  // Slice it to the cap instead, and flag it: the caller gets real content and
  // is told the line is partial.
  let lineTruncated = false;
  if (kept.length === 0 && range.lines.length > 0) {
    const first = range.lines[0];
    kept.push({ lineNumber: first.lineNumber, text: first.text.slice(0, MAX_FILE_CONTENT_CHARS) });
    hitCap = true;
    lineTruncated = true;
  }
  const last = kept[kept.length - 1];
  return {
    lines: kept,
    content: kept.map((l) => l.text).join("\n"),
    truncated: hitCap,
    // A partially returned line cannot be resumed by line number alone, so
    // there is no next line to point at in that case.
    nextLine: hitCap && last && !lineTruncated ? last.lineNumber + 1 : null,
    lineTruncated,
  };
}

/**
 * Normalizes a caller-supplied repository-relative path.
 *
 * Returns null for a path that cannot name a file in a repository, so the route
 * can reject it as a bad request instead of spending a query on a path that was
 * never going to match.
 */
export function normalizeRepoPath(input: string): string | null {
  let path = input.trim();
  if (path.length === 0 || path.length > 1024) return null;
  // Accept `/src/a.ts` and `./src/a.ts` for the same file as `src/a.ts`.
  while (path.startsWith("./")) path = path.slice(2);
  while (path.startsWith("/")) path = path.slice(1);
  if (path.length === 0) return null;
  // Reject traversal segments rather than resolving them: the stored paths are
  // always plain repo-relative, so anything with a `..` segment is not one of
  // them. Backslashes are left alone — a git filename may legally contain one.
  if (path.split("/").some((segment) => segment === "..")) return null;
  return path;
}
