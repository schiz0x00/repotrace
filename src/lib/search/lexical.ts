import { prisma } from "@/lib/prisma";
import { CATEGORY_TO_CHUNK_TYPE, fileCategory } from "@/lib/indexing/file-category";
import type { ChunkType } from "@/generated/prisma/enums";

export interface LexicalHit {
  /** Null for symbol-name hits, which come from the symbol table, not chunks. */
  chunkId: string | null;
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

/**
 * Splits a user query into tsquery-safe lexemes and joins them with OR.
 *
 * Exported for tests: the AND/OR choice and the sanitisation are the two
 * things most likely to be broken by a well-meaning edit, and neither is
 * observable without a database.
 */
export function buildTsQuery(q: string): { tsQuery: string | null; terms: string[] } {
  const terms = q
    .split(/[^A-Za-z0-9_]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 16);
  return { tsQuery: terms.length ? terms.join(" | ") : null, terms };
}

export interface LexicalOptions {
  limit: number;
  chunkTypes?: ChunkType[];
  languages?: string[];
  path?: string;
}

/**
 * Lexical search over PostgreSQL full-text indexes (the `simple` config —
 * built for identifiers and code, not prose).
 *
 * Query terms are ORed, not ANDed; see the comment at the tsquery
 * construction. A query with no usable word character at all falls back to a
 * plain substring match, because tsquery has no representation for it.
 */
export async function lexicalSearch(
  projectId: string,
  query: string,
  opts: LexicalOptions,
): Promise<LexicalHit[]> {
  const q = query.trim();
  if (!q) return [];
  const db = prisma();

  // Bound as parameters rather than string-built, and every column is qualified.
  //
  // `"language"` unqualified was a hard 500 on every language-filtered search:
  // the FROM clause joins `file` and LEFT JOINs `symbol`, and BOTH have a
  // `language` column, so Postgres raised `column reference "language" is
  // ambiguous` (SQLSTATE 42702) at plan time. It only reproduces when the
  // filter is actually supplied, which is why it survived — the SELECT list
  // already wrote `f.language`, so the result shape looked right. Binding the
  // list also removes the manual quote-doubling these three needed to be safe.
  const chunkTypeFilter = opts.chunkTypes?.length
    ? `AND c."chunkType" = ANY($4::text[])`
    : "";
  const languageFilter = opts.languages?.length
    ? `AND f."language" = ANY($5::text[])`
    : "";
  const pathFilter = opts.path ? `AND f."path" ILIKE '%' || $6 || '%'` : "";

  let rows: LexicalHit[];
  try {
    // Split on everything that is not a word character, so the tsquery text
    // can only ever contain lexemes: no operator, quote or parenthesis can
    // survive to reach the parser, and the value travels as a bind parameter
    // rather than being interpolated.
    const { tsQuery } = buildTsQuery(q);

    // A query with no usable term (all punctuation, all separators) has no
    // tsquery representation. The docstring has always promised an ILIKE
    // fallback here; it did not exist, so such a query returned nothing.
    if (!tsQuery) {
      return await db.$queryRawUnsafe<LexicalHit[]>(
        `SELECT
           c.id AS "chunkId", c."fileId" AS "fileId", f.path, f.language,
           s."qualifiedName" AS symbol, s.kind AS "symbolKind",
           c."startLine" AS "startLine", c."endLine" AS "endLine",
           c.content, c."chunkType" AS "chunkType",
           1::float4 AS score
         FROM "chunk" c
         JOIN "file" f ON f.id = c."fileId"
         LEFT JOIN "symbol" s ON s.id = c."symbolId"
         WHERE c."projectId" = $1
           ${chunkTypeFilter} ${languageFilter} ${pathFilter}
           AND c.content ILIKE '%' || $3 || '%'
         ORDER BY score DESC
         LIMIT $2`,
        projectId,
        opts.limit,
        q,
        ...(opts.chunkTypes?.length ? [opts.chunkTypes] : []),
        ...(opts.languages?.length ? [opts.languages] : []),
        ...(opts.path ? [opts.path] : []),
      );
    }

    // OR, not AND. `to_tsquery` reads whitespace as `&`, so a natural-language
    // query like "how does order expiry work" demanded a chunk containing all
    // five words — which is why the lexical leg returned nothing for exactly
    // the questions this product exists to answer. `ts_rank` still favours
    // chunks matching more of the terms, and matching them more often, so the
    // ordering signal survives the change.
    rows = await db.$queryRawUnsafe<LexicalHit[]>(
      `SELECT
         c.id AS "chunkId", c."fileId" AS "fileId", f.path, f.language,
         s."qualifiedName" AS symbol, s.kind AS "symbolKind",
         c."startLine" AS "startLine", c."endLine" AS "endLine",
         c.content, c."chunkType" AS "chunkType",
         ts_rank(c.content_tsv, to_tsquery('simple', $3)) AS score
       FROM "chunk" c
       JOIN "file" f ON f.id = c."fileId"
       LEFT JOIN "symbol" s ON s.id = c."symbolId"
       WHERE c."projectId" = $1
         ${chunkTypeFilter} ${languageFilter} ${pathFilter}
         AND c.content_tsv @@ to_tsquery('simple', $3)
       ORDER BY score DESC
       LIMIT $2`,
      projectId,
      opts.limit,
      tsQuery,
      ...(opts.chunkTypes?.length ? [opts.chunkTypes] : []),
      ...(opts.languages?.length ? [opts.languages] : []),
      ...(opts.path ? [opts.path] : []),
    );
  } catch (e) {
    throw new Error(`Lexical search failed: ${e}`);
  }
  return rows;
}

/**
 * Symbol-name search: prefix + full-text over the symbol table.
 *
 * Filters are applied here rather than ignored. The symbol leg of hybrid search
 * previously took no `chunkTypes` or `languages` argument at all, so a
 * `chunkTypes: ["documentation"]` query — which is exactly what the `search_docs`
 * MCP tool sends — still received symbol hits from source files, which then
 * entered the fused result set tagged as code. The caller looked like it had
 * filtered and had not.
 */
export async function symbolNameSearch(
  projectId: string,
  query: string,
  limit: number,
  filters?: { chunkTypes?: ChunkType[]; languages?: string[] },
): Promise<LexicalHit[]> {
  const q = query.trim();
  if (!q) return [];
  const db = prisma();

  // Language is a column, so it is filtered in SQL — before the LIMIT, which is
  // the whole point. Filtering it in JS afterwards meant a selective filter
  // could discard every row the query had already decided to return, and a
  // documentation-only search could come back empty.
  const languages = filters?.languages?.length ? filters.languages : null;
  const languageClause = languages ? ` AND f.language = ANY($6::text[])` : "";

  // Chunk type is derived from the path by fileCategory, a JS function.
  // Restating its rules in SQL would let the two drift, so this over-fetches by
  // a bounded factor and filters in JS. The bound is the trade-off: a filter
  // selective enough to exhaust the over-fetch returns fewer rows than asked
  // for, and `limit` is a request for at most that many, never a promise.
  const chunkTypes = filters?.chunkTypes?.length ? new Set<string>(filters.chunkTypes) : null;
  const fetchLimit = chunkTypes ? Math.min(limit * 5, 500) : limit;

  const rows = await db.$queryRawUnsafe<
    Array<{
      id: string;
      qualifiedName: string;
      name: string;
      kind: string;
      path: string;
      language: string;
      startLine: number;
      endLine: number;
      score: number;
    }>
  >(
    `SELECT s.id, s."qualifiedName" AS "qualifiedName", s.name, s.kind,
            f.path, f.language, s."startLine" AS "startLine", s."endLine" AS "endLine",
            (s.name ILIKE $2::text)::int * 3 + (s."qualifiedName" ILIKE $3::text)::int * 2
            + ts_rank(s.name_tsv, plainto_tsquery('simple', $1)) AS score
     FROM "symbol" s
     JOIN "file" f ON f.id = s."fileId"
     WHERE s."projectId" = $4
       AND (s.name ILIKE $2 OR s."qualifiedName" ILIKE $3 OR s.name_tsv @@ plainto_tsquery('simple', $1))${languageClause}
     ORDER BY score DESC, s."qualifiedName"
     LIMIT $5`,
    q,
    `${q}%`,
    `%${q}%`,
    projectId,
    fetchLimit,
    ...(languages ? [languages] : []),
  );

  return rows
    .filter((r) => (chunkTypes ? chunkTypes.has(fileCategory(r.path)) : true))
    .slice(0, limit)
    .map((r) => ({
      // A symbol row has no chunk, so there is no chunk id to report. The
      // previous code put the *symbol* id here, which meant any caller that
      // trusted this field to identify a chunk looked up a row in the wrong
      // table and silently got nothing back.
      chunkId: null,
      fileId: "",
      path: r.path,
      language: r.language,
      symbol: r.qualifiedName,
      symbolKind: r.kind,
      startLine: r.startLine,
      endLine: r.endLine,
      content: "",
      // The file's actual category, not a hardcoded "code": labelling a
      // documentation symbol as code contradicted both the filter applied just
      // above and the classification the pipeline stored.
      chunkType: CATEGORY_TO_CHUNK_TYPE[fileCategory(r.path)],
      score: r.score,
    }));
}