import { z } from "zod";
import { route, json, jsonBody } from "@/lib/http";
import { requirePrincipal } from "@/lib/api/guard";
import { createProject, deleteProject, listProjects, projectToDto, updateProject } from "@/lib/projects/service";
import { forbidden } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const credentialsSchema = z
  .object({
    token: z.string().min(1),
    username: z.string().optional(),
  })
  .nullable()
  .optional();

const embeddingSchema = z
  .object({
    provider: z.string().min(1).optional(),
    apiUrl: z.string().url().optional().or(z.literal("").optional()),
    apiKey: z.string().optional(),
    model: z.string().min(1).optional(),
    dimensions: z.number().int().positive().max(8192).optional(),
    batchSize: z.number().int().min(1).max(512).optional(),
  })
  .optional();

const createProjectSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
  repoUrl: z.string().min(1).max(2048),
  provider: z.enum(["github", "gitlab", "bitbucket", "generic"]).optional(),
  defaultBranch: z.string().min(1).max(200).optional(),
  credentials: credentialsSchema,
  embedding: embeddingSchema,
});

const updateProjectSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional().nullable(),
    defaultBranch: z.string().min(1).max(200).optional(),
    repoUrl: z.string().min(1).max(2048).optional(),
    credentials: credentialsSchema,
    embedding: embeddingSchema,
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

/**
 * The project a principal is confined to, or null when it may see everything.
 *
 * A session user and an unscoped (owner-level) API key are both unrestricted —
 * that is the same rule `canAccessProject` applies, so a project-scoped key is
 * confined everywhere else in this API and confined *only* here no longer.
 */
function scopeOf(principal: { type: string; projectId?: string | null }): string | null {
  return principal.type === "api_key" ? (principal.projectId ?? null) : null;
}

/** GET /api/v1/projects — list projects */
export async function GET(request: Request) {
  return route(async (req) => {
    const principal = await requirePrincipal(req);
    const { searchParams } = new URL(req.url);
    const includeStats = searchParams.get("includeStats") === "true";
    const projects = await listProjects(includeStats);
    // The principal used to be discarded here, so a project-scoped API key
    // received every project in the instance — the one listing in this API that
    // ignored the scoping every other route enforces. Narrowed after the fact
    // rather than in the query because the stats aggregation lives inside
    // listProjects; nothing outside this filter can see the wider list.
    const scope = scopeOf(principal);
    return json({ projects: scope === null ? projects : projects.filter((p) => p.id === scope) });
  })(request, {});
}

/** POST /api/v1/projects — create a project + repository configuration */
export async function POST(request: Request) {
  return route(async (req) => {
    const principal = await requirePrincipal(req);
    // A project-scoped key exists to read and search one repository. Creating
    // one produced a project that key can neither see in GET nor reach through
    // any other route — an object the caller had just paid to index and could
    // not get back. Owner-level keys and sessions are unaffected.
    if (scopeOf(principal) !== null) {
      throw forbidden(
        "project_create_forbidden",
        "A project-scoped API key cannot create projects; use a session or an unscoped API key",
      );
    }
    const body = createProjectSchema.parse(await jsonBody(req));
    const project = await createProject(body);
    return json({ project: projectToDto(project) }, 201);
  })(request, {});
}