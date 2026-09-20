import { z } from "zod";
import { route, json, jsonBody } from "@/lib/http";
import { requirePrincipal } from "@/lib/api/guard";
import { createProject, deleteProject, listProjects, projectToDto, updateProject } from "@/lib/projects/service";
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

/** GET /api/v1/projects — list projects */
export async function GET(request: Request) {
  return route(async (req) => {
    await requirePrincipal(req);
    const { searchParams } = new URL(req.url);
    const includeStats = searchParams.get("includeStats") === "true";
    const projects = await listProjects(includeStats);
    return json({ projects });
  })(request, {});
}

/** POST /api/v1/projects — create a project + repository configuration */
export async function POST(request: Request) {
  return route(async (req) => {
    await requirePrincipal(req);
    const body = createProjectSchema.parse(await jsonBody(req));
    const project = await createProject(body);
    return json({ project: projectToDto(project) }, 201);
  })(request, {});
}