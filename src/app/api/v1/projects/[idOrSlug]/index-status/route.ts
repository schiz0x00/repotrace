import { route, json, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";
import { collectionVectorSize, countVectors } from "@/lib/qdrant";
import { resolveEmbeddingConfig } from "@/lib/embedding/provider";

export const runtime = "nodejs";

/** GET /api/v1/projects/:idOrSlug/index-status */
export async function GET(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const db = prisma();
    const config = await resolveEmbeddingConfig(project.id).catch(() => null);
    const [files, symbols, chunks, vectors, failedFiles, activeJob, lastJob, currentVectors, collectionSize] =
      await Promise.all([
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
        config ? countVectors(project.id, config.version).catch(() => -1) : Promise.resolve(-1),
        collectionVectorSize(project.id).catch(() => null),
      ]);

    // The collection is unusable for the configured model when it was created
    // at a different dimensionality (Qdrant rejects every upsert), and the
    // project is mid-migration when chunks exist but nothing has been embedded
    // at the current version. Both need a reembed before search works again.
    const dimensionsMismatch = collectionSize !== null && config !== null && collectionSize !== config.dimensions;
    const awaitingReembed =
      dimensionsMismatch || (chunks > 0 && currentVectors === 0 && !activeJob);

    return json({
      indexStatus: {
        files,
        symbols,
        chunks,
        vectors,
        failedFiles,
        embeddingModel: config?.model ?? project.embeddingModel,
        embeddingDimensions: config?.dimensions ?? project.embeddingDimensions,
        embeddingVersion: config?.version ?? project.embeddingVersion,
        collectionDimensions: collectionSize,
        dimensionsMismatch,
        reembedRequired: awaitingReembed,
        status: project.status,
        lastIndexedCommit: project.repository?.lastKnownCommit,
        lastSuccessfulSync: project.repository?.lastSuccessfulSync,
        activeJob,
        lastJob,
      },
    });
  })(request, {});
}