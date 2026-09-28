import { z } from "zod";
import { route, json, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";
import { commitCursorWhere, finalizeCommitPage, parseCommitCursor } from "@/lib/commits/cursor";
import type { ProjectStatus } from "@/generated/prisma/enums";

export const runtime = "nodejs";

/**
 * GET /api/v1/projects/:idOrSlug/commits?limit=&before=
 *
 * Commit history for the indexed repository. The `commit` table is populated
 * on every sync, but nothing read it back: there was no way to ask what changed
 * in a project, or when a symbol's file last moved.
 *
 * Keyset-paginated rather than offset, so paging stays stable while a sync
 * appends new commits at the head. `before` is the opaque cursor from a previous
 * response's `nextBefore` — an ISO-8601 timestamp and a sha joined by `|`, so
 * the boundary is total and no commit is skipped or repeated even when many
 * share a timestamp.
 */
export async function GET(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const { searchParams } = new URL(req.url);

    const schema = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      // Shape only; `parseCommitCursor` decides whether the cursor is one this
      // API issued, so a bad cursor is a 400 with a usable message rather than
      // zod's generic datetime complaint.
      before: z.string().min(1).optional(),
    });
    const parsed = schema.parse({
      limit: searchParams.get("limit") ?? undefined,
      before: searchParams.get("before") ?? undefined,
    });

    const db = prisma();
    // Commits hang off the repository, not the project, so resolve it first.
    const repository = await db.repository.findUnique({
      where: { projectId: project.id },
      select: { id: true, branch: true, lastKnownCommit: true, syncStatus: true, lastSuccessfulSync: true },
    });
    if (!repository) {
      return json({ commits: [], nextBefore: null, repository: null });
    }

    const cursor = parsed.before ? parseCommitCursor(parsed.before) : null;

    const rows = await db.commit.findMany({
      where: {
        // repositoryId comes from the caller's resolved project, and the cursor
        // clause is ANDed with it — the OR below narrows the page, it cannot
        // widen it past the tenant boundary.
        repositoryId: repository.id,
        ...(cursor ? commitCursorWhere(cursor) : {}),
      },
      orderBy: [{ authoredAt: "desc" }, { sha: "desc" }],
      take: parsed.limit + 1,
      select: { sha: true, message: true, author: true, authoredAt: true },
    });

    const { commits, nextBefore } = finalizeCommitPage(rows, parsed.limit);

    return json({
      commits: commits.map((c) => ({
        sha: c.sha,
        shortSha: c.sha.slice(0, 8),
        subject: c.message.split("\n", 1)[0],
        author: c.author,
        authoredAt: c.authoredAt,
      })),
      nextBefore,
      repository: {
        branch: repository.branch,
        lastKnownCommit: repository.lastKnownCommit,
        syncStatus: repository.syncStatus satisfies ProjectStatus,
        lastSuccessfulSync: repository.lastSuccessfulSync,
      },
    });
  })(request, {});
}
