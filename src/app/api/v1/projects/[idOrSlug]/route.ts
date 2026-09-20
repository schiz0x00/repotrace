import { z } from "zod";
import { route, json, jsonBody, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { deleteProject, projectToDto, updateProject } from "@/lib/projects/service";
import { enqueueJob } from "@/lib/jobs/queue";

export const runtime = "nodejs";

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional().nullable(),
  defaultBranch: z.string().min(1).max(200).optional(),
  repoUrl: z.string().min(1).max(2048).optional(),
  credentials: z
    .object({ token: z.string().min(1), username: z.string().optional() })
    .nullable()
    .optional(),
  embedding: z
    .object({
      provider: z.string().min(1).optional(),
      apiUrl: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().min(1).optional(),
      dimensions: z.number().int().positive().max(8192).optional(),
      batchSize: z.number().int().min(1).max(512).optional(),
    })
    .optional(),
});

/** GET /api/v1/projects/:idOrSlug */
export async function GET(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    return json({ project: projectToDto(project) });
  })(request, {});
}

/** PATCH /api/v1/projects/:idOrSlug */
export async function PATCH(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const body = updateSchema.parse(await jsonBody(req));
    const updated = await updateProject(project.id, body);
    return json({ project: projectToDto(updated) });
  })(request, {});
}

/** DELETE /api/v1/projects/:idOrSlug — enqueues async project teardown */
export async function DELETE(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    await deleteProject(project.id);
    return json({ deleted: true, jobQueued: true });
  })(request, {});
}