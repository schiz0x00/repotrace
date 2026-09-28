import { z } from "zod";
import { route, json, jsonBody } from "@/lib/http";
import { requirePrincipal } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";
import { generateApiKey } from "@/lib/api-keys";
import { notFound, forbidden } from "@/lib/errors";

export const runtime = "nodejs";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  projectId: z.string().optional().nullable(),
});

/** GET /api/v1/api-keys — list machine credentials (metadata only) */
export async function GET(request: Request) {
  return route(async (req) => {
    const principal = await requirePrincipal(req);
    // Same rule as POST and DELETE below, for the same reason. An API key is a
    // credential a machine holds; letting one enumerate the instance's keys
    // handed it every key's prefix, its project binding and its last-used time
    // — the reconnaissance step before an offline guess at a sibling key — and
    // the two sibling handlers already refused exactly this caller.
    if (principal.type === "api_key") {
      throw forbidden("forbidden", "API keys cannot list other API keys");
    }
    const keys = await prisma().apiKey.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        projectId: true,
        project: { select: { slug: true, name: true } },
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });
    return json({ apiKeys: keys });
  })(request, {});
}

/**
 * POST /api/v1/api-keys — create a machine credential (MCP/API access).
 * The plaintext key is returned exactly once; only its hash is stored.
 */
export async function POST(request: Request) {
  return route(async (req) => {
    const principal = await requirePrincipal(req);
    if (principal.type === "api_key") {
      throw forbidden("forbidden", "API keys cannot create other API keys");
    }
    const body = createSchema.parse(await jsonBody(req));
    // The projectId went straight into the insert, so a typo surfaced as a
    // 500 foreign-key violation from the driver rather than a 404 saying the
    // project does not exist.
    if (body.projectId) {
      const project = await prisma().project.findUnique({
        where: { id: body.projectId },
        select: { id: true },
      });
      if (!project) throw notFound("project_not_found", `Project ${body.projectId} not found`);
    }
    const { plaintext, prefix, hash } = generateApiKey();
    await prisma().apiKey.create({
      data: {
        name: body.name,
        keyPrefix: prefix,
        keyHash: hash,
        projectId: body.projectId ?? null,
      },
    });
    return json({ apiKey: { name: body.name, key: plaintext, prefix } }, 201);
  })(request, {});
}