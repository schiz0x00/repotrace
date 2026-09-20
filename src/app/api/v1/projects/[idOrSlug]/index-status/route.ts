import { route, json, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";
import { countVectors } from "@/lib/qdrant";

export const runtime = "nodejs";

/** GET /api/v1/projects/:idOrSlug/index-status */
export async function GET(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const db = prisma();
    const [files, symbols, chunks, vectors, failedFiles, activeJob, lastJob] = await Promise.all([
      db.file.count({ where: { projectId: project.id, status: "indexed" } }),
      db.symbol.count({ where: { projectId: project.id } }),
      db.chunk.count({ where: { projectId: project.id } }),
      countVectors(project.id).catch(() => -1),
      db.file.count({ where: { projectId: project.id, status: "failed" } }),
      db.job.findFirst({
        where: { projectId: project.id, status: { in: ["queued", "running"] } },
        orderBy: { createdAt: "desc" },
      }),
      db.job.findFirst({ where: { projectId: project.id }, orderBy: { createdAt: "desc" } }),
    ]);
    return json({
      indexStatus: {
        files,
        symbols,
        chunks,
        vectors,
        failedFiles,
        embeddingModel: project.embeddingModel,
        embeddingDimensions: project.embeddingDimensions,
        embeddingVersion: project.embeddingVersion,
        status: project.status,
        lastIndexedCommit: project.repository?.lastKnownCommit,
        lastSuccessfulSync: project.repository?.lastSuccessfulSync,
        activeJob,
        lastJob,
      },
    });
  })(request, {});
}