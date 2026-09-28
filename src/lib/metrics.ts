import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

export const METRIC_NAMES = [
  "embedding_latency_ms",
  "embedding_failures",
  "qdrant_latency_ms",
  "search_latency_ms",
  "indexing_duration_ms",
  "job_failures",
  "queue_depth",
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

/** Records a numeric metric event. Cheap fire-and-forget persistence. */
export async function recordMetric(
  name: MetricName,
  value: number,
  projectId?: string,
): Promise<void> {
  try {
    await prisma().metricEvent.create({
      data: { name, value, projectId },
    });
  } catch {
    // Observability must never break the request it observes.
  }
}

export interface MetricSummary {
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
  p95: number;
}

/**
 * Aggregates metric events recorded over the last `hours` (default 24h).
 * Latency metrics are averaged; counters are summed.
 *
 * The window is capped and the read is bounded: `metric_event` grows without
 * limit otherwise, and loading it whole on every dashboard render is both slow
 * and a memory hazard on a long-running instance.
 */
export async function metricSummaries(
  hours = 24,
  projectId?: string,
): Promise<Record<string, MetricSummary>> {
  const window = Math.min(Math.max(1, hours), METRIC_MAX_WINDOW_HOURS);
  const since = new Date(Date.now() - window * 3600_000);

  // Aggregated in Postgres rather than in Node.
  //
  // This used to select up to 50,000 (name, value) rows, bucket and sort them
  // in JavaScript, and throw the array away. On a busy instance that is the
  // single heaviest thing the overview page does, it allocates tens of
  // megabytes per request, and `take: 50_000` silently under-counts a busier
  // window rather than reporting it — so the p95 and the average were computed
  // over whichever 50,000 rows happened to come back, and the answer changed
  // with load instead of with the data.
  //
  // One grouped query returns one row per metric name. The names are bound as
  // parameters, never interpolated.
  const rows = await prisma().$queryRawUnsafe<MetricAggregateRow[]>(
    `SELECT name,
            COUNT(*)::int                AS count,
            COALESCE(SUM(value), 0)      AS sum,
            AVG(value)                   AS avg,
            MIN(value)                   AS min,
            MAX(value)                   AS max,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY value) AS p95
     FROM "metric_event"
     WHERE name = ANY($1::text[])
       AND "recordedAt" >= $2::timestamptz
       ${projectId ? 'AND "projectId" = $3::text' : ""}
     GROUP BY name`,
    [...METRIC_NAMES],
    since,
    ...(projectId ? [projectId] : []),
  );

  const out: Record<string, MetricSummary> = {};
  for (const row of rows) {
    out[row.name] = {
      count: Number(row.count),
      sum: Number(row.sum),
      avg: Number(row.avg),
      min: Number(row.min),
      max: Number(row.max),
      p95: Number(row.p95),
    };
  }
  return out;
}

interface MetricAggregateRow {
  name: string;
  count: number | bigint;
  sum: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  p95: number | null;
}

/** Upper bound on the aggregation window, in hours. */
export const METRIC_MAX_WINDOW_HOURS = 24 * 7;

/**
 * Deletes metric events past the retention window. Called periodically by the
 * worker so the table does not grow without bound.
 */
export async function pruneMetrics(): Promise<number> {
  const days = env().METRIC_RETENTION_DAYS;
  if (days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 24 * 3600_000);
  const result = await prisma().metricEvent.deleteMany({
    where: { recordedAt: { lt: cutoff } },
  });
  return result.count;
}