import { route, json } from "@/lib/http";
import { requirePrincipal } from "@/lib/api/guard";
import { metricSummaries } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/** GET /api/v1/metrics?hours=24 — aggregated observability metrics */
export async function GET(request: Request) {
  return route(async (req) => {
    await requirePrincipal(req);
    const hours = Number(new URL(req.url).searchParams.get("hours") ?? "24") || 24;
    const summaries = await metricSummaries(hours);
    const jobStatusCounts = await prisma().job.groupBy({
      by: ["status"],
      where: { createdAt: { gte: new Date(Date.now() - hours * 3600_000) } },
      _count: true,
    });
    return json({
      metrics: summaries,
      jobs: Object.fromEntries(jobStatusCounts.map((j) => [j.status, j._count])),
      windowHours: hours,
    });
  })(request, {});
}