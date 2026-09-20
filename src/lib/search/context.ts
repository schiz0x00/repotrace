import { prisma } from "@/lib/prisma";
import { hybridSearch, type SearchResultItem } from "@/lib/search/hybrid";
import {
  findReferences,
  findTests,
  findSymbol,
  type SymbolHit,
} from "@/lib/search/structural";
import { searchProject, type SearchResponse } from "@/lib/search/search";

/**
 * Context bundles are the primary retrieval output: a curated, project-scoped
 * answer to a natural-language question, not raw database rows.
 *
 * {
 *   query, symbols: [...], tests: [...], docs: [...], relationships: [...]
 * }
 */

export interface ContextRelationship {
  from: string;
  to: string;
  kind: "calls" | "imports" | "extends";
}

export interface ContextBundle {
  query: string;
  projectId: string;
  symbols: Array<SearchResultItem & { fileId: string }>;
  relatedSymbols: SymbolHit[];
  tests: SymbolHit[];
  docs: SearchResultItem[];
  relationships: ContextRelationship[];
  sources: { vector: number; lexical: number; symbol: number };
  tookMs: number;
}

export async function buildContextBundle(
  projectId: string,
  query: string,
  opts: { limit?: number } = {},
): Promise<ContextBundle> {
  const started = Date.now();
  const limit = opts.limit ?? 8;

  const results = await hybridSearch(projectId, query, {
    limit: limit * 3,
    lexicalLimit: limit * 6,
    vectorLimit: limit * 6,
  });

  const symbols = results.items.filter((i) => i.symbol).slice(0, limit);
  const docs = results.items.filter((i) => i.chunkType === "documentation").slice(0, limit);
  const tests: SymbolHit[] = [];

  // Tests for the top symbols.
  for (const item of symbols.slice(0, 4)) {
    if (!item.symbol) continue;
    const hits = await findTests(projectId, item.symbol.split(".").pop() ?? item.symbol, 5);
    for (const h of hits) {
      if (!tests.some((t) => t.qualifiedName === h.qualifiedName)) tests.push(h);
    }
    if (tests.length >= 10) break;
  }

  // Relationships between the top symbols and what they call/import.
  const relationships: ContextRelationship[] = [];
  const relatedSymbols: SymbolHit[] = [];
  for (const item of symbols.slice(0, 6)) {
    if (!item.symbol) continue;
    const symbol = await findSymbol(projectId, item.symbol);
    if (!symbol) continue;
    for (const call of symbol.calls.slice(0, 6)) {
      relationships.push({ from: symbol.qualifiedName, to: call, kind: "calls" });
      const callee = await findSymbol(projectId, call.split(".").pop() ?? call);
      if (callee && !relatedSymbols.some((r) => r.id === callee.id)) relatedSymbols.push(callee);
    }
    for (const imp of symbol.imports.slice(0, 6)) {
      relationships.push({ from: symbol.qualifiedName, to: imp, kind: "imports" });
    }
    for (const ext of symbol.extends.slice(0, 3)) {
      relationships.push({ from: symbol.qualifiedName, to: ext, kind: "extends" });
    }
    const refs = await findReferences(projectId, symbol.name, 5);
    for (const r of refs) {
      if (!relatedSymbols.some((x) => x.id === r.id)) relatedSymbols.push(r);
    }
  }

  const { sources } = results;
  return {
    query,
    projectId,
    symbols: symbols.slice(0, limit),
    relatedSymbols: relatedSymbols.slice(0, limit),
    tests: tests.slice(0, 8),
    docs,
    relationships: relationships.slice(0, 15),
    sources,
    tookMs: Date.now() - started,
  };
}

export { searchProject };
export type { SearchResponse };