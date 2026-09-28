import { route, json } from "@/lib/http";
import { requirePrincipal } from "@/lib/api/guard";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { qdrantHealth } from "@/lib/qdrant";
import { queueDepth } from "@/lib/jobs/queue";
import { env } from "@/lib/env";
import { resolveEmbeddingConfig } from "@/lib/embedding/provider";

export const runtime = "nodejs";

/**
 * Ceiling on a single dependency probe.
 *
 * A dependency that is *down* normally rejects and is reported unhealthy. A
 * dependency that is *wedged* — a black-holed host, a pool blocked on a full
 * connection queue — never settles at all, and a diagnostic that hangs is no
 * better than one that 500s. The cost of the bound is that a dependency which
 * is merely slow (over this many milliseconds) is reported unhealthy for one
 * reading; that is the conservative direction for a health view.
 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * `cause` is the original thrown value, kept so a caller that can tell one
 * failure mode from another can. The authentication probe needs it: an AppError
 * from `requirePrincipal` means the caller presented a bad credential and must
 * be answered 401, while anything else means the database did not answer in
 * time and the 503 is the honest response.
 */
type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; cause: unknown };

/**
 * Runs one probe and converts both failure modes into a value.
 *
 * Every check in this route goes through here. The route exists to describe a
 * broken system, so a probe that throws or stalls must degrade that one check
 * rather than escape: an unhandled rejection here reached `route()`, which
 * turned the whole diagnostic into a 500 with a generic body — the one response
 * that tells an operator nothing about which dependency broke. The detail is
 * logged here, and the checks below return it as their `error` — legitimately,
 * since this endpoint is authenticated and documented to report dependency error
 * detail, unlike the public `/api/v1/health` liveness probe. The one exception
 * is `embedding.config`, whose failure is absorbed by the environment fallback
 * and so is logged only.
 */
async function probe<T>(name: string, run: () => Promise<T>): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    return { ok: true, value };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[health:status] ${name} check failed: ${error}`);
    return { ok: false, error, cause: err };
  } finally {
    // Cleared even on success: a pending 10s timer per check would keep the
    // request alive long after the response was written.
    if (timer) clearTimeout(timer);
  }
}

/**
 * GET /api/v1/health/status — full diagnostic view.
 *
 * Authenticated: it reports infrastructure topology, per-repository sync state
 * and dependency error detail, none of which belongs on a public endpoint. It
 * also performs a live embedding-API probe, so it must not be on a polling path.
 *
 * Once the caller is authenticated this always answers 200 with a complete
 * body, even when every dependency is down: `checks.*.healthy` is the signal,
 * not the HTTP status. Before that, two different failures are kept apart — a
 * bad credential is answered 401 by the normal error path, and only a genuine
 * failure to authenticate IN TIME (which almost always means the database is
 * wedged) gets the 503 below.
 *
 * Bounded at roughly 3 * PROBE_TIMEOUT_MS (~30s) in the worst case, not one.
 * Three sequential stages each pay the ceiling: authenticating the caller, the
 * concurrent batch of independent probes, and the live embedding call that
 * depends on the batch having resolved. Every stage that touches the database
 * is inside a ceiling, including the first — authentication is a Prisma query
 * like any other, and leaving it unbounded meant a Postgres that accepted
 * connections and then stopped answering hung this endpoint forever, which is
 * the precise failure it exists to diagnose, and which stopped the dashboard
 * Health page from rendering at all.
 */
export async function GET(request: Request) {
  return route(async (req) => {
    // Authentication is a database query, so it gets the same ceiling as
    // everything else here. Unbounded, a wedged Postgres hung this endpoint —
    // and the dashboard Health page, which fetches it with the session cookie,
    // so an operator could not reach the diagnostic that would have told them
    // the database was wedged.
    const auth = await probe("auth", () => requirePrincipal(req));
    if (!auth.ok) {
      // `probe` catches everything, which includes the 401 that
      // requirePrincipal throws for a missing or invalid credential. Reporting
      // that as "the database is wedged" would both be false and hide a real
      // auth failure behind a 503, so an AppError is rethrown and answered by
      // the normal error path; only a genuine timeout or transport failure
      // becomes the infrastructure answer below.
      // Re-thrown rather than reported: a rejected credential is the caller's
      // problem and the normal error path already renders it correctly.
      if (auth.cause instanceof AppError) throw auth.cause;
      return json(
        {
          status: "degraded",
          error: {
            code: "diagnostic_unavailable",
            message:
              "Could not authenticate the request in time. The database is very likely unreachable or wedged, which is what this endpoint reports on.",
          },
        },
        503,
      );
    }

    const started = Date.now();

    // Every independent probe runs concurrently. Awaiting them one at a time
    // would make a wedged dependency cost PROBE_TIMEOUT_MS *per check* — a
    // diagnostic that takes a minute to say "the database is down" is the same
    // failure as one that never answers. It also removes the sum of the healthy
    // latencies from the response time. The whole batch is therefore bounded by
    // a single PROBE_TIMEOUT_MS, not by their sum.
    const [
      dbResult,
      qdrantResult,
      queueResult,
      envResult,
      reposResult,
      activeResult,
      recentResult,
      embeddingCfgResult,
    ] = await Promise.all([
        // Prisma's client is built from env() on first use, so even obtaining
        // the handle can throw when configuration is broken.
        probe("postgres", async () => {
          await prisma().$queryRaw`SELECT 1`;
        }),
        // qdrantHealth() already swallows its own errors; it is wrapped anyway
        // so a throw from a future edit, or a stalled connection, lands in the
        // same place as every other failure.
        probe("qdrant", () => qdrantHealth()),
        // Job queue (Redis). queueDepth() answers -1 rather than throwing when
        // the queue is unreachable, so -1 is turned into a reason below instead
        // of reaching the caller as a bare "0 jobs".
        probe("queue", async () => {
          const depth = await queueDepth();
          if (depth >= 0) {
            // Fired and forgotten, deliberately NOT awaited inside the probe.
            // recordMetric swallows a failing write, so awaiting it looked
            // safe — but a *hanging* write is not a failure it can swallow,
            // and the queue check would then report Redis as unhealthy with a
            // probe-timeout error while Redis was perfectly fine. The exact
            // scenario this endpoint exists to diagnose: a wedged Postgres.
            // The cost is a metric that may be missed on a bad night, which is
            // the right trade for not blaming the wrong dependency.
            void import("@/lib/metrics")
              .then(({ recordMetric }) => recordMetric("queue_depth", depth))
              .catch(() => {});
          }
          return depth;
        }),
        // Env is read inside a probe because a bad configuration is exactly the
        // kind of fault this endpoint is asked to explain, not a reason to 500.
        probe("env", async () => env()),
        // Repository sync: workspace health + per-repo sync state. Unknown
        // counts are reported as an error rather than as zero repositories, so
        // a down database cannot be misread as a healthy index with nothing in
        // it. Only syncStatus is read; the rest of the row was never used.
        probe("repositorySync", async () => {
          const repos = await prisma().repository.findMany({ select: { syncStatus: true } });
          return {
            repositories: repos.length,
            failures: repos.filter((r) => r.syncStatus === "error").length,
          };
        }),
        // Workers: heartbeat via recent job activity. -1 is this file's existing
        // "not measured" sentinel (see queue.depth) and is never a real count.
        probe("workers.activeJobs", async () =>
          prisma().job.count({ where: { status: { in: ["queued", "running"] } } }),
        ),
        probe("workers.recentCompleted", async () =>
          prisma().job.count({
            where: { status: "completed", completedAt: { gte: new Date(Date.now() - 15 * 60_000) } },
          }),
        ),
        // Per-project embedding settings, read the same way the indexing pipeline
        // reads them. This is a live `project.findUnique` and therefore belongs
        // inside the batch with the other database probes: run bare, an await on
        // it is unbounded, and a Postgres that accepts connections but never
        // answers would hang this endpoint indefinitely — on the one route whose
        // entire job is to answer while something is broken. The id is a
        // sentinel that matches no project, so in practice this resolves to the
        // environment defaults; it is still a query, and still needs the bound.
        // A failure is not fatal: the environment fallback below covers it.
        probe("embedding.config", () => resolveEmbeddingConfig("__probe__")),
      ]);

    const postgres: { healthy: boolean; error?: string } = dbResult.ok
      ? { healthy: true }
      : { healthy: false, error: dbResult.error };

    const qdrant = qdrantResult.ok
      ? qdrantResult.value
      : { healthy: false, error: qdrantResult.error };

    const queue: { healthy: boolean; depth: number; error?: string } = queueResult.ok
      ? queueResult.value >= 0
        ? { healthy: true, depth: queueResult.value }
        : { healthy: false, depth: -1, error: "queue depth unavailable" }
      : { healthy: false, depth: -1, error: queueResult.error };

    const repositorySync = reposResult.ok
      ? {
          healthy: reposResult.value.failures === 0,
          repositories: reposResult.value.repositories,
          failures: reposResult.value.failures,
        }
      : { healthy: false, repositories: 0, failures: 0, error: reposResult.error };

    const workers: {
      activeJobs: number;
      recentCompleted: number;
      configuredConcurrency?: number;
      error?: string;
    } = {
      activeJobs: activeResult.ok ? activeResult.value : -1,
      recentCompleted: recentResult.ok ? recentResult.value : -1,
      ...(envResult.ok ? { configuredConcurrency: envResult.value.WORKER_CONCURRENCY } : {}),
      ...(activeResult.ok
        ? recentResult.ok
          ? {}
          : { error: recentResult.error }
        : { error: activeResult.error }),
    };

    // Embedding API — config presence + live probe when configured. The config
    // lookup already ran in the batch above; this section only decides what to
    // report and, when configured, makes the one call that cannot be folded
    // into that batch because it depends on the result.
    let embedding: { healthy: boolean; configured: boolean; httpStatus?: number; error?: string };
    if (!envResult.ok) {
      // Without a valid environment there is no configured embedding API to
      // report on; the configuration error is the diagnosis.
      embedding = { healthy: false, configured: false, error: envResult.error };
    } else {
      const cfg = envResult.value;
      // Bounded and already resolved; a failure falls back to the environment,
      // which is also what a project with no overrides would have produced.
      const config = embeddingCfgResult.ok ? embeddingCfgResult.value : null;
      const effective = config ?? {
        apiUrl: cfg.EMBEDDING_API_URL,
        apiKey: cfg.EMBEDDING_API_KEY,
        model: cfg.EMBEDDING_MODEL,
      };
      embedding = { healthy: false, configured: !!effective.apiUrl && !!effective.model };
      if (embedding.configured) {
        // Reads `effective` only — no second database round trip, so the live
        // call adds its probe ceiling and nothing else.
        const embeddingResult = await probe("embedding", async () => {
          const response = await fetch(`${effective.apiUrl.replace(/\/+$/, "")}/embeddings`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(effective.apiKey ? { authorization: `Bearer ${effective.apiKey}` } : {}),
            },
            body: JSON.stringify({ model: effective.model, input: ["probe"] }),
            // The embedding API is a third party and the dependency most likely
            // to hang, so it carries its own abort on top of the probe bound.
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          return { httpStatus: response.status, ok: response.ok };
        });
        embedding = embeddingResult.ok
          ? {
              healthy: embeddingResult.value.ok,
              configured: true,
              httpStatus: embeddingResult.value.httpStatus,
            }
          : { healthy: false, configured: true, error: embeddingResult.error };
      }
    }

    return json({
      // Deliberately the three infrastructure dependencies only, as before: this
      // field is what uptime monitoring reads, and a repository stuck in the
      // error state does not make the service unreachable. Partial failures show
      // up in the per-check detail above.
      status: postgres.healthy && qdrant.healthy && queue.healthy ? "healthy" : "degraded",
      checks: {
        postgres,
        qdrant,
        queue,
        embedding,
        repositorySync,
        workers,
      },
      version: "1.0.0",
      tookMs: Date.now() - started,
    });
  })(request, {});
}
