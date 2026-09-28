import { route, json } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { qdrantHealth } from "@/lib/qdrant";
import { queueDepth } from "@/lib/jobs/queue";

export const runtime = "nodejs";

/**
 * Ceiling on a single dependency probe.
 *
 * A dependency that is *down* rejects, and both wrappers below swallow that.
 * A dependency that is *wedged* — a black-holed host, a pool blocked on a full
 * connection queue — never settles at all, and an unbounded await turns the one
 * route that every unauthenticated caller may reach into a request that hangs
 * for as long as the operator's healthcheck interval, or forever. The cost of
 * the bound is that a dependency which is merely slow is reported unhealthy for
 * one reading, which is the conservative direction for a liveness probe.
 *
 * All three probes run concurrently, so the response is bounded by this one
 * ceiling rather than three of them.
 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Runs one probe and reduces both failure modes — rejection and never settling —
 * to a single boolean.
 *
 * The reason is logged, never returned: this endpoint is public and the
 * existing contract is booleans only.
 */
async function probe(name: string, run: () => Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.error(`[health] ${name} check failed: ${(err as Error).message}`);
    return false;
  } finally {
    // Cleared even on success: a pending 5s timer per probe would hold the
    // request's event loop open long after the response was written.
    if (timer) clearTimeout(timer);
  }
}

/**
 * GET /api/v1/health — liveness probe.
 *
 * Deliberately public and deliberately cheap: it is what a container
 * healthcheck or load balancer polls, so it must not make outbound paid calls,
 * write metrics, or disclose infrastructure detail. The rich diagnostic view
 * lives at /api/v1/health/status and requires authentication.
 *
 * Returns 503 when a core dependency is down so orchestrators can act on it —
 * this previously always returned 200, so a failing instance looked healthy.
 * A dependency that does not answer within PROBE_TIMEOUT_MS counts as down.
 */
export async function GET(request: Request) {
  return route(async (req) => {
    const started = Date.now();

    const [postgresHealthy, qdrantHealthy, queueHealthy] = await Promise.all([
      probe("postgres", async () => {
        await prisma().$queryRaw`SELECT 1`;
        return true;
      }),
      // qdrantHealth() already turns its own errors into `{healthy: false}`;
      // wrapped anyway so a stall inside it lands in the same place, and for
      // the throw a future edit could add.
      probe("qdrant", async () => (await qdrantHealth()).healthy),
      // queueDepth() answers -1 rather than throwing when Redis is unreachable,
      // so the depth is the signal and -1 must not read as "0 jobs".
      probe("queue", async () => (await queueDepth()) >= 0),
    ]);

    const healthy = postgresHealthy && qdrantHealthy && queueHealthy;
    return json(
      {
        status: healthy ? "healthy" : "degraded",
        // Component booleans only — no hostnames, versions or error strings.
        checks: { postgres: postgresHealthy, qdrant: qdrantHealthy, queue: queueHealthy },
        tookMs: Date.now() - started,
      },
      healthy ? 200 : 503,
    );
  })(request, {});
}
