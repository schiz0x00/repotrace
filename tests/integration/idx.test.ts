import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendLine,
  cleanupProject,
  createProjectRow,
  gitCommit,
  makeTempRepoCopy,
  randomSuffix,
  requireInfra,
} from "../helpers";

const run = process.env.RUN_INTEGRATION === "1";

describe.runIf(run)("indexing pipeline", () => {
  let projectId = "";
  let repoDir = "";

  beforeAll(async () => {
    await requireInfra(["db", "qdrant", "embeddings"]);
    // The worker preloads grammars before processing jobs; replicate that here.
    const { preloadGrammars } = await import("@/lib/indexing/parser");
    await preloadGrammars();
    repoDir = await makeTempRepoCopy();
    const project = await createProjectRow(`test-${randomSuffix()}`, `file://${repoDir}`);
    projectId = project.id;
  });

  afterAll(async () => {
    if (projectId) await cleanupProject(projectId);
    if (repoDir) await rm(repoDir, { recursive: true, force: true });
  });

  /**
   * Indexes the project if nothing is indexed yet, and returns how many files
   * are indexed when it is done.
   *
   * Used by every test whose subject is not the initial index itself, so that
   * each one establishes the state it needs rather than assuming some earlier
   * test left it behind: any single test can be run on its own (`-t`). It is a
   * no-op once the project is indexed, so it costs nothing in file order.
   */
  async function ensureIndexed(id: string): Promise<number> {
    const { prisma } = await import("@/lib/prisma");
    const { runIndexJob } = await import("@/lib/indexing/pipeline");
    const count = () => prisma().file.count({ where: { projectId: id } });
    if ((await count()) === 0) await runIndexJob({ projectId: id, mode: "initial" });
    return count();
  }

  it("indexes every file with symbols, chunks and qdrant vectors", async () => {
    const { runIndexJob } = await import("@/lib/indexing/pipeline");
    const { prisma } = await import("@/lib/prisma");
    const { collectionFor, countVectors } = await import("@/lib/qdrant");
    const db = prisma();

    const result = await runIndexJob({ projectId, mode: "initial" });
    expect(result.filesProcessed).toBe(5);
    expect(result.filesFailed).toBe(0);

    const files = await db.file.findMany({ where: { projectId } });
    expect(files).toHaveLength(5);
    for (const f of files) expect(f.status).toBe("indexed");
    const paths = files.map((f) => f.path);
    expect(paths).toContain("src/orders/model.ts");
    expect(paths).toContain("docs/FLOWS.md");

    const symbols = await db.symbol.count({ where: { projectId } });
    expect(symbols).toBeGreaterThanOrEqual(10);

    const chunks = await db.chunk.count({ where: { projectId } });
    expect(chunks).toBeGreaterThan(0);

    const { qdrant } = await import("@/lib/qdrant");
    const exists = await qdrant().collectionExists(collectionFor(projectId));
    expect(exists.exists).toBe(true);
    expect(await countVectors(projectId)).toBe(chunks);

    const project = await db.project.findUnique({ where: { id: projectId } });
    expect(project!.status).toBe("synced");
    const repo = await db.repository.findUnique({ where: { projectId } });
    expect(repo!.lastKnownCommit).not.toBeNull();
  });

  it("refreshes the workspace retention marker, and pruning leaves the live workspace alone", async () => {
    const { runIndexJob } = await import("@/lib/indexing/pipeline");
    const { lastUsedMarkerAt, workspaceRoot } = await import("@/lib/git/workspace");
    // Marker name duplicated from src/lib/git/workspace.ts; that module keeps it
    // private, and the point of this test is the file on disk, not the constant.
    const marker = join(workspaceRoot(), projectId, ".repotrace-last-used");

    // The marker only exists once something has synced the workspace, so this
    // test indexes rather than relying on the test before it having done so.
    await ensureIndexed(projectId);

    // Regression: touchWorkspace used to `utimes` a path it had never created.
    // The ENOENT was swallowed by its own catch, no marker was ever written, and
    // pruning fell back to the directory mtime the marker was introduced to
    // replace — a directory whose mtime a fetch and checkout never refresh. A
    // workspace used every day therefore still looked seven days old, and
    // pruneWorkspaces (run at the end of every job) deleted it out from under
    // whichever job was indexing it.
    expect(existsSync(marker)).toBe(true);

    // Age it past the retention window, then run a job.
    const old = new Date(Date.now() - 400 * 24 * 3600_000);
    await utimes(marker, old, old);
    expect(await lastUsedMarkerAt(projectId)).toBeLessThan(Date.now() - 1000);

    const result = await runIndexJob({ projectId, mode: "incremental" });
    expect(result.filesFailed).toBe(0);

    // The job refreshed the marker, so the pruneWorkspaces() call at the end of
    // the same run had a fresh timestamp to judge this workspace by.
    expect((await lastUsedMarkerAt(projectId)) ?? 0).toBeGreaterThan(Date.now() - 60_000);
    expect(existsSync(marker)).toBe(true);
  });

  it("treats an unchanged incremental run as a no-op", async () => {
    const { runIndexJob } = await import("@/lib/indexing/pipeline");
    const indexed = await ensureIndexed(projectId);
    expect(indexed).toBeGreaterThan(0);
    const result = await runIndexJob({ projectId, mode: "incremental" });
    expect(result.filesProcessed).toBe(0);
    // Counted, not hard-coded: how many files the fixture has indexed is the
    // test's business, not an accident of which tests ran before it.
    expect(result.filesSkipped).toBe(indexed);
  });

  it("picks up a commit from the upstream repo on the next incremental run", async () => {
    const { runIndexJob } = await import("@/lib/indexing/pipeline");
    const { prisma } = await import("@/lib/prisma");

    // Commit to the *upstream* repository rather than editing the workspace in
    // place. The pipeline only sees this by fetching and fast-forwarding its
    // workspace checkout, which is the step that was broken: `checkoutCommit`
    // passed `--` and put git into pathspec mode, so every incremental run
    // threw at the sync step. The previous version of this test sidestepped it
    // by writing straight into the workspace, so the fetch/checkout path was
    // never exercised at all.
    const { prisma: db } = await import("@/lib/prisma");
    // Make sure there is a watermark to advance from, independently of what
    // ran before, so this test does not depend on file order.
    await ensureIndexed(projectId);
    const previousCommit = (await db().repository.findUnique({ where: { projectId } }))!.lastKnownCommit;
    expect(previousCommit).not.toBeNull();
    await appendLine(join(repoDir, "src/orders/model.ts"), "\n// changed upstream\n");
    await gitCommit(repoDir, "upstream change");

    // The watermark is an ancestor of the new tip, so this run takes the DIFF
    // path: git reports the changed files and the pipeline never looks at the
    // rest of the tree. Exactly one file is processed and nothing is "skipped" —
    // the untouched files are not examined, which is the point of an incremental
    // run. A previous version of this test asserted `filesSkipped` equalled the
    // total indexed minus one, which is the FULL-scan contract and fails here.
    const result = await runIndexJob({ projectId, mode: "incremental" });
    expect(result.filesProcessed).toBe(1);
    expect(result.filesSkipped).toBe(0);
    expect(result.filesFailed).toBe(0);
    expect(result.filesDeleted).toBe(0);

    const repository = await prisma().repository.findUnique({ where: { projectId } });
    // The watermark advances to the new upstream tip, which is only reachable
    // if the workspace actually fast-forwarded.
    const { currentHead } = await import("@/lib/git/git");
    const { workspaceForProject } = await import("@/lib/git/workspace");
    expect(repository!.lastKnownCommit).toBe(await currentHead(workspaceForProject(projectId)));
    expect(repository!.lastKnownCommit).not.toBe(previousCommit);

    const file = await prisma().file.findUnique({
      where: {
        repositoryId_path: { repositoryId: repository!.id, path: "src/orders/model.ts" },
      },
    });
    expect(file!.status).toBe("indexed");
  });

  it("reconciles deletions upstream on a full scan", async () => {
    const { runIndexJob } = await import("@/lib/indexing/pipeline");
    const { prisma } = await import("@/lib/prisma");
    const { countVectors } = await import("@/lib/qdrant");
    const db = prisma();
    // There has to be something indexed for the reconciliation to reconcile:
    // this test reads the file, chunks and vectors the deleted file left behind
    // and compares them with what is there afterwards.
    await ensureIndexed(projectId);
    const repository = (await db.repository.findUnique({ where: { projectId } }))!;
    const key = { repositoryId: repository.id, path: "docs/FLOWS.md" };

    const removed = await db.file.findUnique({ where: { repositoryId_path: key } });
    expect(removed).not.toBeNull();
    const vectorsBefore = await countVectors(projectId);
    expect(await db.chunk.count({ where: { fileId: removed!.id } })).toBeGreaterThan(0);

    await rm(join(repoDir, "docs/FLOWS.md"));
    await gitCommit(repoDir, "remove the flows doc");

    // A full scan reports every *surviving* tracked file as an add, so nothing
    // in the change list mentions the deleted one. The only signal that it is
    // gone is the reconciliation pass that diffs the tracked file list against
    // what is still indexed under this repository; without it the file, its
    // chunks, its symbols and its vectors stayed searchable forever.
    const result = await runIndexJob({ projectId, mode: "full" });
    expect(result.filesFailed).toBe(0);
    expect(result.filesDeleted).toBe(1);
    // `full` deliberately reprocesses everything rather than trusting the hash.
    expect(result.filesProcessed).toBe(4);

    expect(await db.file.findUnique({ where: { repositoryId_path: key } })).toBeNull();
    expect(await db.chunk.count({ where: { fileId: removed!.id } })).toBe(0);
    expect(await db.symbol.count({ where: { fileId: removed!.id } })).toBe(0);
    expect(await countVectors(projectId)).toBeLessThan(vectorsBefore);

    // The surviving files are not collateral damage: reconciliation only removes
    // what is both indexed and absent from the working tree.
    const paths = (await db.file.findMany({ where: { projectId } })).map((f) => f.path);
    expect(paths).toHaveLength(4);
    expect(paths).toContain("src/orders/model.ts");
    expect(paths).toContain("src/orders/service.ts");
  });

  it("purges vectors from a superseded embedding version on reembed", async () => {
    const { runIndexJob } = await import("@/lib/indexing/pipeline");
    const { prisma } = await import("@/lib/prisma");
    const { qdrant, collectionFor, collectionVectorSize, countVectors } = await import("@/lib/qdrant");
    const { resolveEmbeddingConfig } = await import("@/lib/embedding/provider");

    // A reembed needs an existing collection to purge a version from, and it
    // rewrites vectors for every tracked file. Both are established here rather
    // than inherited: a test run on its own has neither a collection nor a
    // single indexed file until something indexes the project.
    const indexed = await ensureIndexed(projectId);
    expect(indexed).toBeGreaterThan(0);

    const current = (await resolveEmbeddingConfig(projectId)).version;
    const dimensions = await collectionVectorSize(projectId);
    expect(dimensions, "the collection must exist before a version can be purged from it").not.toBeNull();
    // A version this project has never used, standing in for a leftover from a
    // run that was interrupted before it could rewrite its own vectors. Nothing
    // else removes such a point: the chunk it belonged to is gone, so
    // deleteVectorsForFile never looks at that file id again.
    const stale = current + 97;
    const orphanId = randomUUID();
    await qdrant().upsert(collectionFor(projectId), {
      points: [
        {
          id: orphanId,
          vector: new Array(dimensions!).fill(0.1),
          payload: {
            project_id: projectId,
            chunk_id: orphanId,
            file_id: randomUUID(),
            path: "src/deleted-in-a-failed-run.ts",
            embedding_version: stale,
          },
        },
      ],
    });
    expect(await countVectors(projectId, stale)).toBe(1);
    expect(await countVectors(projectId)).toBeGreaterThan(await countVectors(projectId, current));

    // A reembed only recreates the collection when its dimensionality no longer
    // matches, which is not the case here: so the orphan really does have to be
    // removed by the version purge rather than by the collection being dropped.
    const result = await runIndexJob({ projectId, mode: "reembed" });
    expect(result.filesFailed).toBe(0);
    // `reembed` reprocesses every tracked file, so the count is however many
    // files this project has indexed. It used to be hard-coded to 4, which was
    // only true because an earlier test in this file had deleted docs/FLOWS.md
    // — running this test on its own indexed 5 files and failed.
    expect(result.filesProcessed).toBe(await prisma().file.count({ where: { projectId } }));
    // ...and the run neither added a row nor dropped one: the same files are
    // indexed before and after.
    expect(indexed).toBe(result.filesProcessed);

    expect(await countVectors(projectId, stale)).toBe(0);
    // Nothing but the current version is left answering searches.
    expect(await countVectors(projectId)).toBe(await countVectors(projectId, current));
    expect(await countVectors(projectId)).toBeGreaterThan(0);
  });
});