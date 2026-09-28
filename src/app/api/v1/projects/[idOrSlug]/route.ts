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
  // Every embedding override is nullable as well as optional, because `null`
  // is how the dashboard says "clear this and fall back to the system
  // default". With `.optional()` alone, `null` was rejected and the one control
  // for removing an override answered 400 for every project. `undefined` still
  // means "leave unchanged"; the two are genuinely different on the wire, and
  // the service layer already distinguishes them.
  embedding: z
    .object({
      provider: z.string().min(1).nullable().optional(),
      apiUrl: z.string().nullable().optional(),
      apiKey: z.string().nullable().optional(),
      model: z.string().min(1).nullable().optional(),
      dimensions: z.number().int().positive().max(8192).nullable().optional(),
      batchSize: z.number().int().min(1).max(512).nullable().optional(),
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