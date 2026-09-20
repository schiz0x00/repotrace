import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Principal } from "@/lib/authn";
import { forbidden, notFound } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { searchProject } from "@/lib/search/search";
import { buildContextBundle } from "@/lib/search/context";
import {
  findDependencies,
  findReferences,
  findSymbol,
  findTests,
  searchSymbols,
} from "@/lib/search/structural";
import { countVectors } from "@/lib/qdrant";

/**
 * MCP server exposing project-aware retrieval tools to AI agents.
 *
 * Project access is enforced per request: every project-scoped tool takes a
 * `project` argument, and API keys scoped to a single project are locked to
 * it — an agent can never omit the tenant context.
 */

export function createMcpServer(principal: Principal): McpServer {
  const server = new McpServer({
    name: "repotrace",
    version: "1.0.0",
  });

  const scope = async (project: string | undefined) => {
    const resolved = await resolveProjectScope(principal, project);
    return resolved;
  };

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
          repoUrl: true,
          status: true,
          defaultBranch: true,
        },
        orderBy: { name: "asc" },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(projects, null, 2) }],
      };
    },
  );

  server.registerTool(
    "search_code",
    {
      description:
        "Hybrid (semantic + lexical + symbol) search over a project's code. Returns ranked chunks with file paths, line ranges, symbol names and scores. Query in natural language or with identifiers.",
      inputSchema: z.object({
        project: z.string().describe("Project slug or id"),
        query: z.string().describe("Natural-language or identifier query"),
        limit: z.number().int().min(1).max(25).default(8),
        mode: z.enum(["hybrid", "lexical", "semantic", "symbol"]).default("hybrid"),
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
        "Find all symbols that call, import or extend the given symbol (callers, usages).",
      inputSchema: z.object({
        project: z.string().describe("Project slug or id"),
        symbol: z.string().describe("Symbol name or qualified name, e.g. OrderService.cancelOrder"),
        limit: z.number().int().min(1).max(50).default(25),
      }),
    },
    async ({ project, symbol, limit }) => {
      const { projectId } = await scope(project);
      const refs = await findReferences(projectId, symbol.split(".").pop() ?? symbol, limit);
      if (refs.length === 0) {
        return { content: [{ type: "text", text: `No references to "${symbol}" found.` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: refs.map((r) => `${r.qualifiedName} (${r.kind}) — ${r.path}:${r.startLine}`).join("\n"),
          },
        ],
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
        "Retrieve the indexed content of a file in the project (symbol-level reconstruction from the index).",
      inputSchema: z.object({
        project: z.string().describe("Project slug or id"),
        path: z.string().describe("Repository-relative file path, e.g. src/orders/service.ts"),
      }),
    },
    async ({ project, path }) => {
      const { projectId } = await scope(project);
      const file = await prisma().file.findFirst({
        where: { projectId, path },
        include: { chunks: { orderBy: { startLine: "asc" } } },
      });
      if (!file) throw notFound("file_not_found", `File ${path} is not indexed in this project`);
      const content = file.chunks.map((c) => c.content).join("\n");
      return {
        content: [
          {
            type: "text",
            text: `--- ${path} (${file.language}, indexed commit ${file.lastIndexedCommit?.slice(0, 8)}) ---\n${content}`,
          },
        ],
      };
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
        "Build a curated context bundle for a question: relevant symbols with code, related symbols, tests, docs and relationships. Prefer over raw search when the agent needs a focused codebase answer.",
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
    repoUrl: project.repoUrl,
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

function formatSearch(result: Awaited<ReturnType<typeof searchProject>>): string {
  const lines: string[] = [
    `Project: ${result.project.slug} (${result.mode} search, ${result.tookMs}ms, sources: vector=${result.sources.vector} lexical=${result.sources.lexical} symbol=${result.sources.symbol})`,
    "",
  ];
  if (result.items.length === 0) {
    lines.push("No results.");
    return lines.join("\n");
  }
  for (const item of result.items) {
    lines.push(
      `### ${item.symbol ?? item.path}${item.symbol ? "" : ""}\n` +
        `${item.path}:${item.startLine}-${item.endLine} [${item.chunkType}] score=${item.hybridScore.toFixed(3)} sources=${item.provenance.join(",")}\n` +
        truncate(item.content, 1200),
    );
    lines.push("");
  }
  return lines.join("\n");
}

function formatSymbol(s: Awaited<ReturnType<typeof findSymbol>> & {
  path: string;
  kind: string;
  language: string;
}): string {
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

function formatContext(bundle: Awaited<ReturnType<typeof buildContextBundle>>): string {
  const out: string[] = [];
  out.push(`Query: ${bundle.query}`);
  out.push(`Sources: vector=${bundle.sources.vector} lexical=${bundle.sources.lexical} symbol=${bundle.sources.symbol}`);
  out.push("");
  if (bundle.symbols.length) {
    out.push("Relevant symbols:");
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
    out.push(truncate(top.content, 1500));
  }
  return out.join("\n");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated)`;
}