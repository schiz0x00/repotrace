import type { ChunkType } from "@/generated/prisma/enums";
import { notFound } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { recordMetric } from "@/lib/metrics";
import { hybridSearch, type HybridOptions, type HybridResult, type SearchResultItem } from "@/lib/search/hybrid";
import { lexicalSearch, type LexicalHit } from "@/lib/search/lexical";
import { semanticSearch } from "@/lib/search/semantic";
import {
  findDependencies,
  findReferences,
  findSymbol,
  findTests,
  searchSymbols,
  type SymbolHit,
} from "@/lib/search/structural";

export type SearchMode = "hybrid" | "lexical" | "semantic" | "symbol";

export interface SearchOptions {
  mode?: SearchMode;
  limit?: number;
  chunkTypes?: ChunkType[];
  languages?: string[];
  lexicalWeight?: number;
}

export interface SearchResponse {
  mode: SearchMode;
  query: string;
  project: { id: string; slug: string; name: string };
  items: SearchResultItem[];
  sources: { vector: number; lexical: number; symbol: number };
  tookMs: number;
}

/** Resolves a project by id or slug; throws 404 when missing. */
export async function requireProject(idOrSlug: string) {
  const project = await prisma().project.findFirst({
    where: {
      OR: [{ id: idOrSlug }, { slug: idOrSlug }],
    },
    include: { repository: true },
  });
  if (!project) throw notFound("project_not_found", "Project not found");
  return project;
}

export async function searchProject(
  projectId: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResponse> {
  const started = Date.now();
  const project = await prisma().project.findUnique({
    where: { id: projectId },
    select: { id: true, slug: true, name: true },
  });
  if (!project) throw notFound("project_not_found", "Project not found");

  const mode = opts.mode ?? "hybrid";
  const limit = Math.min(50, opts.limit ?? 10);
  const common: HybridOptions = {
    limit,
    chunkTypes: opts.chunkTypes,
    languages: opts.languages,
    lexicalWeight: opts.lexicalWeight,
  };

  let items: SearchResultItem[] = [];
  let sources = { vector: 0, lexical: 0, symbol: 0 };
  if (mode === "lexical") {
    const hits = await lexicalSearch(projectId, query, common);
    items = hits.map(toItem);
    sources.lexical = items.length;
  } else if (mode === "semantic") {
    const hits = await semanticSearch(projectId, query, {
      limit: limit * 3,
      chunkTypes: opts.chunkTypes,
      languages: opts.languages,
    });
    items = hits
      .map((h) => ({
        chunkId: h.payload.chunk_id,
        fileId: h.payload.file_id,
        path: h.payload.path,
        language: h.payload.language,
        symbol: h.payload.symbol,
        symbolKind: h.payload.kind,
        startLine: h.payload.start_line,
        endLine: h.payload.end_line,
        content: h.payload.content,
        chunkType: h.payload.chunk_type as ChunkType,
        score: h.score,
        hybridScore: h.score,
        provenance: ["vector" as const],
      }))
      .slice(0, limit);
    sources.vector = items.length;
  } else if (mode === "symbol") {
    const hits = await searchSymbols(projectId, query, { limit: limit * 3 });
    items = hits.map((s) => ({
      chunkId: null,
      fileId: "",
      path: s.path,
      language: s.language,
      symbol: s.qualifiedName,
      symbolKind: s.kind,
      startLine: s.startLine,
      endLine: s.endLine,
      content: "",
      chunkType: "code" as ChunkType,
      score: 1,
      hybridScore: 1,
      provenance: ["symbol" as const],
    }));
    sources.symbol = items.length;
  } else {
    const result = await hybridSearch(projectId, query, common);
    items = result.items;
    sources = result.sources;
  }

  await recordMetric("search_latency_ms", Date.now() - started, projectId);
  return {
    mode,
    query,
    project,
    items,
    sources,
    tookMs: Date.now() - started,
  };
}

export { findDependencies, findReferences, findSymbol, findTests, searchSymbols };
export type { LexicalHit, SymbolHit };

export function toItem(hit: LexicalHit): SearchResultItem {
  return {
    chunkId: hit.chunkId,
    fileId: hit.fileId,
    path: hit.path,
    language: hit.language,
    symbol: hit.symbol,
    symbolKind: hit.symbolKind,
    startLine: hit.startLine,
    endLine: hit.endLine,
    content: hit.content,
    chunkType: hit.chunkType,
    score: hit.score,
    hybridScore: hit.score,
    provenance: ["lexical"],
  };
}