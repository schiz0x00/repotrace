import "dotenv/config";

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { requireProject, searchProject } from "@/lib/search/search";
import { buildContextBundle } from "@/lib/search/context";

const EVALS_DIR = "data/evals";
const K_VALUES = [5, 10];

const DEFAULT_LIMIT = 10;
const DEFAULT_FLOOR = 0.5;

interface EvalQuestion {
  id: string;
  projectSlug: string;
  query: string;
  mode?: "hybrid" | "lexical" | "semantic" | "symbol";
  expectedFiles: string[];
  expectedSymbols?: string[];
  notes?: string;
}

interface QuestionResult {
  id: string;
  projectSlug: string;
  query: string;
  mode: string;
  expectedFiles: string[];
  expectedSymbols: string[];
  recallFiles: Partial<Record<number, number>>;
  recallSymbols: Partial<Record<number, number>>;
  contextHitRate: number | null;
  topFiles: string[];
  error?: string;
}

interface CliArgs {
  project?: string;
  limit: number;
  floor: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { project: undefined, limit: DEFAULT_LIMIT, floor: DEFAULT_FLOOR, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project" && i + 1 < argv.length) out.project = argv[++i];
    else if (arg === "--limit" && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n)) out.limit = Math.max(1, Math.min(50, Math.floor(n)));
    } else if (arg === "--floor" && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n)) out.floor = n;
    } else if (arg === "--json") out.json = true;
  }
  return out;
}

async function loadQuestions(dir: string): Promise<EvalQuestion[]> {
  const entries = await readdir(dir).catch(() => []);
  const questions: EvalQuestion[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as { questions?: EvalQuestion[] }).questions ?? [];
    questions.push(...(list as EvalQuestion[]));
  }
  return questions;
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, "");
}

function recallAt(retrieved: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 1;
  const top = new Set(retrieved.slice(0, k).map(normalizePath));
  const hits = expected.filter((e) => top.has(normalizePath(e)));
  return hits.length / expected.length;
}

function symbolHitAt(retrieved: Array<string | null>, expected: string[], k: number): number {
  if (expected.length === 0) return 1;
  const top = retrieved.slice(0, k).filter((s): s is string => !!s);
  const hits = expected.filter((e) => top.some((s) => s === e || s.startsWith(`${e}.`) || e.startsWith(`${s}.`)));
  return hits.length / expected.length;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function evaluateQuestion(
  q: EvalQuestion,
  cliLimit: number,
): Promise<QuestionResult> {
  const result: QuestionResult = {
    id: q.id,
    projectSlug: q.projectSlug,
    query: q.query,
    mode: q.mode ?? "hybrid",
    expectedFiles: q.expectedFiles,
    expectedSymbols: q.expectedSymbols ?? [],
    recallFiles: {},
    recallSymbols: {},
    contextHitRate: null,
    topFiles: [],
  };
  try {
    const project = await requireProject(q.projectSlug);
    const search = await searchProject(project.id, q.query, { mode: q.mode, limit: cliLimit });
    const paths = search.items.map((i) => i.path);
    const symbols = search.items.map((i) => i.symbol);
    result.topFiles = unique(paths).slice(0, 10);
    for (const k of K_VALUES) {
      result.recallFiles[k] = recallAt(paths, q.expectedFiles, k);
      result.recallSymbols[k] = symbolHitAt(symbols, q.expectedSymbols ?? [], k);
    }

    const bundle = await buildContextBundle(project.id, q.query, { limit: 8 });
    const bundleFiles = unique([
      ...bundle.symbols.map((s) => s.path),
      ...bundle.docs.map((d) => d.path),
      ...bundle.relatedSymbols.map((r) => r.path),
      ...bundle.tests.map((t) => t.path),
    ]);
    if (q.expectedFiles.length > 0) {
      const matched = q.expectedFiles.filter((f) => bundleFiles.some((p) => normalizePath(p) === normalizePath(f)));
      result.contextHitRate = matched.length / q.expectedFiles.length;
    }
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}

interface Aggregate {
  questions: number;
  failed: number;
  recallFilesAt5: number | null;
  recallFilesAt10: number | null;
  recallSymbolsAt5: number | null;
  recallSymbolsAt10: number | null;
  contextHitRate: number | null;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function aggregateResults(results: QuestionResult[]): Aggregate {
  const ran = results.filter((r) => !r.error);
  const completed = ran.filter((r) => Object.keys(r.recallFiles).length > 0);
  const file5 = completed.map((r) => r.recallFiles[5]!).filter((v) => v !== undefined);
  const file10 = completed.map((r) => r.recallFiles[10]!).filter((v) => v !== undefined);
  const sym5 = completed.map((r) => r.recallSymbols[5]!).filter((v) => v !== undefined);
  const sym10 = completed.map((r) => r.recallSymbols[10]!).filter((v) => v !== undefined);
  const ctx = completed.map((r) => r.contextHitRate).filter((v) => v !== null) as number[];
  return {
    questions: results.length,
    failed: results.filter((r) => r.error).length,
    recallFilesAt5: file5.length ? mean(file5) : null,
    recallFilesAt10: file10.length ? mean(file10) : null,
    recallSymbolsAt5: sym5.length ? mean(sym5) : null,
    recallSymbolsAt10: sym10.length ? mean(sym10) : null,
    contextHitRate: ctx.length ? mean(ctx) : null,
  };
}

function fmt(v: number | null | undefined, fallback = "  -"): string {
  return v === null || v === undefined ? fallback : v.toFixed(3);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function printReport(results: QuestionResult[], agg: Aggregate, floor: number): void {
  const cols = [
    ["id", 22],
    ["mode", 9],
    ["files@5", 8],
    ["files@10", 9],
    ["sym@5", 7],
    ["sym@10", 8],
    ["ctx", 6],
    ["top file", 40],
  ] as const;
  const header = cols.map(([name, w]) => pad(name, w)).join(" ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of results) {
    const top = r.topFiles[0] ?? (r.error ? `ERROR: ${r.error.slice(0, 40)}` : "(none)");
    console.log(
      [
        pad(r.id, 22),
        pad(r.mode, 9),
        pad(fmt(r.recallFiles[5]), 8),
        pad(fmt(r.recallFiles[10]), 9),
        pad(fmt(r.recallSymbols[5]), 7),
        pad(fmt(r.recallSymbols[10]), 8),
        pad(fmt(r.contextHitRate), 6),
        pad(top.slice(0, 40), 40),
      ].join(" "),
    );
  }
  console.log("-".repeat(header.length));
  console.log(
    [
      pad("AGGREGATE", 22),
      pad("-", 9),
      pad(fmt(agg.recallFilesAt5), 8),
      pad(fmt(agg.recallFilesAt10), 9),
      pad(fmt(agg.recallSymbolsAt5), 7),
      pad(fmt(agg.recallSymbolsAt10), 8),
      pad(fmt(agg.contextHitRate), 6),
      "",
    ].join(" "),
  );
  console.log(`questions: ${agg.questions}  failed: ${agg.failed}  recall@10 floor: ${floor}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const all = await loadQuestions(EVALS_DIR);
  const questions = args.project
    ? all.filter((q) => q.projectSlug === args.project)
    : all;
  if (questions.length === 0) {
    const message = `No questions found in ${EVALS_DIR}${args.project ? ` for project "${args.project}"` : ""}`;
    if (args.json) console.log(JSON.stringify({ error: message }, null, 2));
    else console.error(message);
    process.exit(1);
  }

  const results: QuestionResult[] = [];
  for (const q of questions) {
    results.push(await evaluateQuestion(q, args.limit));
  }
  const agg = aggregateResults(results);

  if (args.json) {
    console.log(JSON.stringify({ floor: args.floor, aggregate: agg, questions: results }, null, 2));
  } else {
    printReport(results, agg, args.floor);
  }

  const recall10 = agg.recallFilesAt10;
  const belowFloor = recall10 !== null && recall10 < args.floor;
  const failed = agg.failed > 0;
  if (belowFloor) {
    console.error(`recall@10 ${fmt(recall10)} is below the floor ${args.floor}`);
  }
  if (failed) {
    console.error(`${agg.failed} question(s) could not run (project missing or dependency down?)`);
  }
  if (belowFloor || failed) process.exit(1);
}

void main();