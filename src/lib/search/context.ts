import { hybridSearch, type SearchResultItem } from "@/lib/search/hybrid";
import {
  findReferences,
  findSymbolsBatch,
  findTests,
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

  // Everything below used to run as a serial waterfall: 4 findTests calls, then
  // per top symbol a findSymbol, one findSymbol per callee, and a
  // findReferences — up to 52 Postgres round trips issued one after another for
  // a single context bundle, which is the product's headline retrieval output.
  // The symbol lookups are now two batched queries and the remaining
  // independent lookups run concurrently, so a bundle costs a handful of round
  // trips instead of fifty.
  const topSymbols = symbols.slice(0, 6).map((i) => i.symbol!).filter(Boolean);
  const resolved = await findSymbolsBatch(projectId, topSymbols);

  // Callees of the top symbols, resolved in one further query.
  const calleeNames: string[] = [];
  for (const name of topSymbols) {
    const symbol = resolved.get(name);
    if (!symbol) continue;
    for (const call of symbol.calls.slice(0, 6)) calleeNames.push(call.split(".").pop() ?? call);
  }
  const callees = await findSymbolsBatch(projectId, calleeNames);

  // Tests and references do not depend on each other; run them together.
  const [testGroups, referenceGroups] = await Promise.all([
    Promise.all(
      topSymbols.slice(0, 4).map((name) => findTests(projectId, name.split(".").pop() ?? name, 5)),
    ),
    Promise.all(topSymbols.map((name) => {
      const symbol = resolved.get(name);
      return symbol ? findReferences(projectId, symbol.name, 5) : Promise.resolve([]);
    })),
  ]);

  const tests: SymbolHit[] = [];
  for (const group of testGroups) {
    for (const h of group) {
      if (!tests.some((t) => t.qualifiedName === h.qualifiedName)) tests.push(h);
    }
  }

  const relationships: ContextRelationship[] = [];
  const relatedSymbols: SymbolHit[] = [];
  for (const name of topSymbols) {
    const symbol = resolved.get(name);
    if (!symbol) continue;
    for (const call of symbol.calls.slice(0, 6)) {
      relationships.push({ from: symbol.qualifiedName, to: call, kind: "calls" });
      const callee = callees.get(call.split(".").pop() ?? call);
      if (callee && !relatedSymbols.some((r) => r.id === callee.id)) relatedSymbols.push(callee);
    }
    for (const imp of symbol.imports.slice(0, 6)) {
      relationships.push({ from: symbol.qualifiedName, to: imp, kind: "imports" });
    }
    for (const ext of symbol.extends.slice(0, 3)) {
      relationships.push({ from: symbol.qualifiedName, to: ext, kind: "extends" });
    }
  }
  for (const group of referenceGroups) {
    for (const r of group) {
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