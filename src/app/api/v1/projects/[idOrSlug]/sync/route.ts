import { route, json, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { enqueueJob } from "@/lib/jobs/queue";

export const runtime = "nodejs";

/** POST /api/v1/projects/:idOrSlug/sync — refresh the repository workspace */
export async function POST(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const jobId = await enqueueJob(project.id, "repository_sync", { dedupe: true });
    return json({ jobId }, 202);
  })(request, {});
}