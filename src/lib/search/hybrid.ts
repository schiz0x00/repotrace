import type { ChunkType } from "@/generated/prisma/enums";
import { lexicalSearch, symbolNameSearch, type LexicalHit } from "@/lib/search/lexical";
import { semanticSearch } from "@/lib/search/semantic";
import type { VectorHit } from "@/lib/qdrant";

/**
 * Hybrid retrieval: lexical + semantic (+ symbol) results are merged and
 * reranked with a deterministic scorer. The reranking stage is a seam:
 * swap `rerank` for a provider reranker without touching retrieval.
 */

export type Provenance = "vector" | "lexical" | "symbol" | "hybrid";

export interface SearchResultItem {
  chunkId: string | null;
  fileId: string;
  path: string;
  language: string;
  symbol: string | null;
  symbolKind: string | null;
  startLine: number;
  endLine: number;
  content: string;
  chunkType: ChunkType;
  /** Highest individual source score. */
  score: number;
  /** Combined reranked score. */
  hybridScore: number;
  /** Where this result was found. */
  provenance: Provenance[];
}

export interface HybridOptions {
  limit: number;
  chunkTypes?: ChunkType[];
  languages?: string[];
  lexicalLimit?: number;
  vectorLimit?: number;
  /** Linear interpolation between lexical and vector scores (0..1). */
  lexicalWeight?: number;
}

export interface HybridResult {
  items: SearchResultItem[];
  sources: { vector: number; lexical: number; symbol: number };
}

const SOURCE_WEIGHTS: Record<Provenance, number> = {
  vector: 1,
  lexical: 1.1,
  symbol: 1.3,
  hybrid: 1,
};

/**
 * Merges lexical + semantic (+ symbol) results and reranks deterministically.
 * Scores are normalized per source and fused with weighted reciprocal-rank.
 */
export async function hybridSearch(
  projectId: string,
  query: string,
  opts: HybridOptions,
): Promise<HybridResult> {
  const limit = Math.max(1, opts.limit);
  const vectorLimit = opts.vectorLimit ?? limit * 4;
  const lexicalLimit = opts.lexicalLimit ?? limit * 4;

  const [vectorHits, lexicalHits, symbolHits] = await Promise.all([
    semanticSearch(projectId, query, {
      limit: vectorLimit,
      chunkTypes: opts.chunkTypes,
      languages: opts.languages,
    }),
    lexicalSearch(projectId, query, {
      limit: lexicalLimit,
      chunkTypes: opts.chunkTypes,
      languages: opts.languages,
    }),
    symbolNameSearch(projectId, query, lexicalLimit, {
      chunkTypes: opts.chunkTypes,
      languages: opts.languages,
    }),
  ]);

  return mergeAndRerank({ vectorHits, lexicalHits, symbolHits }, { limit, lexicalWeight: opts.lexicalWeight });
}

export function mergeAndRerank(
  sources: {
    vectorHits: VectorHit[];
    lexicalHits: LexicalHit[];
    symbolHits?: LexicalHit[];
  },
  opts: { limit: number; lexicalWeight?: number },
): HybridResult {
  const lexicalWeight = opts.lexicalWeight ?? 0.45;

  // Dedupe by (path, startLine).
  const byKey = new Map<string, SearchResultItem>();
  // Per-source normalized scores are tracked separately. `SearchResultItem`
  // has a single `score` field, so folding both sources into it made the final
  // rerank use the same number as both the vector and the lexical contribution
  // — double-counting the strongest signal for any chunk both sources found.
  const vectorScoreByKey = new Map<string, number>();
  const lexicalScoreByKey = new Map<string, number>();

  const vectorMax = sources.vectorHits[0]?.score ?? 1;
  sources.vectorHits.forEach((hit, index) => {
    const key = `${hit.payload.path}:${hit.payload.start_line}`;
    const existing = byKey.get(key);
    const score = vectorMax > 0 ? hit.score / vectorMax : 0;
    const rrf = 1 / (60 + index);
    vectorScoreByKey.set(key, score);
    if (!existing) {
      byKey.set(key, {
        chunkId: hit.payload.chunk_id,
        fileId: hit.payload.file_id,
        path: hit.payload.path,
        language: hit.payload.language,
        symbol: hit.payload.symbol,
        symbolKind: hit.payload.kind,
        startLine: hit.payload.start_line,
        endLine: hit.payload.end_line,
        content: hit.payload.content,
        chunkType: hit.payload.chunk_type as ChunkType,
        score,
        // Accumulates reciprocal-rank only; never a raw score, so the final
        // rerank always sees a comparable RRF value.
        hybridScore: rrf * SOURCE_WEIGHTS.vector,
        provenance: ["vector"],
      });
    } else {
      existing.provenance.push("vector");
      existing.score = Math.max(existing.score, score);
      existing.hybridScore = (existing.hybridScore ?? 0) + rrf * SOURCE_WEIGHTS.vector;
      if (existing.content === "") existing.content = hit.payload.content;
    }
  });

  const lexicalMax = sources.lexicalHits[0]?.score ?? 1;
  sources.lexicalHits.forEach((hit, index) => {
    const key = `${hit.path}:${hit.startLine}`;
    const existing = byKey.get(key);
    const score = lexicalMax > 0 ? hit.score / lexicalMax : 0;
    const rrf = 1 / (60 + index);
    lexicalScoreByKey.set(key, score);
    if (!existing) {
      byKey.set(key, {
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
        score,
        hybridScore: rrf * SOURCE_WEIGHTS.lexical,
        provenance: ["lexical"],
      });
    } else {
      existing.provenance.push("lexical");
      existing.score = Math.max(existing.score, score);
      existing.hybridScore = (existing.hybridScore ?? 0) + rrf * SOURCE_WEIGHTS.lexical;
      if (existing.content === "") existing.content = hit.content;
    }
  });

  for (const hit of sources.symbolHits ?? []) {
    const key = `${hit.path}:${hit.startLine}`;
    const existing = byKey.get(key);
    const rrf = 1 / (60 + (indexOfSymbol(sources.symbolHits!, hit)));
    if (!existing) {
      byKey.set(key, {
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
        score: 1,
        hybridScore: rrf * SOURCE_WEIGHTS.symbol,
        provenance: ["symbol"],
      });
    } else {
      existing.provenance.push("symbol");
      existing.hybridScore = (existing.hybridScore ?? 0) + rrf * SOURCE_WEIGHTS.symbol;
    }
  }

  // Final rerank: weight vector-score and lexical-score plus multi-source bonus.
  const items = [...byKey.values()];
  for (const item of items) {
    const key = `${item.path}:${item.startLine}`;
    const vectorContrib = vectorScoreByKey.get(key) ?? 0;
    const lexicalContrib = lexicalScoreByKey.get(key) ?? 0;
    const multiSource = item.provenance.length > 1 ? 0.15 * item.provenance.length : 0;
    const rrf = item.hybridScore ?? 0;
    item.hybridScore =
      (1 - lexicalWeight) * vectorContrib + lexicalWeight * lexicalContrib + multiSource + rrf * 0.3;
  }
  // Sort by score, then by a stable key so equal-scoring results do not
  // reshuffle between identical queries.
  items.sort((a, b) => {
    if (b.hybridScore !== a.hybridScore) return b.hybridScore - a.hybridScore;
    const pathCmp = a.path.localeCompare(b.path);
    return pathCmp !== 0 ? pathCmp : a.startLine - b.startLine;
  });

  const countProvenance = (p: Provenance) => items.filter((i) => i.provenance.includes(p)).length;
  return {
    items: items.slice(0, opts.limit),
    sources: {
      vector: countProvenance("vector"),
      lexical: countProvenance("lexical"),
      symbol: countProvenance("symbol"),
    },
  };
}

function indexOfSymbol(symbolHits: LexicalHit[], hit: LexicalHit): number {
  return symbolHits.findIndex((h) => h.path === hit.path && h.startLine === hit.startLine);
}
