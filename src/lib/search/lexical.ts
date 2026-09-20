import { prisma } from "@/lib/prisma";
import type { ChunkType } from "@/generated/prisma/enums";

export interface LexicalHit {
  chunkId: string;
  fileId: string;
  path: string;
  language: string;
  symbol: string | null;
  symbolKind: string | null;
  startLine: number;
  endLine: number;
  content: string;
  chunkType: ChunkType;
  score: number;
}

export interface LexicalOptions {
  limit: number;
  chunkTypes?: ChunkType[];
  languages?: string[];
  path?: string;
}

/**
 * Lexical search over PostgreSQL full-text indexes (simple config — built for
 * identifiers and code, not prose). Falls back to ILIKE when the query is
 * too short for tsquery parsing.
 */
export async function lexicalSearch(
  projectId: string,
  query: string,
  opts: LexicalOptions,
): Promise<LexicalHit[]> {
  const q = query.trim();
  if (!q) return [];
  const db = prisma();

  const chunkTypeFilter = opts.chunkTypes?.length
    ? `AND "chunkType" IN (${opts.chunkTypes.map((t) => `'${t}'`).join(",")})`
    : "";
  const languageFilter = opts.languages?.length
    ? `AND "language" IN (${opts.languages.map((l) => `'${l.replace(/'/g, "''")}'`).join(",")})`
    : "";
  const pathFilter = opts.path ? `AND "path" ILIKE '%${opts.path.replace(/'/g, "''")}%'` : "";

  let rows: LexicalHit[];
  try {
    const safeQuery = q.replace(/[^a-zA-Z0-9_\s]/g, " ").trim();
    const tsq = safeQuery ? `to_tsquery('simple', '${safeQuery.replace(/'/g, "''")}')` : "''";
    rows = await db.$queryRawUnsafe<LexicalHit[]>(
      `SELECT
         c.id AS "chunkId", c."fileId" AS "fileId", f.path, f.language,
         s."qualifiedName" AS symbol, s.kind AS "symbolKind",
         c."startLine" AS "startLine", c."endLine" AS "endLine",
         c.content, c."chunkType" AS "chunkType",
         ts_rank(c.content_tsv, (${tsq})) AS score
       FROM "chunk" c
       JOIN "file" f ON f.id = c."fileId"
       LEFT JOIN "symbol" s ON s.id = c."symbolId"
       WHERE c."projectId" = $1
         ${chunkTypeFilter} ${languageFilter} ${pathFilter}
         AND c.content_tsv @@ (${tsq})
       ORDER BY score DESC
       LIMIT $2`,
      projectId,
      opts.limit,
    );
  } catch (e) {
    throw new Error(`Lexical search failed: ${e}`);
  }
  return rows;
}

/** Symbol-name search: prefix + full-text over the symbol table. */
export async function symbolNameSearch(
  projectId: string,
  query: string,
  limit: number,
): Promise<LexicalHit[]> {
  const q = query.trim();
  if (!q) return [];
  const db = prisma();
  const rows = await db.$queryRawUnsafe<
    Array<{
      id: string;
      qualifiedName: string;
      name: string;
      kind: string;
      path: string;
      startLine: number;
      endLine: number;
      score: number;
    }>
  >(
    `SELECT s.id, s."qualifiedName" AS "qualifiedName", s.name, s.kind,
            f.path, s."startLine" AS "startLine", s."endLine" AS "endLine",
            (s.name ILIKE $2::text)::int * 3 + (s."qualifiedName" ILIKE $3::text)::int * 2
            + ts_rank(s.name_tsv, plainto_tsquery('simple', $1)) AS score
     FROM "symbol" s
     JOIN "file" f ON f.id = s."fileId"
     WHERE s."projectId" = $4
       AND (s.name ILIKE $2 OR s."qualifiedName" ILIKE $3 OR s.name_tsv @@ plainto_tsquery('simple', $1))
     ORDER BY score DESC, s."qualifiedName"
     LIMIT $5`,
    q,
    `${q}%`,
    `%${q}%`,
    projectId,
    limit,
  );
  return rows.map((r) => ({
    chunkId: r.id,
    fileId: "",
    path: r.path,
    language: "",
    symbol: r.qualifiedName,
    symbolKind: r.kind,
    startLine: r.startLine,
    endLine: r.endLine,
    content: "",
    chunkType: "code" as ChunkType,
    score: r.score,
  }));
}