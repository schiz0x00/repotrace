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
 */
export async function metricSummaries(
  hours = 24,
  projectId?: string,
): Promise<Record<string, MetricSummary>> {
  const since = new Date(Date.now() - hours * 3600_000);
  const events = await prisma().metricEvent.findMany({
    where: {
      name: { in: [...METRIC_NAMES] },
      recordedAt: { gte: since },
      ...(projectId ? { projectId } : {}),
    },
    select: { name: true, value: true },
    orderBy: { recordedAt: "asc" },
  });
  const groups = new Map<string, number[]>();
  for (const e of events) {
    groups.set(e.name, [...(groups.get(e.name) ?? []), e.value]);
  }
  const out: Record<string, MetricSummary> = {};
  for (const [name, values] of groups) {
    values.sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);
    out[name] = {
      count: values.length,
      sum,
      avg: sum / values.length,
      min: values[0],
      max: values[values.length - 1],
      p95: values[Math.min(values.length - 1, Math.floor(values.length * 0.95))],
    };
  }
  return out;
}