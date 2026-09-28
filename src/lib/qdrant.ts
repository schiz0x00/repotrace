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

/**
 * True for a Qdrant 404. Matched on the HTTP status when the client exposes
 * one, falling back to the message text only when it does not.
 */
function isNotFound(err: unknown): boolean {
  const e = err as { status?: unknown; statusCode?: unknown; message?: unknown } | null;
  const status = e?.status ?? e?.statusCode;
  if (status === 404) return true;
  if (typeof status === "number") return false;
  return typeof e?.message === "string" && /not\s*found|404/i.test(e.message);
}

/** True when a payload index already exists, which is the expected race. */
function isAlreadyExists(err: unknown): boolean {
  const e = err as { status?: unknown; message?: unknown } | null;
  if (e?.status === 400) return true;
  return typeof e?.message === "string" && /already exists/i.test(e.message);
}

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

/**
 * The vector size an existing collection was created with, or null when the
 * collection does not exist.
 *
 * Qdrant fixes a collection's dimensionality at creation time and rejects
 * every subsequent upsert whose vector length differs. A project whose
 * embedding model or dimensions change therefore keeps writing vectors the
 * store can never accept, so the mismatch has to be detectable — not just at
 * the point of failure, where it has already wedged the project.
 */
export async function collectionVectorSize(projectId: string): Promise<number | null> {
  const name = collectionFor(projectId);
  if (!(await qdrant().collectionExists(name)).exists) return null;
  const info = await qdrant().getCollection(name);
  const vectors = info.config?.params?.vectors as
    | { size?: number }
    | Record<string, { size?: number } | undefined>
    | undefined;
  if (!vectors) return null;
  // Unnamed vectors come back as a single params object; named vectors as a map.
  if (typeof (vectors as { size?: number }).size === "number") {
    return (vectors as { size: number }).size;
  }
  const first = Object.values(vectors as Record<string, { size?: number } | undefined>)[0];
  return first?.size ?? null;
}

export async function ensureCollection(
  projectId: string,
  dimensions: number,
  opts: { recreate?: boolean } = {},
): Promise<void> {
  const name = collectionFor(projectId);
  if ((await qdrant().collectionExists(name)).exists) {
    const size = await collectionVectorSize(projectId);
    if (size === null || size === dimensions) return;
    if (!opts.recreate) {
      // Deliberately not repaired here. Dropping the collection is destructive,
      // and the only job that refills it is a reembed — so an incremental run
      // must fail loudly and name the fix rather than silently destroying a
      // working index (or, worse, silently writing vectors that are rejected).
      throw new Error(
        `Vector collection ${name} holds ${size}-dimension vectors but the project is configured for ${dimensions}. ` +
          `Trigger a reembed (POST /api/v1/projects/${projectId}/reindex {"type":"reembed"}) to rebuild it.`,
      );
    }
    // A reembed is the one job whose whole purpose is regenerating every
    // vector, so it is the only caller allowed to drop and recreate.
    await qdrant().deleteCollection(name);
  }
  await qdrant().createCollection(name, {
    vectors: { size: dimensions, distance: "Cosine" },
  });
  // Payload indexes power deletion-by-file and version-filtered search.
  for (const field of ["file_id", "embedding_version", "embedding_model", "chunk_type", "language", "symbol"]) {
    try {
      await qdrant().createPayloadIndex(name, {
        field_name: field,
        field_schema: "keyword",
      });
    } catch (err) {
      // "Already exists" is the expected case when two workers create the
      // collection concurrently, and Qdrant reports it with a 400 rather than
      // a distinct code, so the message is the only signal. Anything else is
      // logged rather than swallowed: a payload index that never got created
      // leaves every filter on that field doing a full scan for the lifetime
      // of the collection, with no symptom other than slow searches.
      if (!isAlreadyExists(err)) {
        console.warn(
          `[qdrant] payload index "${field}" on ${name} was not created: ${(err as Error).message}`,
        );
      }
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
    // Deleting a project whose collection was never created is a success, not
    // a failure. Matched on the HTTP status rather than on the message text:
    // a substring match on a human-readable string is a guess, and it fails
    // open — an unrelated error whose message happened not to contain "404"
    // was rethrown, while any error that did contain it was swallowed.
    if (isNotFound(err)) return;
    throw err;
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
  // These two were accepted by the signature and then dropped on the floor, so
  // `languages` narrowed lexical results but silently did nothing in semantic
  // and hybrid mode — the same query returned unfiltered rows. They need
  // payload indexes, which ensureCollection now creates.
  if (filters?.languages?.length) {
    must.push({ key: "language", match: { any: filters.languages } });
  }
  if (filters?.symbols?.length) {
    must.push({ key: "symbol", match: { any: filters.symbols } });
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
  // `!== undefined` rather than truthiness: version 0 would otherwise silently
  // count every version instead of none.
  const filter: Schemas["Filter"] | undefined =
    embeddingVersion !== undefined
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