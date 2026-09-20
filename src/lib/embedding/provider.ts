import { env } from "@/lib/env";
import { recordMetric } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";

/**
 * Embedding generation via configurable external, OpenAI-compatible APIs.
 * Providers are treated as configurable external processors — configuration
 * is explicit per project, and request payloads are never logged.
 */

export interface EmbeddingConfig {
  provider: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  batchSize: number;
  version: number;
}

/**
 * Resolves the effective embedding configuration for a project.
 * Project-level settings override system defaults; an empty project config
 * falls back to the environment (validated at startup).
 */
export async function resolveEmbeddingConfig(projectId: string): Promise<EmbeddingConfig> {
  const project = await prisma().project.findUnique({
    where: { id: projectId },
    select: {
      embeddingProvider: true,
      embeddingApiUrl: true,
      embeddingApiKeyEnc: true,
      embeddingModel: true,
      embeddingDimensions: true,
      embeddingBatchSize: true,
      embeddingVersion: true,
    },
  });
  const cfg = env();
  return {
    provider: project?.embeddingProvider || cfg.EMBEDDING_PROVIDER,
    apiUrl: project?.embeddingApiUrl || cfg.EMBEDDING_API_URL,
    apiKey: project?.embeddingApiKeyEnc || cfg.EMBEDDING_API_KEY,
    model: project?.embeddingModel || cfg.EMBEDDING_MODEL,
    dimensions: project?.embeddingDimensions || cfg.EMBEDDING_DIMENSIONS,
    batchSize: project?.embeddingBatchSize || cfg.EMBEDDING_BATCH_SIZE,
    version: project?.embeddingVersion || cfg.EMBEDDING_VERSION,
  };
}

export function assertEmbeddingConfigUsable(config: EmbeddingConfig): void {
  if (!config.apiUrl || !config.model) {
    throw new Error(
      "Embedding provider is not configured: set EMBEDDING_API_URL/EMBEDDING_MODEL in the environment or per project",
    );
  }
}

/** Embedding request/response DTO, never logged. */
interface EmbeddingResponse {
  data: { embedding: number[] }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Embeds texts in batches. One network request per batch, never per chunk.
 * Retries transient failures (429/5xx) with exponential backoff.
 */
export async function embedTexts(
  config: EmbeddingConfig,
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
  assertEmbeddingConfigUsable(config);
  const cfg = env();
  const results: number[][] = new Array(texts.length);
  for (let i = 0; i < texts.length; i += config.batchSize) {
    const batch = texts.slice(i, i + config.batchSize);
    const vectors = await embedBatchWithRetry(config, batch, cfg.EMBEDDING_MAX_RETRIES);
    results.splice(i, batch.length, ...vectors);
    if (onProgress) onProgress(Math.min(i + batch.length, texts.length), texts.length);
  }
  return results;
}

async function embedBatchWithRetry(
  config: EmbeddingConfig,
  batch: string[],
  retriesLeft: number,
): Promise<number[][]> {
  const started = Date.now();
  try {
    const response = await fetch(`${config.apiUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.model, input: batch }),
      signal: AbortSignal.timeout(env().EMBEDDING_TIMEOUT_MS),
    });
    if (response.status === 429 || response.status >= 500) {
      throw new EmbeddingTransientError(`Embedding API returned HTTP ${response.status}`);
    }
    if (!response.ok) {
      // Never log the request body; a sanitized status is enough.
      throw new Error(`Embedding API returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as EmbeddingResponse;
    const vectors = payload.data.map((d) => d.embedding);
    if (vectors.length !== batch.length) {
      throw new Error(
        `Embedding API returned ${vectors.length} vectors for a batch of ${batch.length}`,
      );
    }
    for (const v of vectors) {
      if (v.length !== config.dimensions) {
        throw new Error(
          `Embedding dimension mismatch: expected ${config.dimensions}, got ${v.length}`,
        );
      }
    }
    await recordMetric("embedding_latency_ms", Date.now() - started);
    return vectors;
  } catch (err) {
    if (err instanceof EmbeddingTransientError && retriesLeft > 0) {
      const attempts = env().EMBEDDING_MAX_RETRIES;
      const backoff = Math.min(30_000, 1000 * 2 ** (attempts - retriesLeft));
      await sleep(backoff);
      return embedBatchWithRetry(config, batch, retriesLeft - 1);
    }
    await recordMetric("embedding_failures", 1);
    throw err;
  }
}

class EmbeddingTransientError extends Error {}

export { EmbeddingTransientError };