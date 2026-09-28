import "dotenv/config";

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { requireProject } from "@/lib/search/search";
import {
  aggregateResults,
  DEFAULT_SEARCH_MODE,
  evaluateQuestion,
  parseEvalQuestion,
  type Aggregate,
  type EvalQuestion,
  type EvalQuestionIssue,
  type QuestionResult,
} from "@/lib/eval/recall";

const EVALS_DIR = "data/evals";

const DEFAULT_LIMIT = 10;
const DEFAULT_FLOOR = 0.5;

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

/**
 * Reads every `*.json` under `dir` and returns the questions plus every problem
 * found in them.
 *
 * The problems are returned rather than thrown and the problems are collected
 * rather than raised at the first one: the caller reports all of them and
 * refuses to score anything, so a fixture with a typo cannot be half-run. The
 * two failures this replaced were both silent — an unrecognised `mode` ran as
 * hybrid under a row labelled with the author's string, and a file with no
 * `questions` key (or a misspelled `expectedFile`) loaded zero questions and
 * looked like an empty directory.
 */
async function loadQuestions(dir: string): Promise<{ questions: EvalQuestion[]; issues: EvalQuestionIssue[] }> {
  const entries = (await readdir(dir).catch(() => []))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const questions: EvalQuestion[] = [];
  const issues: EvalQuestionIssue[] = [];

  for (const name of entries) {
    const file = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      issues.push({ path: file, message: `is not valid JSON: ${(err as Error).message}` });
      continue;
    }

    let list: unknown[];
    if (Array.isArray(parsed)) {
      list = parsed;
    } else if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { questions?: unknown }).questions)) {
      list = (parsed as { questions: unknown[] }).questions;
    } else {
      issues.push({
        path: file,
        message: 'must be a JSON array of questions, or an object with a "questions" array',
      });
      continue;
    }

    for (const [index, entry] of list.entries()) {
      const result = parseEvalQuestion(entry, `${file} question ${index + 1}`);
      if (result.ok) questions.push(result.question);
      else issues.push(...result.issues);
    }
  }

  return { questions, issues };
}

function reportIssues(issues: EvalQuestionIssue[], json: boolean): void {
  const message = [
    `${issues.length} problem(s) in the question files; nothing was scored:`,
    ...issues.map((i) => `  ${i.path} ${i.message}`),
  ].join("\n");
  if (json) console.log(JSON.stringify({ error: message, issues }, null, 2));
  else console.error(message);
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
  // The symbol columns average only the questions that stated expectedSymbols.
  // Without this line a 1.000 there is indistinguishable from "nothing to score".
  if (agg.symbolQuestions < agg.questions - agg.failed) {
    console.log(
      `symbol recall averages the ${agg.symbolQuestions} question(s) that state expectedSymbols; the rest report no symbol score.`,
    );
  }
  console.log(
    `questions: ${agg.questions}  failed: ${agg.failed}  symbol-scored: ${agg.symbolQuestions}  recall@10 floor: ${floor}`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { questions: all, issues } = await loadQuestions(EVALS_DIR);
  if (issues.length > 0) {
    reportIssues(issues, args.json);
    process.exit(1);
  }
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
    // Resolve the project here so a missing one is recorded as a per-question
    // failure — the run reports it and exits non-zero — rather than aborting.
    const project = await requireProject(q.projectSlug as string).catch(() => null);
    if (!project) {
      results.push({
        id: q.id,
        query: q.query,
        mode: q.mode ?? DEFAULT_SEARCH_MODE,
        expectedFiles: q.expectedFiles,
        expectedSymbols: q.expectedSymbols ?? [],
        recallFiles: {},
        recallSymbols: {},
        contextHitRate: null,
        topFiles: [],
        error: `project "${q.projectSlug}" not found`,
      });
      continue;
    }
    // The CLI reports a context hit rate, so it opts into the slower bundle.
    results.push(await evaluateQuestion(project.id, q, args.limit, true));
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