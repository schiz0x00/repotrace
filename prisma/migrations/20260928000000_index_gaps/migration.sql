-- Index gaps found in the September 2026 audit.
--
-- Every index here backs a query the application actually issues. They are
-- additive only: no column is dropped or rewritten, so this is safe to apply
-- with `prisma migrate deploy` on a live database.

-- `chunk.symbolId` is a foreign key with ON DELETE CASCADE and had no index.
-- Deleting one file's symbols (which the indexing pipeline does for every
-- changed file, and the delete path does for every deleted one) made Postgres
-- sequentially scan the entire chunk table to find rows to cascade. On a
-- project with hundreds of thousands of chunks that is the dominant cost of
-- re-indexing a single file.
CREATE INDEX IF NOT EXISTS "chunk_symbolId_idx" ON "chunk"("symbolId");

-- `GET /files` pages a single project ordered by path. The existing
-- file_projectId_idx covers the filter but not the sort, so every page sorted
-- the project's whole file set.
CREATE INDEX IF NOT EXISTS "file_projectId_path_idx" ON "file"("projectId", "path");

-- The dashboard and the orphan reaper both filter jobs by status alone
-- (`status = 'queued'`, `status IN ('queued','running')`) and order by
-- createdAt. job_projectId_createdAt_idx leads with projectId, so it is
-- unusable for those queries.
CREATE INDEX IF NOT EXISTS "job_status_createdAt_idx" ON "job"("status", "createdAt");

-- pruneMetrics deletes metric_event rows older than a cutoff with no other
-- predicate, and the hourly retention sweep runs it against the whole table.
-- Neither existing index leads with recordedAt.
CREATE INDEX IF NOT EXISTS "metric_event_recordedAt_idx" ON "metric_event"("recordedAt");
