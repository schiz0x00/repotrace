import { embedTexts, resolveEmbeddingConfig } from "@/lib/embedding/provider";
import { searchVectors, type VectorHit } from "@/lib/qdrant";

export interface SemanticOptions {
  limit: number;
  chunkTypes?: string[];
  languages?: string[];
  embeddingVersion?: number;
}

/** Semantic search: embed the query, then nearest-neighbor over Qdrant. */
export async function semanticSearch(
  projectId: string,
  query: string,
  opts: SemanticOptions,
): Promise<VectorHit[]> {
  const config = await resolveEmbeddingConfig(projectId);
  const [vector] = await embedTexts(config, [query]);
  return searchVectors(projectId, vector, opts.limit, {
    embeddingVersion: opts.embeddingVersion ?? config.version,
    chunkTypes: opts.chunkTypes,
    languages: opts.languages,
  });
}