import { z } from "zod";
import { route, json, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";
import {
  MAX_FILE_CONTENT_CHARS,
  MAX_FILE_CONTENT_LINES,
  MISSING_LINE_SAMPLE,
  assembleRange,
  capRangeChars,
  clampLineRange,
  normalizeRepoPath,
  type AssembledLine,
  type AssembledRange,
  type ContentChunk,
  type LineBounds,
} from "@/lib/search/file-outline";
import { badRequest, notFound } from "@/lib/errors";

export const runtime = "nodejs";

/** The chunk extent Prisma's `aggregate` reports for a file's chunks. */
interface ChunkExtent {
  _min: { startLine: number | null };
  _max: { startLine: number | null; endLine: number | null };
}

interface ExtentBounds {
  bounds: LineBounds;
  /** Raw aggregates, kept so the ranged read can pin the boundary rows. */
  minStart: number;
  maxStart: number;
  maxEnd: number;
}

/**
 * Turns a chunk extent aggregate into the same LineBounds chunkBounds() would
 * have produced from the rows themselves, without reading them.
 *
 * `_max(startLine)` is taken alongside `_max(endLine)` on purpose: a row whose
 * recorded extent is inverted (end before start) contributes its *start* to
 * chunkBounds' lastLine, and dropping that column would let such a row pull the
 * reported end of the file backwards. The per-row clamps mirror chunkBounds so
 * a corrupt startLine of 0 or less widens the addressable range by nothing.
 */
function boundsFromExtent(extent: ChunkExtent): ExtentBounds | null {
  const { startLine: minStart } = extent._min;
  const { startLine: maxStart, endLine: maxEnd } = extent._max;
  // No chunk rows at all: the file is indexed but empty of content.
  if (minStart === null || maxStart === null || maxEnd === null) return null;
  const firstLine = Math.max(1, Math.trunc(minStart));
  // `max(firstLine, ...)` rather than an isFinite guard afterwards: the values
  // are Prisma Int aggregates over a NOT NULL column, so Math.trunc already
  // rules out NaN and Infinity, and the max() is what actually protects
  // `lastLine` from being pulled below `firstLine` by an inverted-extent row.
  const lastLine = Math.max(firstLine, Math.trunc(Math.max(maxStart, maxEnd)));
  return { bounds: { firstLine, lastLine }, minStart, maxStart, maxEnd };
}

/**
 * A window that no chunk overlaps at all: every line in it is genuinely
 * missing. assembleRange cannot express this — handed an empty chunk set it
 * returns an empty range, which reads as "no content here" instead of "a gap
 * here" — so the same shape is built directly.
 *
 * The boundary-row pinning in the query below means this should be
 * unreachable: the rows defining the extent are always selected, so the fetched
 * set is never empty. It stays as a guard so that a future edit to the filter
 * degrades to reporting the gap rather than to silently answering "empty".
 */
function missingRange(startLine: number, endLine: number): AssembledRange {
  const lines: AssembledLine[] = [];
  const missingLines: number[] = [];
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
    if (missingLines.length < MISSING_LINE_SAMPLE) missingLines.push(lineNumber);
    lines.push({ lineNumber, text: "" });
  }
  return { lines, missingLineCount: lines.length, missingLines };
}

/**
 * GET /api/v1/projects/:idOrSlug/files/content?path=&startLine=&endLine=
 *
 * The text of an indexed file over a line range, reassembled from its chunks
 * and returned with line numbers so a caller can navigate. Omitting the range
 * returns the whole file, subject to the same caps the MCP get_file tool
 * applies.
 */
export async function GET(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const { searchParams } = new URL(req.url);

    const schema = z.object({
      path: z.string().min(1).max(1024),
      // Bounded at the edge as well as in clampLineRange: a hostile
      // endLine=999999999 should be rejected or clamped by an explicit rule, not
      // by Integer overflow behaviour downstream.
      startLine: z.coerce.number().int().min(1).max(10_000_000).optional(),
      endLine: z.coerce.number().int().min(1).max(10_000_000).optional(),
    });
    const parsed = schema.parse({
      path: searchParams.get("path") ?? undefined,
      startLine: searchParams.get("startLine") ?? undefined,
      endLine: searchParams.get("endLine") ?? undefined,
    });

    const path = normalizeRepoPath(parsed.path);
    if (path === null) {
      throw badRequest("invalid_path", "path must be a repository-relative file path");
    }

    const db = prisma();
    const file = await db.file.findFirst({
      where: { projectId: project.id, path },
      select: {
        id: true,
        path: true,
        language: true,
        size: true,
        status: true,
        lastIndexedCommit: true,
      },
    });
    if (!file) {
      throw notFound("file_not_found", `File ${path} is not indexed in this project`);
    }

    // Clamping needs the file's extent, not its text, so the extent is
    // aggregated rather than read. Selecting every chunk's content and
    // assembling in JS would make a request for twenty lines of a large file
    // transfer and line-split the entire file first.
    //
    // Cost: three round trips per request — the file row, then the extent
    // aggregate, then the ranged chunks — where a single query selecting the
    // file with its chunks would do (the MCP get_file path still works that
    // way). Both chunk queries filter on fileId, the leading column of the
    // unique index on (fileId, contentHash, startLine), so each is an index scan
    // of one file's rows rather than a table scan. What the extra trips buy is
    // not reading a megabyte of chunk text to answer a twenty-line question.
    const aggregated = await db.chunk.aggregate({
      where: { fileId: file.id },
      _min: { startLine: true },
      _max: { startLine: true, endLine: true },
    });
    const extent = boundsFromExtent(aggregated);
    if (!extent) {
      // The file row exists but holds no chunks (every chunk was whitespace).
      // That is a real answer, not a missing file: say so instead of 404ing.
      return json({
        file: {
          path: file.path,
          language: file.language,
          size: file.size,
          status: file.status,
          lastIndexedCommit: file.lastIndexedCommit,
        },
        bounds: null,
        content: "",
        lines: [],
        truncation: { clampedToBounds: false, truncatedByLineCap: false, truncatedByCharCap: false, nextLine: null },
        missingLineCount: 0,
        missingLines: [],
      });
    }

    const { bounds } = extent;
    const range = clampLineRange(
      { startLine: parsed.startLine ?? null, endLine: parsed.endLine ?? null },
      bounds,
    );
    if (!range) {
      throw badRequest("invalid_range", "Could not resolve a line range for this file");
    }

    // Only the chunks that touch the clamped window are read.
    //
    // Overlap alone is not enough, and the reason is a behaviour that must not
    // change: assembleRange re-clamps its window against the bounds of the
    // chunks it is handed. Filtering strictly to the window narrows those
    // bounds, so for a sparse file (chunks 1-1 and 50-100) a request for lines
    // 40-60 would come back starting at line 50, silently dropping the leading
    // gap instead of reporting lines 40-49 as missing.
    //
    // The two pin predicates below are what prevent that. They select the row
    // holding the file's smallest startLine and every row holding its largest
    // startLine or its largest endLine, and those are the only rows chunkBounds
    // derives firstLine/lastLine from, so the fetched set's extent is the file's
    // extent whether or not the window reaches it. That equivalence holds for
    // any row values whatsoever, corrupt ones included.
    //
    // The *text* is a weaker claim, and deliberately so. assembleRange places a
    // chunk by its startLine and never consults its endLine, so a row whose text
    // runs longer than its recorded span spills past endLine and can land in a
    // window the overlap predicate excluded it from. An inverted extent
    // (endLine < startLine) is the case that shows it: chunkBounds clamps such
    // a row's end up to its start, but the SQL overlap test does not, so its
    // overflow lines are dropped where reading every chunk would have returned
    // them. Closing that would mean selecting every row starting at or before the
    // window's end — that is, the whole prefix of the file — which is the read
    // this filter exists to avoid, so it is documented instead.
    //
    // No such row can be written today, but the guarantee is the parser's, not
    // the database's: `chunk` has no CHECK constraint, and rows are created in
    // exactly one place, the createMany in the indexing pipeline, which copies
    // the parsers' values verbatim. Two mechanisms are what keep those values
    // ordered, and both are load-bearing:
    //   - blockChunks derives `endLine` as `Math.min(blockStart + MAX, end)`
    //     inside a `while (blockStart <= end)` loop, so `blockEnd >= blockStart`
    //     whenever it emits at all.
    //   - the markdown section flush slices `[sectionStart, endLine]` and
    //     returns early on an empty body, so an inverted range produces no
    //     chunk rather than an inverted one.
    // The declaration chunks carry a tree-sitter node's own row span, where
    // endPosition >= startPosition holds by construction.
    // A row like this would have to arrive by hand or from a bad migration.
    const chunks: ContentChunk[] = await db.chunk.findMany({
      where: {
        fileId: file.id,
        OR: [
          { startLine: { lte: range.endLine }, endLine: { gte: range.startLine } },
          { startLine: { in: [extent.minStart, extent.maxStart] } },
          { endLine: extent.maxEnd },
        ],
      },
      orderBy: { startLine: "asc" },
      select: { content: true, startLine: true, endLine: true },
    });

    const assembled =
      chunks.length > 0
        ? assembleRange(chunks, range.startLine, range.endLine)
        : missingRange(range.startLine, range.endLine);
    const capped = capRangeChars(assembled);

    return json({
      file: {
        path: file.path,
        language: file.language,
        size: file.size,
        status: file.status,
        lastIndexedCommit: file.lastIndexedCommit,
      },
      bounds,
      content: capped.content,
      lines: capped.lines,
      truncation: {
        clampedToBounds: range.clampedToBounds,
        truncatedByLineCap: range.truncatedByLineCap,
        truncatedByCharCap: capped.truncated,
        lineTruncated: capped.lineTruncated,
        // Where to resume. Non-null means text was left out; the caller is told
        // rather than silently handed a short file.
        nextLine: capped.nextLine,
        maxChars: MAX_FILE_CONTENT_CHARS,
        maxLines: MAX_FILE_CONTENT_LINES,
      },
      // Lines inside the range that no chunk covered. The parser drops
      // whitespace-only chunks, so a gap is expected in some files and is not a
      // sign the file is unreadable.
      missingLineCount: assembled.missingLineCount,
      missingLines: assembled.missingLines,
    });
  })(request, {});
}
