import { z } from "zod";
import { route, json } from "@/lib/http";
import { requirePrincipal } from "@/lib/api/guard";
import { metricSummaries, METRIC_MAX_WINDOW_HOURS } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/** GET /api/v1/metrics?hours=24 — aggregated observability metrics */
export async function GET(request: Request) {
  return route(async (req) => {
    const principal = await requirePrincipal(req);
    // `Number(...) || 24` accepted a negative window and an absurd one
    // (`hours=1e9`), and reported back a window the metrics were not computed
    // over. The cap is the aggregator's own, so `windowHours` stays truthful.
    const { hours } = z
      .object({ hours: z.coerce.number().int().min(1).max(METRIC_MAX_WINDOW_HOURS).default(24) })
      .parse({ hours: new URL(req.url).searchParams.get("hours") ?? undefined });

    // A project-scoped API key must not read global job counts. The README
    // promises "a key scoped to a project can only access that project", and
    // this endpoint returned every project's job statuses and metrics to one.
    const projectScope = principal.type === "api_key" ? principal.projectId : null;
    const since = new Date(Date.now() - hours * 3600_000);

    const [summaries, jobStatusCounts] = await Promise.all([
      metricSummaries(hours, projectScope ?? undefined),
      prisma().job.groupBy({
        by: ["status"],
        where: {
          createdAt: { gte: since },
          ...(projectScope ? { projectId: projectScope } : {}),
        },
        _count: true,
      }),
    ]);
    return json({
      metrics: summaries,
      jobs: Object.fromEntries(jobStatusCounts.map((j) => [j.status, j._count])),
      windowHours: hours,
    });
  })(request, {});
}