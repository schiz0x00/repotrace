import { z } from "zod";
import { route, json, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";
import { normalizeRepoPath } from "@/lib/search/file-outline";
import { badRequest, notFound } from "@/lib/errors";

export const runtime = "nodejs";

/** Symbols returned in one response. Mirrors the MCP get_file_outline cap. */
const OUTLINE_SYMBOL_LIMIT = 300;

/**
 * GET /api/v1/projects/:idOrSlug/files/outline?path=
 *
 * The structure of one indexed file: every symbol with its line span, plus the
 * file's language, size and last indexed commit. This is the "what is in this
 * file" view a caller needs before deciding which lines to read via
 * /files/content.
 */
export async function GET(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const { searchParams } = new URL(req.url);

    const schema = z.object({ path: z.string().min(1).max(1024) });
    const parsed = schema.parse({ path: searchParams.get("path") ?? undefined });

    const path = normalizeRepoPath(parsed.path);
    if (path === null) {
      throw badRequest("invalid_path", "path must be a repository-relative file path");
    }

    // Scoped by projectId, never by path alone: the same path can exist in
    // several projects, and answering from another one would leak its symbols.
    const file = await prisma().file.findFirst({
      where: { projectId: project.id, path },
      select: {
        path: true,
        language: true,
        size: true,
        status: true,
        lastIndexedCommit: true,
        lastIndexedAt: true,
        symbols: {
          orderBy: [{ startLine: "asc" }, { endLine: "asc" }],
          // Bounded, like the MCP twin (MAX_OUTLINE_SYMBOLS in lib/mcp/server).
          // Unbounded, a single generated file could return tens of thousands
          // of symbols and bury the caller — and the API had no way to ask for
          // less, because the whole list came back every time.
          take: OUTLINE_SYMBOL_LIMIT,
          select: {
            name: true,
            qualifiedName: true,
            kind: true,
            startLine: true,
            endLine: true,
            parentName: true,
          },
        },
        _count: { select: { chunks: true, symbols: true } },
      },
    });
    if (!file) {
      throw notFound("file_not_found", `File ${path} is not indexed in this project`);
    }

    return json({
      file: {
        path: file.path,
        language: file.language,
        size: file.size,
        status: file.status,
        lastIndexedCommit: file.lastIndexedCommit,
        lastIndexedAt: file.lastIndexedAt,
        chunkCount: file._count.chunks,
        // The true total, not the returned count, so a caller can tell a
        // complete outline from a truncated one.
        symbolCount: file._count.symbols,
        // True when symbols exist beyond the cap. Never return a short list
        // silently: an outline that looks complete but is not sends the caller
        // to read the wrong lines.
        truncated: file._count.symbols > OUTLINE_SYMBOL_LIMIT,
        outlineLimit: OUTLINE_SYMBOL_LIMIT,
      },
      symbols: file.symbols,
    });
  })(request, {});
}
