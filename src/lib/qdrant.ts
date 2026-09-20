import { createHash } from "node:crypto";
import { QdrantClient, type Schemas } from "@qdrant/js-client-rest";
import { env } from "@/lib/env";
import { recordMetric } from "@/lib/metrics";

/**
 * Qdrant is vector retrieval infrastructure only. Every project gets its own
 * collection (`proj_<id>`), so cross-project retrieval is impossible even if a
 * payload filter were forgotten. Payloads carry rich metadata for hybrid
 * search and filtering.
 */

export const COLLECTION_PREFIX = "proj_";

export function collectionFor(projectId: string): string {
  return `${COLLECTION_PREFIX}${projectId}`;
}

export interface VectorPayload {
  project_id: string;
  file_id: string;
  chunk_id: string;
  path: string;
  symbol: string | null;
  kind: string | null;
  language: string;
  module: string | null;
  start_line: number;
  end_line: number;
  content_hash: string;
  embedding_model: string;
  embedding_version: number;
  chunk_type: string;
  content: string;
}

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: VectorPayload;
}

let client: QdrantClient | null = null;

export function qdrant(): QdrantClient {
  if (client) return client;
  const cfg = env();
  client = new QdrantClient({
    url: cfg.QDRANT_URL,
    apiKey: cfg.QDRANT_API_KEY || undefined,
  });
  return client;
}

/** Deterministic point id for a chunk, so re-embedding replaces the same point. */
export function pointIdFor(chunkId: string): string {
  const hash = createHash("sha256").update(`chunk:${chunkId}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function ensureCollection(projectId: string, dimensions: number): Promise<void> {
  const name = collectionFor(projectId);
  const exists = await qdrant().collectionExists(name);
  if (exists.exists) return;
  await qdrant().createCollection(name, {
    vectors: { size: dimensions, distance: "Cosine" },
  });
  // Payload indexes power deletion-by-file and version-filtered search.
  for (const field of ["file_id", "embedding_version", "embedding_model", "chunk_type"]) {
    try {
      await qdrant().createPayloadIndex(name, {
        field_name: field,
        field_schema: "keyword",
      });
    } catch {
      // Index may already exist (concurrent workers)
    }
  }
}

export async function upsertVectors(
  projectId: string,
  points: VectorPoint[],
): Promise<void> {
  if (points.length === 0) return;
  const started = Date.now();
  await qdrant().upsert(collectionFor(projectId), {
    wait: true,
    points: points.map((p) => ({
      id: p.id,
      vector: p.vector,
      payload: p.payload as unknown as Record<string, unknown>,
    })),
  });
  await recordMetric("qdrant_latency_ms", Date.now() - started, projectId);
}

/** Deletes every vector for a file (optionally scoped to one embedding version). */
export async function deleteVectorsForFile(
  projectId: string,
  fileId: string,
  embeddingVersion?: number,
): Promise<void> {
  const filter: Schemas["Filter"] = {
    must: [
      {
        key: "file_id",
        match: { value: fileId },
      },
      ...(embeddingVersion
        ? [{ key: "embedding_version", match: { value: embeddingVersion } }]
        : []),
    ],
  };
  await qdrant().delete(collectionFor(projectId), { filter, wait: true });
}

/** Deletes every vector belonging to a project (used on project delete). */
export async function deleteProjectVectors(projectId: string): Promise<void> {
  try {
    await qdrant().deleteCollection(collectionFor(projectId));
  } catch (err) {
    // Collection may not exist; still report non-404 failures.
    const message = (err as Error).message;
    if (!message.includes("not found") && !message.includes("404")) throw err;
  }
}

export interface VectorHit {
  score: number;
  payload: VectorPayload;
}

export async function searchVectors(
  projectId: string,
  vector: number[],
  limit: number,
  filters?: {
    embeddingVersion?: number;
    chunkTypes?: string[];
    languages?: string[];
    symbols?: string[];
  },
): Promise<VectorHit[]> {
  const started = Date.now();
  const must: Schemas["Filter"]["must"] = [];
  if (filters?.embeddingVersion !== undefined) {
    must.push({ key: "embedding_version", match: { value: filters.embeddingVersion } });
  }
  if (filters?.chunkTypes?.length) {
    must.push({ key: "chunk_type", match: { any: filters.chunkTypes } });
  }
  const result = await qdrant().query(collectionFor(projectId), {
    query: vector,
    limit,
    with_payload: true,
    filter: must.length ? { must } : undefined,
  });
  await recordMetric("qdrant_latency_ms", Date.now() - started, projectId);
  return result.points
    .filter((h) => h.score !== undefined)
    .map((h) => ({
      score: h.score as number,
      payload: (h.payload ?? {}) as unknown as VectorPayload,
    }));
}

export async function countVectors(projectId: string, embeddingVersion?: number): Promise<number> {
  const filter: Schemas["Filter"] | undefined = embeddingVersion
    ? {
        must: [{ key: "embedding_version", match: { value: embeddingVersion } }],
      }
    : undefined;
  const result = await qdrant().count(collectionFor(projectId), { filter, exact: true });
  return result.count;
}

export async function qdrantHealth(): Promise<{ healthy: boolean; version?: string; error?: string }> {
  try {
    const info = await qdrant().versionInfo();
    return { healthy: true, version: info.version };
  } catch (err) {
    return { healthy: false, error: (err as Error).message };
  }
}