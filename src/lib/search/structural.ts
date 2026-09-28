import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Structural search over the symbol index: definitions, references
 * (callers), dependencies (calls/imports of a symbol), and tests.
 * Exact code relationships are the job of this index — never of vector
 * similarity.
 */

export interface SymbolHit {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  language: string;
  path: string;
  startLine: number;
  endLine: number;
  parentName: string | null;
  calls: string[];
  imports: string[];
  extends: string[];
  /** Interfaces the symbol implements. Distinct from `extends` (a superclass). */
  implements: string[];
}

export interface SymbolSearchOptions {
  limit: number;
  kind?: string;
  language?: string;
  path?: string;
}

/**
 * One symbol, by exact qualified name or by exact short name.
 *
 * The two lookups used to disagree about which of the two wins. This was a
 * `findFirst` over `qualifiedName OR name` with no ordering, so when a project
 * held both `OrderService` and `service.OrderService` it answered with
 * whichever row the planner emitted first, while {@link findSymbolsBatch}
 * deterministically returned the qualified one. Both now prefer the qualified
 * match, which is also what a caller naming `OrderService.cancelOrder` means.
 *
 * The preference is expressed as two queries rather than one `findMany` that is
 * filtered here: `findFirst` has no way to express "exact qualified match
 * first" — an `orderBy` would only sort the matches, not promote one of them —
 * so the qualified clause is asked for alone and the short-name clause is the
 * fallback. The second query only runs when the first missed, which is the case
 * where the caller passed a short name that is not itself some symbol's
 * qualified name (a method looked up as `cancelOrder`): a top-level declaration
 * has `qualifiedName === name` and is answered by the first query.
 *
 * Both `where` clauses are written as one-element `OR` lists to keep the same
 * shape the batch path builds, which is the shape the query-matcher in
 * tests/dependency-graph.test.ts models.
 *
 * Which of several rows sharing the *same* match kind comes back stays
 * unspecified, here and in {@link findSymbolsBatch}: neither query is ordered,
 * so two symbols with the same qualified name (an overload set, a name reused
 * across files) resolve arbitrarily.
 *
 * The name is trimmed, which {@link findSymbolsBatch} already did. The two are
 * the same lookup for the same question — the MCP `find_symbol` tool and the
 * dependency graph call this one, the context builder calls the batch — so a
 * name that arrived with a stray leading or trailing space resolved in a
 * context bundle and silently found nothing here. Neither the parsers nor
 * `qualifiedName` ever contain whitespace at their edges, so trimming removes
 * no match; it only stops the two paths from disagreeing.
 */
export async function findSymbol(
  projectId: string,
  nameOrQualified: string,
): Promise<SymbolHit | null> {
  const include = { file: { select: { path: true } } };
  // A blank name matches no symbol, so this skips up to two pointless round
  // trips. It mirrors the batch, which drops blanks before it queries.
  const name = nameOrQualified.trim();
  if (!name) return null;
  const qualified = await prisma().symbol.findFirst({
    where: { projectId, OR: [{ qualifiedName: name }] },
    include,
  });
  if (qualified) return toSymbolHit(qualified);
  const short = await prisma().symbol.findFirst({
    where: { projectId, OR: [{ name }] },
    include,
  });
  return short ? toSymbolHit(short) : null;
}

/**
 * Resolves many names in one query, keyed by the name that was asked for.
 *
 * The context builder used to call `findSymbol` for every top symbol and then
 * for each of their callees — up to 42 round trips issued one after another.
 * This collapses them into a single query.
 *
 * The qualified-name-over-short-name preference is the one {@link findSymbol}
 * applies, expressed here as two indexes with the qualified-name one layered on
 * top: for a name that matches both ways, the later spread overwrites the
 * earlier entry. Names are trimmed and blanks dropped, so a batched lookup and
 * a single one answer identically for the same name.
 */
export async function findSymbolsBatch(
  projectId: string,
  names: string[],
): Promise<Map<string, SymbolHit>> {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const out = new Map<string, SymbolHit>();
  if (unique.length === 0) return out;

  const rows = await prisma().symbol.findMany({
    where: {
      projectId,
      OR: unique.flatMap((n) => [{ qualifiedName: n }, { name: n }]),
    },
    include: { file: { select: { path: true } } },
  });
  const preferred = new Map([
    ...indexFirstBy(rows, (r) => r.name),
    ...indexFirstBy(rows, (r) => r.qualifiedName),
  ]);
  for (const name of unique) {
    const row = preferred.get(name);
    if (row) out.set(name, toSymbolHit(row));
  }
  return out;
}

/** First row per key wins, so the choice does not depend on how many matched. */
function indexFirstBy<Row>(rows: readonly Row[], key: (row: Row) => string): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const row of rows) {
    const k = key(row);
    if (!out.has(k)) out.set(k, row);
  }
  return out;
}

/** Prefix search over symbol names (used by command palette + find_symbol). */
export async function searchSymbols(
  projectId: string,
  query: string,
  opts: SymbolSearchOptions,
): Promise<SymbolHit[]> {
  const q = query.trim();
  const db = prisma();
  const symbols = await db.symbol.findMany({
    where: {
      projectId,
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.language ? { language: opts.language } : {}),
      ...(opts.path ? { file: { path: { contains: opts.path } } } : {}),
      OR: q
        ? [
            { qualifiedName: { startsWith: q } },
            { name: { startsWith: q } },
            { qualifiedName: { contains: q } },
          ]
        : undefined,
    },
    include: { file: { select: { path: true } } },
    orderBy: [{ name: "asc" }],
    take: opts.limit,
  });
  return symbols.map(toSymbolHit);
}

/**
 * The metadata keys a reference can live under, in the order they are summed.
 * `implements` is deliberately absent: it was never part of the original JS
 * scoring, and adding it here would change what counts as a reference.
 */
export const REFERENCE_KEYS = ["calls", "imports", "extends"] as const;

/**
 * The trailing dot-separated segment of a qualified name.
 *
 * A call/import entry `a.b.c` references `a`, `a.b` and `a.b.c`, so matching
 * happens on the simple name. `split(".").pop()` never returns null, so the
 * `?? ` arm is type narrowing only.
 */
export function simpleNameOf(nameOrQualified: string): string {
  return nameOrQualified.split(".").pop() ?? nameOrQualified;
}

/**
 * A call/import entry `a.b.c` references `a`, `a.b` and `a.b.c`, so a dotted
 * name matches when any of its dot-separated segments equals the target's
 * simple name. The scoring below mirrors the original JS exactly: an exact hit
 * or a trailing-segment hit scores 2, a match in an earlier segment scores 1.
 *
 * `elem.value` is compared with `= ANY(string_to_array(...))` rather than a
 * LIKE or regex pattern on purpose: symbol names routinely contain `_` and `$`,
 * which are wildcards to LIKE and metacharacters to regex, so pattern matching
 * would report references that do not exist.
 */
const REFERENCE_SCORE_SQL = `
  COALESCE((
    SELECT SUM(CASE
      WHEN e.value = $3::text THEN 2
      WHEN (string_to_array(e.value, '.'))[array_length(string_to_array(e.value, '.'), 1)] = $2::text THEN 2
      WHEN $2::text = ANY(string_to_array(e.value, '.')) THEN 1
      ELSE 0
    END)
    FROM jsonb_array_elements_text(COALESCE(s.metadata->@KEY@, '[]'::jsonb)) AS e(value)
  ), 0)`;

/** The score expression, one jsonb scan per key of {@link REFERENCE_KEYS}. */
export function buildReferenceScoreSql(): string {
  return REFERENCE_KEYS.map((key) => REFERENCE_SCORE_SQL.replace("@KEY@", `'${key}'`)).join(" + ");
}

/**
 * The statement `findReferences` runs. Exported so the SQL shape — parameter
 * positions, casts, ordering — is testable without a database.
 *
 * Parameter order is load-bearing and must match the array passed to
 * `$queryRawUnsafe`: $1 projectId, $2 simple name, $3 qualified target, $4 limit.
 *
 * Parameters are cast explicitly: Postgres cannot infer a type for a bare
 * parameter that only appears inside `= ANY(...)`, and would raise "could not
 * determine data type of parameter" at execution time.
 *
 * The CTE is MATERIALIZED on purpose. A CTE referenced exactly once is inlined
 * by the planner (Postgres 12+), and inlining substitutes the score expression
 * into the outer query, where `WHERE score > 0` and `ORDER BY score` both read
 * it — so the `jsonb_array_elements_text` scan over three metadata keys ran
 * twice per row. MATERIALIZED evaluates it once into a tuplestore. The cost is
 * that the CTE becomes an optimization fence: the `file` join can no longer be
 * pushed down, so the project's symbols are materialised in full. That is one
 * row per symbol in the project — bounded, and much cheaper than evaluating a
 * three-way jsonb array scan twice over the same rows.
 */
export function buildFindReferencesSql(): string {
  return `WITH scored AS MATERIALIZED (
       SELECT s.id, s.name, s."qualifiedName", s.kind, s.language,
              s."parentName", s."startLine", s."endLine", s.metadata,
              f.path AS "filePath",
              (${buildReferenceScoreSql()}) AS score
       FROM "symbol" s
       JOIN "file" f ON f.id = s."fileId"
       WHERE s."projectId" = $1::text
     )
     SELECT id, name, "qualifiedName", kind, language, "parentName",
            "startLine", "endLine", metadata, "filePath"
     FROM scored
     WHERE score > 0
     ORDER BY score DESC, "qualifiedName" ASC
     LIMIT $4::int`;
}

/**
 * Symbols whose `calls`, `imports` or `extends` metadata names `target` —
 * exactly the keys in {@link REFERENCE_KEYS}, and no others.
 *
 * `implements` is not one of them, so a class that implements an interface is
 * not reported as referencing it. That is deliberate (see
 * {@link REFERENCE_KEYS}) and is the same set the MCP `find_references` tool
 * advertises. `implements` is still populated on the returned {@link SymbolHit}s
 * — it is only excluded from the matching.
 */
export async function findReferences(
  projectId: string,
  target: string,
  limit = 50,
): Promise<SymbolHit[]> {
  // The matching runs in Postgres against the jsonb metadata rather than by
  // pulling the project's symbols into memory. The previous implementation
  // fetched 500 symbols with no ORDER BY and filtered them in JS, so for any
  // project over 500 symbols (i.e. every real project) it silently answered
  // from an arbitrary subset — references outside it were simply not found.
  // The `@@index([projectId, qualifiedName])` index narrows the scan to the
  // project before the jsonb expression is evaluated.
  const rows = await prisma().$queryRawUnsafe<SymbolRow[]>(
    buildFindReferencesSql(),
    projectId,
    simpleNameOf(target),
    target,
    limit,
  );
  return rows.map((row) => toSymbolHit({ ...row, file: { path: row.filePath } }));
}

export interface GraphNode {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  language: string;
  path: string;
  startLine: number;
  endLine: number;
  depth: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: "calls" | "imports" | "extends";
  /** False when the name is external (a library, a builtin) and not indexed. */
  resolved: boolean;
}

export interface DependencyGraph {
  root: GraphNode | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when either bound below was hit. Kept for callers that only want a flag. */
  truncated: boolean;
  /**
   * Which bound actually cut the walk. A node cap and an edge cap have
   * different remedies, and collapsing them into one boolean is what made the
   * old truncation silent: `truncated` could be true for a graph that returned
   * every edge, or false for nothing, and neither state said what was missing.
   *
   * Required: an omitted `truncation` is indistinguishable at the type level
   * from a graph nobody checked for truncation, which is exactly how a
   * truncated graph would ship unannounced.
   */
  truncation: GraphTruncation;
}

export interface GraphTruncation {
  /** Symbols were dropped because the node limit was reached. */
  nodes: boolean;
  /** Edges were dropped because the edge limit was reached, so the walk stopped. */
  edges: boolean;
}

/**
 * Hard ceiling on the serialized edge array, independent of the node `limit`.
 *
 * The node limit bounds `nodes` but never bounded `edges`: a symbol with N
 * imports produced N edges at that level, at every level, so `limit=1000&depth=4`
 * returned a response whose size was set by the repository rather than by the
 * caller. The edges are the part that actually gets serialized, so they get an
 * explicit bound. The cost is stated plainly: a caller that asks for a
 * 1000-node graph and gets it may still see only 2000 edges, and must read
 * `truncation.edges` to know.
 */
export const MAX_GRAPH_EDGES = 2000;

/** Edge allowance per node when the node limit is the binding bound. */
const EDGES_PER_NODE = 4;

/**
 * Floor for the edge budget. Without it `limit=1` would also mean "at most four
 * edges", which is a coupling between two unrelated bounds.
 */
const MIN_GRAPH_EDGES = 64;

/** The edge budget for a given node limit. Pure, so the cap is testable. */
export function graphEdgeLimit(nodeLimit: number): number {
  return Math.min(MAX_GRAPH_EDGES, Math.max(MIN_GRAPH_EDGES, nodeLimit * EDGES_PER_NODE));
}

/**
 * Every call/import/extends entry of a symbol as an edge, in that fixed order.
 *
 * Kept pure and separate from the walk so the edge accounting is testable
 * without a database.
 */
export function outgoingRelations(symbol: SymbolHit): Array<{
  from: string;
  to: string;
  kind: GraphEdge["kind"];
}> {
  return [
    ...symbol.calls.map((to) => ({ from: symbol.qualifiedName, to, kind: "calls" as const })),
    ...symbol.imports.map((to) => ({ from: symbol.qualifiedName, to, kind: "imports" as const })),
    ...symbol.extends.map((to) => ({ from: symbol.qualifiedName, to, kind: "extends" as const })),
  ];
}

/**
 * Breadth-first call/import/extends graph around a symbol.
 *
 * The index already stores every symbol's relationships in `metadata`, and
 * `find_dependencies` reads one symbol's list, but there was no way to ask
 * about a *shape* — what a change to this function would ripple into. Each
 * level resolves its whole frontier in one batched query rather than one
 * query per symbol, so depth is bounded by round trips, not by fan-out.
 *
 * Unresolved edges (library imports, builtins) are kept with `resolved: false`
 * rather than dropped: an import of something outside the repo is exactly what
 * a reader needs to see.
 *
 * Two bounds apply, and both report themselves in `truncation`: the node limit
 * and the edge limit. The edge bound is what keeps the batched resolution query
 * finite — `wanted` is collected under the same budget that bounds the returned
 * edges, and `findSymbolsBatch` turns each entry into two OR clauses, so an
 * unbounded `wanted` meant one round trip with thousands of predicates in it.
 */
export async function dependencyGraph(
  projectId: string,
  rootName: string,
  opts: { depth?: number; limit?: number } = {},
): Promise<DependencyGraph> {
  const maxDepth = Math.min(4, Math.max(1, opts.depth ?? 2));
  const limit = Math.min(1000, Math.max(1, opts.limit ?? 200));
  const edgeLimit = graphEdgeLimit(limit);

  const root = await findSymbol(projectId, rootName);
  if (!root) {
    return {
      root: null,
      nodes: [],
      edges: [],
      truncated: false,
      truncation: { nodes: false, edges: false },
    };
  }

  const nodes: GraphNode[] = [toGraphNode(root, 0)];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>([root.id]);
  let frontier: SymbolHit[] = [root];
  const truncation: GraphTruncation = { nodes: false, edges: false };

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    // What is left of the edge budget at this level. It can be zero or
    // negative when a previous level spent all of it: there is then nothing
    // left to expand into and any further hop would produce edges we could not
    // return.
    const budget = edgeLimit - edges.length;

    // Collect every outgoing name at this level, then resolve them in one
    // query.
    //
    // The budget is applied here rather than tested before the frontier is
    // inspected, so `truncation.edges` is set only when a relation is actually
    // dropped. A frontier whose symbols have no recorded relations ends the
    // walk one line below with `wanted.length === 0`; reporting truncation for
    // it would tell the caller to raise an edge budget that cannot change the
    // result, which is the one remedy this field exists to offer.
    const wanted: Array<{ from: string; to: string; kind: GraphEdge["kind"] }> = [];
    collect: for (const symbol of frontier) {
      for (const rel of outgoingRelations(symbol)) {
        if (wanted.length >= budget) {
          truncation.edges = true;
          break collect;
        }
        wanted.push(rel);
      }
    }
    if (wanted.length === 0) break;

    const resolved = await findSymbolsBatch(projectId, wanted.map((w) => simpleNameOf(w.to)));

    const nextFrontier: SymbolHit[] = [];
    for (const w of wanted) {
      const hit = resolved.get(simpleNameOf(w.to));
      edges.push({ from: w.from, to: w.to, kind: w.kind, resolved: Boolean(hit) });
      if (!hit || seen.has(hit.id)) continue;
      if (nodes.length >= limit) {
        truncation.nodes = true;
        continue;
      }
      seen.add(hit.id);
      nodes.push(toGraphNode(hit, depth));
      nextFrontier.push(hit);
    }
    // No explicit node-cap break is needed: once `nodes` is full every further
    // hit takes the `continue` above, so `nextFrontier` is empty and the loop
    // condition ends the walk. That is also why `truncation.nodes` is only set
    // when a symbol was genuinely dropped rather than when the cap was merely
    // reached.
    frontier = nextFrontier;
  }

  return {
    root: toGraphNode(root, 0),
    nodes,
    edges,
    truncated: truncation.nodes || truncation.edges,
    truncation,
  };
}

function toGraphNode(s: SymbolHit, depth: number): GraphNode {
  return {
    id: s.id,
    name: s.name,
    qualifiedName: s.qualifiedName,
    kind: s.kind,
    language: s.language,
    path: s.path,
    startLine: s.startLine,
    endLine: s.endLine,
    depth,
  };
}

/** What a symbol calls/imports/extends — its dependency list. */
export async function findDependencies(
  projectId: string,
  nameOrQualified: string,
): Promise<{ calls: string[]; imports: string[]; extends: string[] } | null> {
  const symbol = await findSymbol(projectId, nameOrQualified);
  if (!symbol) return null;
  return { calls: symbol.calls, imports: symbol.imports, extends: symbol.extends };
}

/**
 * Test-file detection. `position(substring in string)` is a literal match,
 * unlike `LIKE`, where `_` in `_test.` would be a single-character wildcard.
 */
export const TEST_PATH_PREDICATE = `(
  position('.test.' in f.path) > 0
  OR position('.spec.' in f.path) > 0
  OR position('_test.' in f.path) > 0
  OR position('/__tests__/' in '/' || f.path) > 0
  OR position('/tests/' in f.path) > 0
  OR position('/test/' in f.path) > 0
  OR left(f.path, 5) = 'test_'
)`;

function toTestHit(row: { id: string; path: string; language: string }): SymbolHit {
  return {
    id: row.id,
    name: row.path.split("/").pop() ?? row.path,
    qualifiedName: row.path,
    kind: "test",
    language: row.language,
    path: row.path,
    startLine: 1,
    endLine: 1,
    parentName: null,
    calls: [],
    imports: [],
    extends: [],
    implements: [],
  };
}

/**
 * The statement `findTests` runs when a target symbol is given. Exported so the
 * SQL shape — parameter positions, casts, the ordering contract — is testable
 * without a database.
 *
 * Parameter order is load-bearing and must match the array passed to
 * `$queryRawUnsafe`: $1 projectId, $2 simple name, $3 limit.
 */
export function buildFindTestsSql(): string {
  return `SELECT f.id, f.path, f.language
     FROM "file" f
     JOIN "chunk" c ON c."fileId" = f.id
     WHERE f."projectId" = $1::text
       AND ${TEST_PATH_PREDICATE}
       AND c.content_tsv @@ plainto_tsquery('simple', $2::text)
     GROUP BY f.id, f.path, f.language
     ORDER BY COUNT(c.id) DESC, f.path ASC
     LIMIT $3::int`;
}

/** Files that look like tests and mention the target symbol. */
export async function findTests(
  projectId: string,
  target?: string,
  limit = 25,
): Promise<SymbolHit[]> {
  const db = prisma();

  if (!target) {
    const files = await db.file.findMany({
      where: { projectId, OR: TEST_PATH_WHERE },
      select: { id: true, path: true, language: true },
      orderBy: { path: "asc" },
      take: limit,
    });
    return files.map(toTestHit);
  }

  // One aggregate query instead of a per-file count in a loop.
  //
  // Two things were wrong before. The candidate set was pre-filtered by
  // `path.includes(target)`, which discarded almost every test file — a test
  // for `cancelOrder` is named `orders.spec.ts`, not `cancelOrder.spec.ts` —
  // so the mention count that actually did the work usually ran over an empty
  // or near-empty set and the tool reported no tests. And the counts themselves
  // were issued serially, one round trip per candidate, each a full scan of
  // that file's chunk content.
  //
  // Matching now runs through the same `content_tsv` generated column and GIN
  // index that lexical search uses, so the scan is index-backed rather than
  // sequential, and ranking by mention count is done by the database.
  const rows = await db.$queryRawUnsafe<Array<{ id: string; path: string; language: string }>>(
    buildFindTestsSql(),
    projectId,
    simpleNameOf(target),
    limit,
  );
  return rows.map(toTestHit);
}

/** Prisma-side equivalent of {@link TEST_PATH_PREDICATE}, for the no-target path. */
const TEST_PATH_WHERE: Prisma.FileWhereInput[] = [
  { path: { contains: ".test." } },
  { path: { contains: ".spec." } },
  { path: { contains: "_test." } },
  // Whole-segment match, not a substring: `path contains` also matched
  // `foo__tests__bar.ts` and `__tests__helper.ts`, which are ordinary code.
  // See TEST_DIRECTORIES in @/lib/indexing/file-category for the same rule.
  { path: { contains: "/__tests__/" } },
  { path: { startsWith: "__tests__/" } },
  { path: { contains: "/tests/" } },
  { path: { contains: "/test/" } },
  { path: { startsWith: "test_" } },
];

interface SymbolRow {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  language: string;
  startLine: number;
  endLine: number;
  parentName: string | null;
  metadata: unknown;
  filePath: string;
}

function toSymbolHit(symbol: {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  language: string;
  startLine: number;
  endLine: number;
  parentName: string | null;
  metadata: unknown;
  file: { path: string };
}): SymbolHit {
  const meta = (symbol.metadata ?? {}) as {
    calls?: string[];
    imports?: string[];
    extends?: string[];
    implements?: string[];
  };
  return {
    id: symbol.id,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    language: symbol.language,
    path: symbol.file.path,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    parentName: symbol.parentName,
    calls: meta.calls ?? [],
    imports: meta.imports ?? [],
    extends: meta.extends ?? [],
    implements: meta.implements ?? [],
  };
}