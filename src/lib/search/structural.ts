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
}

export interface SymbolSearchOptions {
  limit: number;
  kind?: string;
  language?: string;
  path?: string;
}

export async function findSymbol(
  projectId: string,
  nameOrQualified: string,
): Promise<SymbolHit | null> {
  const symbol = await prisma().symbol.findFirst({
    where: {
      projectId,
      OR: [{ qualifiedName: nameOrQualified }, { name: nameOrQualified }],
    },
    include: { file: { select: { path: true } } },
  });
  if (!symbol) return null;
  return toSymbolHit(symbol);
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

/** Symbols that call, extend, implement, or otherwise reference a name. */
export async function findReferences(
  projectId: string,
  target: string,
  limit = 50,
): Promise<SymbolHit[]> {
  const simpleName = target.split(".").pop() ?? target;
  // ponytail: fetch-cap 500 symbols/project then score in JS; if projects grow
  // past ~10k symbols, move segment matching into a raw jsonb query.
  const symbols = await prisma().symbol.findMany({
    where: { projectId },
    include: { file: { select: { path: true } } },
    take: 500,
  });
  // A call/import entry `a.b.c` references both `a` and `a.b` and `a.b.c`.
  // Match exact, simple-name, or any prefix segment of the recorded name.
  const scored = symbols
    .map((s) => {
      const meta = (s.metadata ?? {}) as { calls?: string[]; imports?: string[]; extends?: string[] };
      let score = 0;
      for (const key of ["calls", "imports", "extends"] as const) {
        for (const e of meta[key] ?? []) {
          const segs = e.split(".");
          if (e === target || segs[segs.length - 1] === simpleName) score += 2;
          else if (segs.includes(simpleName)) score += 1;
        }
      }
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map(({ s }) => toSymbolHit(s));
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

/** Files that look like tests and mention the target symbol. */
export async function findTests(
  projectId: string,
  target?: string,
  limit = 25,
): Promise<SymbolHit[]> {
  const db = prisma();
  const testFiles = await db.file.findMany({
    where: {
      projectId,
      OR: [
        { path: { contains: ".test." } },
        { path: { contains: ".spec." } },
        { path: { contains: "_test." } },
        { path: { contains: "__tests__" } },
        { path: { contains: "/tests/" } },
        { path: { contains: "/test/" } },
        { path: { startsWith: "test_" } },
      ],
      ...(target ? { content: undefined } : {}),
    },
    select: { id: true, path: true, language: true },
    take: target ? 500 : limit,
  });
  const files = target
    ? testFiles.filter((f) => f.path.toLowerCase().includes(target.toLowerCase()))
    : testFiles;

  if (!target) {
    return files.slice(0, limit).map((f) => ({
      id: f.id,
      name: f.path.split("/").pop() ?? f.path,
      qualifiedName: f.path,
      kind: "test",
      language: f.language,
      path: f.path,
      startLine: 1,
      endLine: 1,
      parentName: null,
      calls: [],
      imports: [],
      extends: [],
    }));
  }

  // Rank test files by how often they mention the target, then return the
  // symbols they contain as hits.
  const hits: SymbolHit[] = [];
  for (const f of files) {
    const mentions = await db.chunk.count({
      where: { fileId: f.id, content: { contains: target } },
    });
    if (mentions > 0) {
      hits.push({
        id: f.id,
        name: f.path.split("/").pop() ?? f.path,
        qualifiedName: f.path,
        kind: "test",
        language: f.language,
        path: f.path,
        startLine: 1,
        endLine: 1,
        parentName: null,
        calls: [],
        imports: [],
        extends: [],
      });
    }
    if (hits.length >= limit) break;
  }
  return hits;
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
  const meta = (symbol.metadata ?? {}) as { calls?: string[]; imports?: string[]; extends?: string[] };
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
  };
}