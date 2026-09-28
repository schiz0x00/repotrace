import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import type { Principal } from "@/lib/authn";
import { badRequest, forbidden, notFound } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { searchProject } from "@/lib/search/search";
import { buildContextBundle } from "@/lib/search/context";
import {
  dependencyGraph,
  findDependencies,
  findReferences,
  findSymbol,
  findTests,
  searchSymbols,
  type DependencyGraph,
  type SymbolHit,
} from "@/lib/search/structural";
import { countVectors } from "@/lib/qdrant";
import { redactUrl } from "@/lib/git/git";
import {
  commitCursorWhere,
  encodeCommitCursor,
  parseCommitCursor,
} from "@/lib/commits/cursor";
import {
  assembleRange,
  capRangeChars,
  chunkBounds,
  clampLineRange,
  MAX_FILE_CONTENT_CHARS,
  type ContentChunk,
} from "@/lib/search/file-outline";

/**
 * MCP server exposing project-aware retrieval tools to AI agents.
 *
 * Project access is enforced per request: every project-scoped tool takes a
 * `project` argument, and API keys scoped to a single project are locked to
 * it — an agent can never omit the tenant context.
 */

/*
 * The character ceiling a single tool result may return is `MAX_FILE_CONTENT_CHARS`,
 * imported above from `search/file-outline` rather than re-declared here.
 * Agent context windows are finite, so a tool that can return an entire file
 * needs a ceiling, and the file API route has to quote the same number in its
 * own truncation notices: two copies of the cap would let an agent be told it
 * hit "100,000 characters" by one read path and a different figure by the other.
 */

/**
 * Largest `maxLines` the `get_file_range` schema accepts. This is a schema bound,
 * not a clamp applied after the fact: a request for more is rejected by argument
 * validation rather than quietly shortened. It sits below the shared
 * `MAX_FILE_CONTENT_LINES` (5,000) in `search/file-outline`, which is the bound
 * that actually decides how much of a range comes back once the arguments are
 * themselves in range.
 */
const MAX_RANGE_LINES = 2_000;

/** Ceiling on symbols listed by `get_file_outline`. */
const MAX_OUTLINE_SYMBOLS = 300;

/**
 * Ceiling on edges *printed* by `get_dependency_graph`.
 *
 * Distinct from the walk's own edge budget in `search/structural`
 * (`graphEdgeLimit`), which decides how much of the graph is collected at all.
 * This one only decides how much of what was collected reaches the agent: a
 * graph can arrive complete and still print short here, and no argument the
 * tool accepts changes this number.
 */
const MAX_PRINTED_GRAPH_EDGES = 240;

/*
 * Commit paging.
 *
 * `encodeCommitCursor`, `parseCommitCursor` and `commitCursorWhere` are
 * imported from `@/lib/commits/cursor`, which the REST commits route imports
 * too. They used to be duplicated here verbatim, on the stated grounds that
 * the two callers sat on opposite sides of the app/lib boundary -- which was
 * never true, since both are in `src/lib`, and which left a real risk of the
 * two copies drifting into paging the same history differently.
 *
 * `commitPageHint` below is deliberately NOT part of that shared format: the
 * MCP tool takes exactly `limit` rows and cannot prove the history ended, so
 * it always hints on a full page. Only the REST route over-fetches by one row,
 * which is what lets it return `nextBefore: null` at the true end.
 */

/**
 * The paging hint for a full page, or null when the page was short and the
 * history is exhausted. The cursor is composite, so passing it back returns
 * every remaining commit exactly once.
 */
export function commitPageHint(
  rows: readonly { sha: string; authoredAt: Date }[],
  limit: number,
): string | null {
  if (rows.length < limit) return null;
  const last = rows[rows.length - 1];
  if (!last) return null;
  return `[more commits may exist; call again with before=${encodeCommitCursor(last)}]`;
}

/**
 * The text for a `list_commits` page that came back empty.
 *
 * Two situations produce the same zero rows and need opposite advice, and an
 * empty page alone cannot tell them apart: with a cursor the caller has paged
 * to the end of what was indexed, without one nothing was ever recorded for
 * this branch. Sending an agent that has just read to the end of the history
 * off to re-index is the failure this distinction exists to prevent.
 *
 * Exported so both branches are testable without a database.
 */
export function emptyCommitPage(branch: string, paged: boolean): string {
  return paged
    ? `No more commits recorded for branch ${branch}. You have reached the end of the history captured during indexing; older commits, if the repository has them, were not indexed.`
    : `No commits recorded for branch ${branch}. History is captured during indexing, so this branch was either never indexed, or it had no commits at the time.`;
}

/**
 * The footer for a page that came back short, which is the only positive
 * evidence this tool has that the recorded history ended: it asked for `limit`
 * rows and got fewer. Without it the agent has to infer the end from the row
 * count, and "no more rows" then reads the same whether paging is finished or
 * the branch was never indexed.
 */
export function endOfCommitHistory(branch: string): string {
  return `[end of recorded history for branch ${branch}]`;
}

export function createMcpServer(principal: Principal): McpServer {
  const server = new McpServer({
    name: "repotrace",
    version: "1.0.0",
  });

  const scope = (project: string | undefined) => resolveProjectScope(principal, project);

  server.registerTool(
    "list_projects",
    {
      description:
        "List projects available to this credential, with slug, name, indexing status and repository URL. Use the slug in `project` arguments of other tools.",
      inputSchema: z.object({}),
    },
    async () => {
      const projects = await prisma().project.findMany({
        where:
          principal.type === "api_key" && principal.projectId
            ? { id: principal.projectId }
            : undefined,
        select: {
          slug: true,
          name: true,
          description: true,
          // Redacted in the mapping below. Selecting the raw column and
          // transforming it is what let a pasted `user:token@host` credential
          // reach any API-key holder through this tool, while every REST
          // surface deliberately stripped it.
          repoUrl: true,
          status: true,
          defaultBranch: true,
        },
        orderBy: { name: "asc" },
      });
      // Redacted on the way out. `list_projects` returns the repository URL to
      // every caller with the project's scope, and that URL is whatever the
      // operator typed — which for a private repository is
      // `https://user:token@host/...`. The REST project DTO strips it; this
      // tool did not, so the MCP surface was the one place a pasted git
      // credential was handed to an untrusted client.
      const safe = projects.map((p) => ({ ...p, repoUrl: redactUrl(p.repoUrl) }));
      return {
        content: [{ type: "text", text: JSON.stringify(safe, null, 2) }],
      };
    },
  );

  server.registerTool(
    "search_code",
    {
      description:
        "Hybrid (semantic + lexical) search over a project's code. Returns ranked chunks with file paths, line ranges, symbol names and scores. Query in natural language or with identifiers. This tool always returns code text; to look a symbol up by name and read its relationships, use find_symbol.",
      inputSchema: z.object({
        project: z.string().describe("Project slug or id"),
        query: z.string().describe("Natural-language or identifier query"),
        limit: z.number().int().min(1).max(25).default(8),
        // `symbol` is deliberately absent from this enum, even though
        // `searchProject` still accepts it. That branch maps every hit to
        // `content: ""` — the symbol index stores no body text — so it would
        // return locations and no source at all, which contradicts this tool's
        // own description ("always returns code text"). The formatter now says
        // explicitly that such a hit has no text and points at get_file_range,
        // so the blank-line rendering the earlier version of this comment
        // objected to is not the reason any more; the reason is that a
        // code-search tool that returns no code is find_symbol's job instead.
        // Re-add "symbol" here in the same change that makes search.ts
        // populate content for that branch.
        mode: z.enum(["hybrid", "lexical", "semantic"]).default("hybrid"),
        chunkTypes: z
          .array(z.enum(["code", "test", "documentation", "configuration"]))
          .optional(),
      }),
    },
    async ({ project, query, limit, mode, chunkTypes }) => {
      const { projectId } = await scope(project);
      const result = await searchProject(projectId, query, {
        mode,
        limit,
        chunkTypes,
      });
      return {
        content: [{ type: "text", text: formatSearch(result) }],
      };
    },
  );

  server.registerTool(
    "search_docs",
    {
      description:
        "Search documentation (markdown, README, docs/ files) inside a project.",
      inputSchema: z.object({
        project: z.string().describe("Project slug or id"),
        query: z.string(),
        limit: z.number().int().min(1).max(20).default(5),
      }),
    },
    async ({ project, query, limit }) => {
      const { projectId } = await scope(project);
      const result = await searchProject(projectId, query, {
        mode: "hybrid",
        limit,
        chunkTypes: ["documentation"],
      });
      return {
        content: [{ type: "text", text: formatSearch(result) }],
      };
    },
  );

  server.registerTool(
    "find_symbol",
    {
      description:
        "Find a symbol (function, class, method, interface, type, enum, constant) by exact or partial name. Returns its definition location and structural metadata (calls, imports).",
      inputSchema: z.object({
        project: z.string().describe("Project slug or id"),
        name: z.string().describe("Symbol name or qualified name, e.g. OrderService.cancelOrder"),
        limit: z.number().int().min(1).max(20).default(10),
      }),
    },
    async ({ project, name, limit }) => {
      const { projectId } = await scope(project);
      const exact = await findSymbol(projectId, name);
      const partial = await searchSymbols(projectId, name, { limit });
      const symbols = exact
        ? [exact, ...partial.filter((s) => s.id !== exact.id)].slice(0, limit)
        : partial.slice(0, limit);
      if (symbols.length === 0) {
        return { content: [{ type: "text", text: `No symbol named "${name}" found.` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: symbols.map(formatSymbol).join("\n\n"),
          },
        ],
      };
    },
  );

  server.registerTool(
    "find_references",
    {
      description:
        "Find symbols that call, import or extend the given symbol (callers, usages), ranked by match score. Returns at most 50 — the `limit` ceiling, default 25 — and appends a note when that cap is reached, so a list that stops at the cap is not the whole set.",
      inputSchema: z.object({
        project: z.string().describe("Project slug or id"),
        symbol: z.string().describe("Symbol name or qualified name, e.g. OrderService.cancelOrder"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(25)
          .describe(
            "Maximum references to return, highest match score first. 50 is the ceiling and no argument raises it; a result at the ceiling is the top 50, not every caller.",
          ),
      }),
    },
    async ({ project, symbol, limit }) => {
      const { projectId } = await scope(project);
      const refs = await findReferences(projectId, symbol.split(".").pop() ?? symbol, limit);
      if (refs.length === 0) {
        return { content: [{ type: "text", text: `No references to "${symbol}" found.` }] };
      }
      const lines = refs.map((r) => `${r.qualifiedName} (${r.kind}) — ${r.path}:${r.startLine}`);
      // `findReferences` orders by match score and stops at `limit`, so a full
      // page means there may be more matches below it. Without this the agent
      // reads a 50-row list as the complete set of callers, which is the wrong
      // answer rather than a partial one.
      if (refs.length >= limit) {
        lines.push(
          `\n[showing the top ${refs.length} of possibly more references; ${limit === 50 ? "50 is the ceiling for this tool and no argument raises it" : "raise \`limit\` (max 50) for more"}. Narrow \`symbol\` to a qualified name to enumerate one symbol's callers exactly.]`,
        );
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  );

  server.registerTool(
    "find_dependencies",
    {
      description:
        "List what a symbol depends on: the calls, imports and supertypes inside its body.",
      inputSchema: z.object({
        project: z.string().describe("Project slug or id"),
        symbol: z.string().describe("Symbol name or qualified name"),
      }),
    },
    async ({ project, symbol }) => {
      const { projectId } = await scope(project);
      const deps = await findDependencies(projectId, symbol);
      if (!deps) {
        return { content: [{ type: "text", text: `Symbol "${symbol}" not found.` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                symbol,
                calls: deps.calls,
                imports: deps.imports,
                extends: deps.extends,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "find_tests",
    {
      description:
        "Find test files covering a symbol or topic (test files mentioning the name).",
      inputSchema: z.object({
        project: z.string().describe("Project slug or id"),
        symbol: z.string().optional().describe("Symbol name to find tests for"),
        limit: z.number().int().min(1).max(20).default(5),
      }),
    },
    async ({ project, symbol, limit }) => {
      const { projectId } = await scope(project);
      const tests = await findTests(projectId, symbol, limit);
      if (tests.length === 0) {
        return {
          content: [{ type: "text", text: "No test files found." }],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: tests.map((t) => `${t.qualifiedName} — ${t.path}`).join("\n"),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_file",
    {
      description:
        "Retrieve the indexed content of a file in the project (symbol-level reconstruction from the index). Prefer get_file_outline first on a large file: it is much cheaper, and get_file_range reads an exact line range.",
      inputSchema: z.object({
        project: z.string().describe("Project slug or id"),
        path: z.string().describe("Repository-relative file path, e.g. src/orders/service.ts"),
      }),
    },
    async ({ project, path }) => {
      const { projectId } = await scope(project);
      const file = await requireFile(projectId, path, {
        id: true,
        path: true,
        language: true,
        lastIndexedCommit: true,
        chunks: { orderBy: { startLine: "asc" }, select: { content: true } },
      });
      const full = file.chunks.map((c) => c.content).join("\n");
      // Returning an entire file can be ~1MB of text, which overflows the
      // calling agent's context window. Truncate and say so, rather than
      // failing the tool call or silently dropping the tail.
      const truncated = full.length > MAX_FILE_CONTENT_CHARS;
      const content = truncated ? full.slice(0, MAX_FILE_CONTENT_CHARS) : full;
      const notice = truncated
        ? `\n\n[truncated: showing first ${MAX_FILE_CONTENT_CHARS} of ${full.length} characters. Read the rest with get_file_range, or use get_file_outline to jump to a symbol. Note: this view concatenates chunks and its line offsets do not match the file — use get_file_range when line numbers matter.]`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `--- ${path} (${file.language}, indexed commit ${file.lastIndexedCommit?.slice(0, 8) ?? "unknown"}) ---\n${content}${notice}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_file_outline",
    {
      description:
        "List the symbols declared in one indexed file (functions, classes, methods, types, interfaces, constants) with their line ranges, plus the calls each one makes. Use it to pick a line range for get_file_range, or to navigate a file you have not read yet. Cheaper than reading a whole file.",
      inputSchema: z.object({
        project: z.string().describe("Project slug or id"),
        path: z.string().describe("Repository-relative file path, e.g. src/orders/service.ts"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_OUTLINE_SYMBOLS)
          .default(120)
          .describe("Maximum symbols to list"),
      }),
    },
    async ({ project, path, limit }) => {
      const { projectId } = await scope(project);
      // Resolve through the scoped project id first: `path` alone is not
      // unique across tenants, so a bare file lookup would be a cross-project
      // read waiting to happen.
      const file = await requireFile(projectId, path, {
        id: true,
        path: true,
        language: true,
        lastIndexedCommit: true,
      });
      // Over-fetch by one so "there are more" is knowable without a count.
      const rows = await prisma().symbol.findMany({
        where: { fileId: file.id },
        orderBy: [{ startLine: "asc" }, { name: "asc" }],
        take: limit + 1,
        select: {
          name: true,
          qualifiedName: true,
          kind: true,
          startLine: true,
          endLine: true,
          parentName: true,
          metadata: true,
        },
      });
      return {
        content: [
          {
            type: "text",
            text: formatOutline(file, rows.slice(0, limit), rows.length > limit),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_file_range",
    {
      description:
        "Read a line range of an indexed file, with line numbers, so code can be located precisely. Use this whenever a tool result points at a file:line, and to read the part of a large file that get_file truncated.",
      inputSchema: z.object({
        project: z.string().describe("Project slug or id"),
        path: z.string().describe("Repository-relative file path, e.g. src/orders/service.ts"),
        startLine: z.number().int().min(1).describe("First line to read, 1-based and inclusive"),
        endLine: z.number().int().min(1).optional().describe("Last line, inclusive; defaults to startLine + maxLines - 1"),
        maxLines: z
          .number()
          .int()
          .min(1)
          .max(MAX_RANGE_LINES)
          .default(400)
          .describe("Maximum lines to return; the result is truncated to this. The schema rejects a larger value — 2000 is the ceiling."),
      }),
    },
    async ({ project, path, startLine, endLine, maxLines }) => {
      const { projectId } = await scope(project);
      if (endLine !== undefined && endLine < startLine) {
        throw badRequest(
          "invalid_range",
          `endLine (${endLine}) must be greater than or equal to startLine (${startLine})`,
        );
      }
      const file = await requireFile(projectId, path, {
        id: true,
        path: true,
        language: true,
        lastIndexedCommit: true,
        chunks: {
          orderBy: { startLine: "asc" },
          select: { content: true, startLine: true, endLine: true },
        },
      });
      const lines = readRange(file, startLine, endLine, maxLines);
      return {
        content: [{ type: "text", text: formatLineRange(file, lines) }],
      };
    },
  );

  server.registerTool(
    "get_dependency_graph",
    {
      description:
        "Bounded call/import/extends graph around a symbol — what changing this would touch. Returns the symbols reached within `depth` hops and the edges between them, marking library imports as unresolved. Prefer over find_dependencies when you need the shape rather than one symbol's direct list.",
      inputSchema: z.object({
        project: z.string().describe("Project slug or id"),
        symbol: z.string().describe("Symbol name or qualified name, e.g. OrderService.cancelOrder"),
        depth: z
          .number()
          .int()
          .min(1)
          .max(3)
          .default(1)
          .describe("Hops from the root symbol. 1 = what it touches, 2 = what that touches"),
        maxNodes: z
          .number()
          .int()
          .max(200)
          .min(1)
          .default(60)
          .describe(
            "Maximum symbols in the graph. The edge budget is 4 per node (at least 64), so this also bounds how many relationships the walk can collect: at the ceiling of 200 that is 800 edges. Raising it past 60 collects more edges than the tool will print — the result is capped at 240 edges either way.",
          ),
      }),
    },
    async ({ project, symbol, depth, maxNodes }) => {
      const { projectId } = await scope(project);
      const graph = await dependencyGraph(projectId, symbol, { depth, limit: maxNodes });
      if (!graph.root) {
        return { content: [{ type: "text", text: `Symbol "${symbol}" not found.` }] };
      }
      return { content: [{ type: "text", text: formatGraph(graph) }] };
    },
  );

  server.registerTool(
    "get_project",
    {
      description:
        "Get project metadata: repository, branch, index status, embedding config and counts.",
      inputSchema: z.object({
        project: z.string().describe("Project slug or id"),
      }),
    },
    async ({ project }) => {
      const { projectId } = await scope(project);
      const info = await projectStats(projectId);
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    },
  );

  server.registerTool(
    "get_index_status",
    {
      description:
        "Current indexing status of a project: progress, stage, embedding model/version, vector count.",
      inputSchema: z.object({
        project: z.string().describe("Project slug or id"),
      }),
    },
    async ({ project }) => {
      const { projectId } = await scope(project);
      const info = await projectStats(projectId);
      return { content: [{ type: "text", text: JSON.stringify(info.indexStatus, null, 2) }] };
    },
  );

  server.registerTool(
    "get_context",
    {
      description:
        "Build a curated context bundle for a question: the relevant symbols with their file locations, related symbols, tests, docs and relationships, plus the source of the single top-ranked symbol. Prefer over raw search when the agent needs a focused codebase answer.",
      inputSchema: z.object({
        project: z.string().describe("Project slug or id"),
        query: z.string().describe("The question to answer from the codebase"),
        limit: z.number().int().min(1).max(12).default(8),
      }),
    },
    async ({ project, query, limit }) => {
      const { projectId } = await scope(project);
      const bundle = await buildContextBundle(projectId, query, { limit });
      return {
        content: [{ type: "text", text: formatContext(bundle) }],
      };
    },
  );

  server.registerTool(
    "list_commits",
    {
      description:
        "Recent commit history for a project: sha, subject, author and date, newest first. Use it to see what changed recently, or to relate a question to a specific change. History is captured during indexing, so it covers the indexed range, not the full remote history.",
      inputSchema: z.object({
        project: z.string().describe("Project slug or id"),
        limit: z.number().int().min(1).max(50).default(15),
        before: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Opaque paging cursor taken verbatim from the `[more commits may exist...]` line of a previous call (an ISO-8601 timestamp and a sha, separated by `|`). Pass it back unchanged.",
          ),
      }),
    },
    async ({ project, limit, before }) => {
      const { projectId } = await scope(project);
      const repository = await prisma().repository.findUnique({
        where: { projectId },
        select: { id: true, branch: true, lastKnownCommit: true },
      });
      if (!repository) {
        return { content: [{ type: "text", text: "This project has no repository configured." }] };
      }
      const cursor = before ? parseCommitCursor(before) : null;
      const rows = await prisma().commit.findMany({
        where: {
          // repositoryId is the caller's resolved project; the cursor clause is
          // ANDed with it, so paging can never widen the query past the tenant.
          repositoryId: repository.id,
          ...(cursor ? commitCursorWhere(cursor) : {}),
        },
        orderBy: [{ authoredAt: "desc" }, { sha: "desc" }],
        take: limit,
        select: { sha: true, message: true, author: true, authoredAt: true },
      });
      if (rows.length === 0) {
        return {
          content: [
            { type: "text", text: emptyCommitPage(repository.branch, cursor !== null) },
          ],
        };
      }
      const lines = rows.map((c) => {
        const date = c.authoredAt.toISOString().slice(0, 10);
        return `${c.sha.slice(0, 8)} ${date} ${c.author}: ${truncate(c.message.split("\n", 1)[0], 140)}`;
      });
      // A full page means there is probably more. Hand back the cursor rather
      // than making the agent guess one from the text it just received.
      const hint = commitPageHint(rows, limit);
      lines.push(hint ? `\n${hint}` : `\n${endOfCommitHistory(repository.branch)}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  return server;
}

async function resolveProjectScope(
  principal: Principal,
  projectArg: string | undefined,
): Promise<{ projectId: string; slug: string }> {
  if (principal.type === "api_key" && principal.projectId) {
    // Project-scoped keys are locked: the argument must match or be omitted.
    const project = await prisma().project.findUnique({
      where: { id: principal.projectId },
      select: { id: true, slug: true },
    });
    if (!project) throw forbidden("project_forbidden", "Credential project no longer exists");
    if (projectArg && projectArg !== project.id && projectArg !== project.slug) {
      throw forbidden(
        "project_forbidden",
        `This API key is scoped to project "${project.slug}" and cannot access "${projectArg}"`,
      );
    }
    return { projectId: project.id, slug: project.slug };
  }
  if (!projectArg) {
    throw forbidden("project_required", "The `project` argument is required");
  }
  const project = await prisma().project.findFirst({
    where: { OR: [{ id: projectArg }, { slug: projectArg }] },
    select: { id: true, slug: true },
  });
  if (!project) throw notFound("project_not_found", `Project "${projectArg}" not found`);
  return { projectId: project.id, slug: project.slug };
}

/**
 * Resolves a repository-relative path to a file **inside the already-scoped
 * project**. Every file-reading tool funnels through here, so a caller-supplied
 * path can never reach another tenant's file: `path` is only unique within a
 * project, and the `projectId` filter is what makes it so.
 */
async function requireFile<P extends Prisma.FileSelect>(
  projectId: string,
  path: string,
  select: P,
): Promise<Prisma.FileGetPayload<{ select: P }>> {
  const file = await prisma().file.findFirst({ where: { projectId, path }, select });
  if (!file) throw notFound("file_not_found", `File ${path} is not indexed in this project`);
  return file;
}

async function projectStats(projectId: string) {
  const db = prisma();
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { repository: true },
  });
  if (!project) throw notFound("project_not_found", "Project not found");
  const [files, symbols, chunks, vectors, activeJobs] = await Promise.all([
    db.file.count({ where: { projectId, status: "indexed" } }),
    db.symbol.count({ where: { projectId } }),
    db.chunk.count({ where: { projectId } }),
    countVectors(projectId).catch(() => -1),
    db.job.count({ where: { projectId, status: { in: ["queued", "running"] } } }),
  ]);
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    // Never the stored value: an operator who pasted
    // https://user:token@host/repo would otherwise hand that token to every
    // MCP client holding the project's key.
    repoUrl: redactUrl(project.repoUrl),
    defaultBranch: project.defaultBranch,
    status: project.status,
    repository: project.repository
      ? {
          lastKnownCommit: project.repository.lastKnownCommit,
          lastSuccessfulSync: project.repository.lastSuccessfulSync,
          syncStatus: project.repository.syncStatus,
        }
      : null,
    indexStatus: {
      files,
      symbols,
      chunks,
      vectors,
      embeddingModel: project.embeddingModel,
      embeddingVersion: project.embeddingVersion,
      embeddingDimensions: project.embeddingDimensions,
      activeJobs,
      progress: activeJobs > 0 ? "indexing" : project.status,
    },
  };
}

export function formatSearch(result: Awaited<ReturnType<typeof searchProject>>): string {
  const lines: string[] = [
    `Project: ${result.project.slug} (${result.mode} search, ${result.tookMs}ms, sources: vector=${result.sources.vector} lexical=${result.sources.lexical} symbol=${result.sources.symbol})`,
    "",
  ];
  if (result.items.length === 0) {
    lines.push("No results.");
    return lines.join("\n");
  }
  for (const item of result.items) {
    // A contentless hit would otherwise render as a header over a blank line,
    // which reads as a rendering bug rather than as "this result has no text".
    // Say what to do about it instead.
    const body = item.content
      ? truncate(item.content, 1200)
      : "(no text in this result — read these lines with get_file_range)";
    lines.push(
      `### ${item.symbol ?? item.path}\n` +
        `${item.path}:${item.startLine}-${item.endLine} [${item.chunkType}] score=${item.hybridScore.toFixed(3)} sources=${item.provenance.join(",")}\n` +
        body,
    );
    lines.push("");
  }
  return lines.join("\n");
}

export function formatSymbol(s: SymbolHit): string {
  return [
    `${s.qualifiedName} (${s.kind}, ${s.language})`,
    `${s.path}:${s.startLine}-${s.endLine}`,
    s.parentName ? `parent: ${s.parentName}` : null,
    s.calls.length ? `calls: ${s.calls.slice(0, 12).join(", ")}` : null,
    s.imports.length ? `imports: ${s.imports.slice(0, 8).join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

interface OutlineSymbol {
  name: string;
  qualifiedName: string;
  kind: string;
  startLine: number;
  endLine: number;
  parentName: string | null;
  metadata: unknown;
}

/**
 * Renders a file's symbol table. `hasMore` comes from an over-fetch by one, so
 * a truncated outline says so rather than quietly presenting a partial file as
 * the whole thing.
 */
export function formatOutline(
  file: { path: string; language: string; lastIndexedCommit?: string | null },
  symbols: OutlineSymbol[],
  hasMore = false,
): string {
  const head = `--- ${file.path} (${file.language}, indexed commit ${file.lastIndexedCommit?.slice(0, 8) ?? "unknown"}) — ${symbols.length} symbol${symbols.length === 1 ? "" : "s"} ---`;
  if (symbols.length === 0) {
    return `${head}\nNo symbols indexed for this file. It may be prose, or not yet indexed — try get_file_range or search_code.`;
  }
  const lines = symbols.map((s) => {
    const meta = symbolMetadata(s.metadata);
    const calls = meta.calls.length ? `  calls: ${meta.calls.slice(0, 8).join(", ")}` : "";
    const parent = s.parentName ? ` in ${s.parentName}` : "";
    return `${String(s.startLine).padStart(5)}-${String(s.endLine).padEnd(5)} ${s.kind} ${s.qualifiedName}${parent}${calls}`;
  });
  if (hasMore) {
    lines.push(
      `[truncated: showing the first ${symbols.length} symbols. Narrow the file or raise \`limit\`.]`,
    );
  }
  return [head, ...lines].join("\n");
}

/** The `metadata` jsonb column, defensively read. */
function symbolMetadata(metadata: unknown): { calls: string[]; imports: string[]; extends: string[] } {
  const meta = (metadata ?? {}) as { calls?: unknown; imports?: unknown; extends?: unknown };
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { calls: list(meta.calls), imports: list(meta.imports), extends: list(meta.extends) };
}

export interface FileRangeView {
  from: number;
  to: number;
  /** Indexed extent of the file, so a clamped read can say what it was pulled into. */
  firstLine: number;
  lastLine: number;
  lines: { lineNumber: number; text: string }[];
  /** The request fell outside the indexed extent and was pulled in. */
  clampedToBounds: boolean;
  /** The tool's own `maxLines` argument cut the range short. */
  truncatedByMaxLines: boolean;
  /** Lines in range that no chunk covers. An index gap, not a blank source line. */
  missingLineCount: number;
  /**
   * First line dropped by the character cap, or null when the cap did not cut
   * between lines. It is also null when `lineTruncated` is set: the cap cut
   * *inside* a line, and there is no line number that resumes from there.
   */
  nextLine: number | null;
  /**
   * A single line was itself sliced to the character cap. The rest of that line
   * is unreachable through this tool, so there is no line number to resume from.
   */
  lineTruncated: boolean;
  /**
   * The caller's explicit `endLine`, or undefined when it was defaulted.
   * Echoed in a notice only when the result stopped short of it.
   */
  requestedEnd: number | undefined;
}

/**
 * Resolves a requested line range against a file's stored chunks.
 *
 * Bounds handling, assembly and the character cap all live in
 * `search/file-outline` and are shared with the file API route; only the
 * `maxLines` argument is this tool's own, and it is a tighter ceiling layered
 * on top of the shared one. The default for `endLine` is computed against the
 * file's real extent so "no endLine" means "up to the cap", not "the whole
 * file" — the shared clamp would otherwise happily hand back 5,000 lines.
 */
export function readRange(
  file: { path: string; language: string; lastIndexedCommit?: string | null; chunks: ContentChunk[] },
  startLine: number,
  endLine: number | undefined,
  maxLines: number,
): FileRangeView | null {
  const bounds = chunkBounds(file.chunks);
  // No chunks, or none of them spanning a usable line: nothing to read.
  if (!bounds) return null;
  const wanted = endLine ?? Math.min(bounds.lastLine, startLine + maxLines - 1);
  const clamped = clampLineRange({ startLine, endLine: wanted }, bounds);
  if (!clamped) return null;
  // With an explicit `endLine` the cap is visible as an over-long range. With
  // the default there is no request to compare against, so the implied request
  // is "to the end of the file" — if that reaches past the cap, the cap is
  // still a truncation and the agent is still owed a resume hint.
  const truncatedByMaxLines =
    clamped.endLine - clamped.startLine + 1 > maxLines ||
    (endLine === undefined && bounds.lastLine > clamped.endLine);
  const to = truncatedByMaxLines ? clamped.startLine + maxLines - 1 : clamped.endLine;
  const assembled = assembleRange(file.chunks, clamped.startLine, to);
  const capped = capRangeChars(assembled);
  return {
    from: clamped.startLine,
    to,
    firstLine: bounds.firstLine,
    lastLine: bounds.lastLine,
    lines: capped.lines,
    clampedToBounds: clamped.clampedToBounds,
    truncatedByMaxLines,
    missingLineCount: assembled.missingLineCount,
    nextLine: capped.nextLine,
    lineTruncated: capped.lineTruncated,
    requestedEnd: endLine,
  };
}

export function formatLineRange(
  file: { path: string; language: string; lastIndexedCommit?: string | null },
  view: FileRangeView | null,
): string {
  const head = `--- ${file.path} (${file.language}, indexed commit ${file.lastIndexedCommit?.slice(0, 8) ?? "unknown"}) ---`;
  if (!view) {
    return `${head}\nNo indexed content for this file. Try search_code, or get_file_outline to see whether it was parsed.`;
  }
  const width = String(view.to).length;
  const body = view.lines
    .map((l) => `${String(l.lineNumber).padStart(width, " ")} | ${l.text}`)
    .join("\n");
  // The character cap can cut *inside* the range `maxLines` allowed, so `view.to`
  // is not always the last line the agent actually received. The rendered body
  // is the ground truth: a range that claims to reach line `to` but stops at
  // line 4 sends the agent back for text it has already been given.
  const shownTo = view.lines.length ? view.lines[view.lines.length - 1].lineNumber : view.to;
  // Exactly one authoritative resume point. Emitting both `view.to + 1` and
  // `view.nextLine` was the defect: they disagree whenever the character cap cut
  // the range short, and the agent cannot tell which one to trust. The character
  // cap wins, because it is the one that describes what was really returned.
  const charCut = view.nextLine !== null;
  const resumeAt: number | null = charCut
    ? view.nextLine
    : view.truncatedByMaxLines
      ? shownTo + 1
      : null;
  // Always reachable: `nextLine` is the first line the character cap dropped,
  // and the assembled range it came from ends at `to`, which `clampLineRange`
  // held inside the indexed extent. Neither branch can name a line past
  // `lastLine`, so the hint never sends the agent off the end of the file.
  const resume = resumeAt === null ? "" : ` Continue with startLine=${resumeAt}.`;
  const notices: string[] = [];
  if (charCut) {
    const span =
      view.requestedEnd !== undefined && view.requestedEnd > shownTo
        ? ` of the requested ${view.from}-${view.requestedEnd}`
        : "";
    // Say which caps applied: "truncated" alone does not tell the agent whether
    // raising maxLines would help (it would not) or whether the file simply ran
    // out of characters.
    const cause = view.truncatedByMaxLines
      ? `showing ${view.from}-${shownTo}; the character cap also cut inside the ${view.to}-line range maxLines allowed`
      : `showing ${view.from}-${shownTo} of ${view.from}-${view.to}`;
    notices.push(`[truncated${span}: ${cause}.${resume}]`);
  } else if (view.truncatedByMaxLines) {
    const span =
      view.requestedEnd !== undefined && view.requestedEnd > shownTo
        ? ` of the requested ${view.from}-${view.requestedEnd}`
        : "";
    notices.push(`[truncated${span}: showing ${view.from}-${shownTo}.${resume}]`);
  }
  if (view.clampedToBounds) {
    // Independent of the truncation notices above, deliberately. These were one
    // if/else-if chain, so the character cap firing in the same call silenced
    // this one — and an agent that asked for lines 8-500 and got a character-
    // capped slice was left with no idea the file had ended at line 10, reading
    // a short answer as the whole file. Each bound reports itself.
    //
    // Say which way the range was out of bounds, so the agent does not read a
    // short answer as the whole file.
    const past = view.requestedEnd !== undefined && view.requestedEnd > view.lastLine;
    notices.push(
      past
        ? `[the indexed file ends at line ${view.lastLine}; showing ${view.from}-${shownTo}.]`
        : `[the requested range fell outside the indexed lines ${view.firstLine}-${view.lastLine}; showing ${view.from}-${shownTo}.]`,
    );
  }
  if (view.missingLineCount > 0) {
    // Blank text here is an index gap, not a blank source line. Without this
    // the agent reads a hole as a deliberate blank and reasons from it.
    notices.push(
      `[${view.missingLineCount} line${view.missingLineCount === 1 ? "" : "s"} in this range are not in the index and are shown blank. Use get_file_outline to see what was captured.]`,
    );
  }
  if (view.lineTruncated) {
    // `capRangeChars` sliced one line to the cap and reported no next line,
    // because a half-returned line cannot be resumed by number. That left the
    // cut invisible. State it, and state that re-reading the same line will not
    // help — an agent that retries startLine=5 forever is worse than one that
    // knows the rest of the line is out of reach here.
    //
    // Only the first line of the range can be sliced, and it consumes the whole
    // budget, so every line after it in this range was dropped too. When no
    // other bound already supplied a resume point, this notice is the one that
    // has to: otherwise the agent reads a one-line body as the whole range.
    const dropped = view.to > shownTo ? ` Lines ${shownTo + 1}-${view.to} were not shown.` : "";
    const resumeHere = resume !== "" ? "" : ` Continue with startLine=${shownTo + 1}.`;
    notices.push(
      `[line ${shownTo} is longer than the ${MAX_FILE_CONTENT_CHARS}-character cap and was cut at that length; the rest of this line is not retrievable through this tool.${dropped}${resumeHere} Use get_file_outline to find the sub-parts you need.]`,
    );
  }
  return [head, body, ...notices].join("\n");
}

/**
 * Renders the dependency graph as an indented node list plus an edge list.
 * Edges are printed separately from nodes because an unresolved edge (a library
 * import) has no node — dropping those would hide exactly the coupling a reader
 * most wants to see.
 */
export function formatGraph(graph: DependencyGraph): string {
  if (!graph.root) return "Symbol not found.";
  const root = graph.root;
  const head = `Dependency graph for ${root.qualifiedName} (${root.kind}) — ${root.path}:${root.startLine}-${root.endLine}`;
  const byDepth = new Map<number, DependencyGraph["nodes"]>();
  for (const node of graph.nodes) {
    const list = byDepth.get(node.depth) ?? [];
    list.push(node);
    byDepth.set(node.depth, list);
  }
  const lines = [head];
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    for (const node of byDepth.get(depth)!) {
      const indent = "  ".repeat(depth + 1);
      lines.push(`${indent}${node.qualifiedName} (${node.kind}) ${node.path}:${node.startLine}-${node.endLine}`);
    }
  }
  lines.push("");
  lines.push("Edges:");
  const shown = graph.edges.slice(0, MAX_PRINTED_GRAPH_EDGES);
  for (const edge of shown) {
    lines.push(`  ${edge.from} --${edge.kind}--> ${edge.to}${edge.resolved ? "" : "  (unresolved: outside this project)"}`);
  }
  const hidden = graph.edges.length - shown.length;
  if (hidden > 0) {
    // Distinct from the walk's edge budget in `search/structural`: these edges
    // were *collected*, they just did not fit in the printed list. `maxNodes`
    // is what makes this line appear at all — the walk's budget is 4 per node,
    // so only a `maxNodes` above 60 lets the collected count exceed the fixed
    // print ceiling — and even then it cannot raise the number of edges the
    // agent actually reads, which is the number it cares about.
    lines.push(
      `  … ${hidden} more edge${hidden === 1 ? "" : "s"} not shown (they are in the graph; this tool prints at most ${MAX_PRINTED_GRAPH_EDGES} edges and no argument raises that — lower \`depth\`, or ask about a narrower root symbol.)`,
    );
  }
  const notices = graphTruncationNotices(graph);
  if (notices.length > 0) {
    lines.push("", ...notices);
  }
  return lines.join("\n");
}

/**
 * One notice per bound that actually cut the walk, each naming the levers that
 * really move that bound — or, where nothing on this tool does, saying so.
 *
 * These were a single node-cap message emitted for *any* truncation. Since the
 * walk grew an edge bound of its own, that was not always the right diagnosis:
 * an agent that hit the edge cap was told to raise `maxNodes`, raised it, and
 * got the same truncated answer back.
 */
function graphTruncationNotices(graph: DependencyGraph): string[] {
  // `dependencyGraph` populates `truncation` on every path, and the field is
  // REQUIRED on the type precisely so a producer cannot omit it — that is the
  // whole reason it is not optional. `truncated` is computed from it upstream,
  // so for any TypeScript caller `!t.nodes && !t.edges` implies
  // `!graph.truncated`, and the first branch below is unreachable. It is kept
  // as a runtime guard for a graph that arrives from untyped JSON, where
  // `truncated` and `truncation` could disagree; it is not a normal path.
  const t = graph.truncation;
  if (!t || (!t.nodes && !t.edges)) {
    if (!graph.truncated) return [];
    return [
      "[truncated: this result does not say which bound was reached, so no argument below is guaranteed to help. `maxNodes` raises both the node cap and the edge budget together, so raising it is the only lever that touches either.]",
    ];
  }
  const notices: string[] = [];
  if (t.nodes) {
    notices.push(
      "[truncated: node cap reached. Symbols were dropped from the graph. Raise `maxNodes` (accepted range 1-200) to admit more; `depth` is not a lever here, because it defaults to 1, the schema minimum, so a caller on the defaults cannot lower it. Raising `maxNodes` also raises the edge budget, and the printed edge list stops at 240 regardless.]",
    );
  }
  if (t.edges) {
    // `maxNodes` is NOT a lever for what the agent reads, at any value. The
    // walk's budget is `4 * maxNodes` (floor 64, ceiling 2000) and the printed
    // list is capped at MAX_PRINTED_GRAPH_EDGES = 240, so the default 60 already
    // spends the whole print ceiling on the walk: raising `maxNodes` only
    // decides which 240 edges are printed, never how many. `depth` is not a
    // lever either — it defaults to 1, its floor. An earlier version of this
    // message told the caller to raise `maxNodes`, which is exactly the advice
    // that provably changes nothing they can see.
    notices.push(
      `[truncated: edge cap reached. The walk stopped collecting relationships, so the relationships below that point were never looked up and are not in this result. Raising \`maxNodes\` will not show you more: at the default of 60 the walk's budget is already the ${MAX_PRINTED_GRAPH_EDGES} edges this tool prints, and no \`maxNodes\` shows a 241st. \`depth\` defaults to 1, its floor, so there is nothing to lower either. Narrow \`symbol\` to a more specific one, or read the branches you care about with find_dependencies. Note that imports of libraries add edges without adding nodes, so a symbol with many external dependencies can hit this on the first hop.]`,
    );
  }
  return notices;
}

function formatContext(bundle: Awaited<ReturnType<typeof buildContextBundle>>): string {
  const out: string[] = [];
  out.push(`Query: ${bundle.query}`);
  out.push(`Sources: vector=${bundle.sources.vector} lexical=${bundle.sources.lexical} symbol=${bundle.sources.symbol}`);
  out.push("");
  if (bundle.symbols.length) {
    // Named "locations" because that is all these lines are. The description
    // used to promise code for every symbol in the bundle, but only the top hit
    // carries a body — saying so here keeps the text the agent reads as honest
    // as the tool description.
    out.push("Relevant symbols (locations; the top one's code is at the end):");
    for (const s of bundle.symbols) {
      out.push(`- ${s.symbol} (${s.path}:${s.startLine})`);
    }
  }
  if (bundle.relatedSymbols.length) {
    out.push("");
    out.push("Related symbols:");
    for (const s of bundle.relatedSymbols.slice(0, 10)) {
      out.push(`- ${s.qualifiedName} (${s.kind}) ${s.path}:${s.startLine}`);
    }
  }
  if (bundle.tests.length) {
    out.push("");
    out.push("Relevant tests:");
    for (const t of bundle.tests.slice(0, 5)) out.push(`- ${t.qualifiedName} (${t.path})`);
  }
  if (bundle.docs.length) {
    out.push("");
    out.push("Relevant documentation:");
    for (const d of bundle.docs.slice(0, 5)) out.push(`- ${d.path}:${d.startLine}${d.symbol ? ` (${d.symbol})` : ""}`);
  }
  if (bundle.relationships.length) {
    out.push("");
    out.push("Relationships:");
    for (const r of bundle.relationships.slice(0, 12)) {
      out.push(`- ${r.from} ${r.kind} ${r.to}`);
    }
  }
  if (bundle.symbols.length) {
    out.push("");
    out.push("Top result code:");
    const top = bundle.symbols[0];
    out.push(`--- ${top.path}:${top.startLine} ---`);
    // Defensive rather than expected: the bundle is built from `hybridSearch`,
    // whose items normally carry text, so this guards a contentless chunk
    // rather than a branch the symbol index is known to force. Either way,
    // printing the header over a blank line reads as a rendering bug — the same
    // defect formatSearch guards against.
    out.push(
      top.content
        ? truncate(top.content, 1500)
        : "(no text captured for this symbol — read these lines with get_file_range)",
    );
  }
  return out.join("\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated)`;
}