import { route, json, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/** GET /api/v1/projects/:idOrSlug/stats */
export async function GET(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const db = prisma();
    const [files, symbols, chunks, commits, failedFiles, activeJobs, failedJobs, languages] =
      await Promise.all([
        db.file.count({ where: { projectId: project.id, status: "indexed" } }),
        db.symbol.count({ where: { projectId: project.id } }),
        db.chunk.count({ where: { projectId: project.id } }),
        db.commit.count({ where: { repository: { projectId: project.id } } }),
        db.file.findMany({
          where: { projectId: project.id, status: "failed" },
          select: { path: true, error: true },
          take: 50,
        }),
        db.job.count({ where: { projectId: project.id, status: { in: ["queued", "running"] } } }),
        db.job.count({ where: { projectId: project.id, status: "failed" } }),
        db.file.groupBy({ by: ["language"], where: { projectId: project.id }, _count: true }),
      ]);
    const repository = project.repository;
    return json({
      stats: {
        files,
        symbols,
        chunks,
        commits,
        failedFiles,
        activeJobs,
        failedJobs,
        languages: languages.map((l) => ({ language: l.language, count: l._count })),
        lastKnownCommit: repository?.lastKnownCommit,
        lastSuccessfulSync: repository?.lastSuccessfulSync,
      },
    });
  })(request, {});
}