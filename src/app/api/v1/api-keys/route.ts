import { z } from "zod";
import { route, json, jsonBody } from "@/lib/http";
import { requirePrincipal } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";
import { generateApiKey } from "@/lib/api-keys";

export const runtime = "nodejs";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  projectId: z.string().optional().nullable(),
});

/** GET /api/v1/api-keys — list machine credentials (metadata only) */
export async function GET(request: Request) {
  return route(async (req) => {
    await requirePrincipal(req);
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
      return json({ error: { code: "forbidden", message: "API keys cannot create other API keys" } }, 403);
    }
    const body = createSchema.parse(await jsonBody(req));
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