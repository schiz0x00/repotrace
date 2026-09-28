import { route, json, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/** Failed files listed in the detail array; `failedFiles` itself is the count. */
const FAILED_FILE_DETAIL_LIMIT = 50;

/**
 * GET /api/v1/projects/:idOrSlug/stats
 *
 * `stats.failedFiles` is a count. It was the array of up to 50 `{path, error}`
 * rows that this query read instead, so the dashboard's `ProjectStats` — which
 * types it as a number and renders "N files failed to index" behind a `> 0`
 * test — compared an array to zero, which is always false: the alert could
 * never fire no matter how many files had failed. The count and the detail are
 * now separate fields; the detail is the same per-file view `/files?status=failed`
 * already gives a project-scoped caller, capped for the same reason.
 */
export async function GET(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const db = prisma();
    const [files, symbols, chunks, commits, failedFiles, failedFileDetail, activeJobs, failedJobs, languages] =
      await Promise.all([
        db.file.count({ where: { projectId: project.id, status: "indexed" } }),
        db.symbol.count({ where: { projectId: project.id } }),
        db.chunk.count({ where: { projectId: project.id } }),
        db.commit.count({ where: { repository: { projectId: project.id } } }),
        db.file.count({ where: { projectId: project.id, status: "failed" } }),
        db.file.findMany({
          where: { projectId: project.id, status: "failed" },
          select: { path: true, error: true },
          // Most recently touched first: when a run fails the same way for
          // every file, the ones it just touched are the ones being looked at.
          orderBy: { updatedAt: "desc" },
          take: FAILED_FILE_DETAIL_LIMIT,
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
        /** At most FAILED_FILE_DETAIL_LIMIT entries; `failedFiles` is the total. */
        failedFileDetail,
        activeJobs,
        failedJobs,
        languages: languages.map((l) => ({ language: l.language, count: l._count })),
        lastKnownCommit: repository?.lastKnownCommit,
        lastSuccessfulSync: repository?.lastSuccessfulSync,
      },
    });
  })(request, {});
}