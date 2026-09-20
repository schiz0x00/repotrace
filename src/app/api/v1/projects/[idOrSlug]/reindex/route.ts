import { z } from "zod";
import { route, json, jsonBody, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { enqueueJob } from "@/lib/jobs/queue";
import type { JobType } from "@/generated/prisma/enums";

export const runtime = "nodejs";

/** POST /api/v1/projects/:idOrSlug/reindex — enqueue an indexing job */
export async function POST(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const body = await jsonBody(req).catch(() => ({}));
    const schema = z
      .object({ type: z.enum(["initial", "incremental", "full", "reembed"]).default("full") })
      .passthrough();
    const { type } = schema.parse(body);
    const jobType: JobType =
      type === "incremental"
        ? "incremental_index"
        : type === "reembed"
          ? "reembed"
          : type === "initial"
            ? "initial_index"
            : "full_reindex";
    const jobId = await enqueueJob(project.id, jobType, { dedupe: true });
    return json({ jobId, type: jobType }, 202);
  })(request, {});
}