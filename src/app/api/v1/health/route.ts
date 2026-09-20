import { route, json } from "@/lib/http";
import { requirePrincipal } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";
import { qdrantHealth } from "@/lib/qdrant";
import { queueDepth } from "@/lib/jobs/queue";
import { env } from "@/lib/env";
import { resolveEmbeddingConfig } from "@/lib/embedding/provider";

export const runtime = "nodejs";

/**
 * GET /api/v1/health — system health page data.
 * PostgreSQL / Qdrant / Job Queue / Embedding API / Repository Sync / Workers.
 */
export async function GET(request: Request) {
  return route(async (req) => {
    await requirePrincipal(req);
    const started = Date.now();

    // PostgreSQL
    let postgres: { healthy: boolean; error?: string } = { healthy: false };
    try {
      await prisma().$queryRaw`SELECT 1`;
      postgres = { healthy: true };
    } catch (err) {
      postgres = { healthy: false, error: (err as Error).message };
    }

    const qdrant = await qdrantHealth();

    // Job queue (Redis)
    let queue: { healthy: boolean; depth: number; error?: string } = { healthy: false, depth: -1 };
    try {
      const depth = await queueDepth();
      queue = { healthy: depth >= 0, depth };
      if (queue.healthy) {
        const { recordMetric } = await import("@/lib/metrics");
        await recordMetric("queue_depth", depth);
      }
    } catch (err) {
      queue = { healthy: false, depth: -1, error: (err as Error).message };
    }

    // Embedding API — config presence + live probe when configured.
    let embedding: { healthy: boolean; configured: boolean; httpStatus?: number; error?: string } = {
      healthy: false,
      configured: false,
    };
    const cfg = env();
    const config = await resolveEmbeddingConfig("__probe__").catch(() => null);
    const effective = config ?? {
      apiUrl: cfg.EMBEDDING_API_URL,
      apiKey: cfg.EMBEDDING_API_KEY,
      model: cfg.EMBEDDING_MODEL,
    };
    embedding = { healthy: false, configured: !!effective.apiUrl && !!effective.model };
    if (embedding.configured) {
      try {
        const response = await fetch(
          `${effective.apiUrl.replace(/\/+$/, "")}/embeddings`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(effective.apiKey ? { authorization: `Bearer ${effective.apiKey}` } : {}),
            },
            body: JSON.stringify({ model: effective.model, input: ["probe"] }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        embedding = { healthy: response.ok, configured: true, httpStatus: response.status };
      } catch (err) {
        embedding = { healthy: false, configured: true, error: (err as Error).message };
      }
    }

    // Repository sync: workspace health + per-repo sync status.
    const repos = await prisma().repository.findMany({
      select: { id: true, syncStatus: true, lastSuccessfulSync: true, syncError: true, projectId: true },
    });
    const syncFailures = repos.filter((r) => r.syncStatus === "error").length;
    const repositorySync = {
      healthy: syncFailures === 0,
      repositories: repos.length,
      failures: syncFailures,
    };

    // Workers: heartbeat via recent job activity.
    const activeJobs = await prisma().job.count({
      where: { status: { in: ["queued", "running"] } },
    });
    const recentCompleted = await prisma().job.count({
      where: { status: "completed", completedAt: { gte: new Date(Date.now() - 15 * 60_000) } },
    });

    return json({
      status: postgres.healthy && qdrant.healthy && queue.healthy ? "healthy" : "degraded",
      checks: {
        postgres,
        qdrant,
        queue,
        embedding,
        repositorySync,
        workers: { activeJobs, recentCompleted, configuredConcurrency: cfg.WORKER_CONCURRENCY },
      },
      version: "1.0.0",
      tookMs: Date.now() - started,
    });
  })(request, {});
}