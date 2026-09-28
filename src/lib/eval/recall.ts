/**
 * Retrieval scoring shared by the offline harness (`scripts/eval.ts`) and the
 * eval API. It used to live only inside the CLI, which self-executes on
 * import, so the dashboard could not report the same numbers the CLI did —
 * and any second implementation would have been free to drift from the first.
 *
 * Two invariants live here because a number that cannot be anything but 1.0 is
 * worse than no number at all — it reads as perfect retrieval:
 *
 *  - A question that states no `expectedSymbols` gets **no** symbol recall at
 *    all, rather than the 1.0 that dividing hits by an empty set produces. The
 *    eval API cannot produce a symbol expectation at all: `eval_question` has
 *    no symbol column, so every stored question arrives with an empty list and
 *    used to report 1.0 at k=5 and k=10 on every question and in the
 *    aggregate. `Aggregate.symbolQuestions` is the denominator for the two
 *    symbol numbers, so a symbol average can be read for what it covers.
 *  - A question's `mode` is validated before it is scored. `searchProject`
 *    falls through to hybrid for any mode it does not recognise while echoing
 *    the string back in its response, so an unrecognised mode used to run a
 *    hybrid search under a report row labelled with whatever the author wrote.
 */

import { buildContextBundle } from "@/lib/search/context";
import { searchProject, type SearchMode } from "@/lib/search/search";

export const K_VALUES = [5, 10] as const;

/**
 * The modes a question may name, checked against the union at compile time so
 * this list cannot fall behind `SearchMode`.
 */
export const SEARCH_MODES = ["hybrid", "lexical", "semantic", "symbol"] as const satisfies
  readonly SearchMode[];

const SEARCH_MODE_SET: ReadonlySet<string> = new Set(SEARCH_MODES);

/** The mode a question with no `mode` is scored as — also searchProject's. */
export const DEFAULT_SEARCH_MODE: SearchMode = "hybrid";

export interface EvalQuestion {
  id: string;
  projectSlug?: string;
  query: string;
  mode?: SearchMode;
  expectedFiles: string[];
  expectedSymbols?: string[];
  notes?: string;
}

export interface QuestionResult {
  id: string;
  query: string;
  mode: SearchMode;
  expectedFiles: string[];
  expectedSymbols: string[];
  recallFiles: Partial<Record<number, number>>;
  recallSymbols: Partial<Record<number, number>>;
  /** null when the caller did not ask for a context bundle; see evaluateQuestion. */
  contextHitRate: number | null;
  topFiles: string[];
  error?: string;
}

export interface Aggregate {
  questions: number;
  failed: number;
  recallFilesAt5: number | null;
  recallFilesAt10: number | null;
  recallSymbolsAt5: number | null;
  recallSymbolsAt10: number | null;
  /**
   * How many questions the two symbol numbers average over. It is smaller than
   * `questions` whenever some question stated no `expectedSymbols` — which,
   * through the API, is every question: the table has no symbol column. Both
   * symbol figures are null when this is 0.
   */
  symbolQuestions: number;
  /** Mean of the per-question context hit rates, or null when none were computed. */
  contextHitRate: number | null;
}

/** One problem found in a question file, addressed the way its author sees it. */
export interface EvalQuestionIssue {
  /** e.g. `data/evals/order.json question 3 -> mode` */
  path: string;
  message: string;
}

export type ParsedEvalQuestion =
  | { ok: true; question: EvalQuestion }
  | { ok: false; issues: EvalQuestionIssue[] };

/** Every field a question may carry. An unknown one is an error, not noise. */
const QUESTION_FIELDS = [
  "id",
  "projectSlug",
  "query",
  "mode",
  "expectedFiles",
  "expectedSymbols",
  "notes",
] as const;

/** Matches POST /api/v1/projects/:idOrSlug/evals, so both paths accept the same fixtures. */
const MAX_EXPECTED_PATHS = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Names a value's type in an error message without echoing an arbitrary blob. */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return JSON.stringify(value);
  return typeof value;
}

/**
 * Reads one expected-path list off a raw question.
 *
 * An empty list is rejected whether or not the field was present, because an
 * empty `expectedSymbols` is exactly the input that used to produce a
 * confident 1.0. Only `expectedFiles` is required: a question may be about a
 * file without naming a symbol.
 */
function readExpectedPaths(
  value: unknown,
  field: "expectedFiles" | "expectedSymbols",
  required: boolean,
  add: (path: string, message: string) => void,
): string[] | undefined {
  if (value === undefined) {
    if (required) add(field, "is required; a question that names no expected file cannot be scored");
    return undefined;
  }
  if (!Array.isArray(value)) {
    add(field, `must be an array of paths, got ${describe(value)}`);
    return undefined;
  }
  if (value.length === 0) {
    // Only an error for the field that cannot be absent. An empty OPTIONAL
    // list is not malformed input — it is how a question says "I care about
    // files, not symbols" — and three of the ten questions in the project's
    // own data/evals/sample.json are written that way, so rejecting it made
    // `npm run eval` fail on the shipped fixture. The 1.0 problem is solved
    // downstream by not scoring symbol recall for a question that named no
    // symbols, not by refusing to load it.
    if (required) {
      add(field, "must hold at least one path; an empty list scores 1.0 against every result set");
    }
    return undefined;
  }
  if (value.length > MAX_EXPECTED_PATHS) {
    add(field, `must hold at most ${MAX_EXPECTED_PATHS} paths, got ${value.length}`);
    return undefined;
  }
  const bad = value.findIndex((v) => !isNonEmptyString(v));
  if (bad !== -1) {
    add(field, `entry ${bad} must be a non-empty string, got ${describe(value[bad])}`);
    return undefined;
  }
  return value as string[];
}

/**
 * Validates one entry of an eval question file.
 *
 * This is the gate the offline harness runs every file through before it
 * touches the database. Two of the checks exist because of what used to
 * happen when they were skipped: an unrecognised `mode` was scored as hybrid
 * while the report printed the string the author wrote (searchProject has no
 * error path for a mode it does not know), and an empty or misspelled
 * expectation list turned into a perfect score rather than a missing one.
 *
 * It returns every problem it finds, not the first: an author fixing a
 * fixture should see the whole list in one run.
 */
export function parseEvalQuestion(raw: unknown, label: string): ParsedEvalQuestion {
  const issues: EvalQuestionIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path: `${label} -> ${path}`, message });

  if (!isRecord(raw)) {
    return { ok: false, issues: [{ path: label, message: `expected a question object, got ${describe(raw)}` }] };
  }

  for (const key of Object.keys(raw)) {
    if (!(QUESTION_FIELDS as readonly string[]).includes(key)) {
      add(
        key,
        `unknown field; a question accepts ${QUESTION_FIELDS.join(", ")} — a misspelled expectation field would be ignored and the question would score as if it had none`,
      );
    }
  }

  if (!isNonEmptyString(raw.id)) add("id", `must be a non-empty string, got ${describe(raw.id)}`);
  if (!isNonEmptyString(raw.projectSlug)) {
    add("projectSlug", `must be a non-empty string naming an indexed project, got ${describe(raw.projectSlug)}`);
  }
  if (!isNonEmptyString(raw.query)) add("query", `must be a non-empty string, got ${describe(raw.query)}`);

  let mode: SearchMode | undefined;
  if (raw.mode !== undefined) {
    if (typeof raw.mode === "string" && SEARCH_MODE_SET.has(raw.mode)) {
      mode = raw.mode as SearchMode;
    } else {
      add(
        "mode",
        `${describe(raw.mode)} is not a search mode; searchProject silently runs any mode it does not recognise as ${DEFAULT_SEARCH_MODE}, so this question would have been scored as ${DEFAULT_SEARCH_MODE} under a report row labelled ${describe(raw.mode)}. Use one of ${SEARCH_MODES.join(", ")}`,
      );
    }
  }

  const expectedFiles = readExpectedPaths(raw.expectedFiles, "expectedFiles", true, add);
  const expectedSymbols = readExpectedPaths(raw.expectedSymbols, "expectedSymbols", false, add);

  let notes: string | undefined;
  if (raw.notes !== undefined) {
    if (typeof raw.notes !== "string") add("notes", `must be a string, got ${describe(raw.notes)}`);
    else notes = raw.notes;
  }

  if (issues.length > 0) return { ok: false, issues };
  // Every field above is only unset when an issue was recorded for it, and
  // there are none.
  return {
    ok: true,
    question: {
      id: raw.id as string,
      projectSlug: raw.projectSlug as string,
      query: raw.query as string,
      mode,
      expectedFiles: expectedFiles as string[],
      expectedSymbols,
      notes,
    },
  };
}

export function normalizePath(p: string): string {
  return p.replace(/^\.\//, "");
}

export function recallAt(retrieved: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 1;
  const top = new Set(retrieved.slice(0, k).map(normalizePath));
  const hits = expected.filter((e) => top.has(normalizePath(e)));
  return hits.length / expected.length;
}

/**
 * A symbol counts as found when the result is it, or a member/parent of it.
 *
 * Returns null — not 1 — when there is nothing to score. The sibling
 * `recallAt` still returns 1 for an empty expectation because its callers
 * guarantee at least one expected file (the API's schema requires one and
 * `parseEvalQuestion` rejects a file without them); symbols are the opposite,
 * optional by design, so the empty case is the common one and is reported as
 * "not measured" rather than "perfectly recalled".
 */
export function symbolHitAt(
  retrieved: Array<string | null>,
  expected: string[],
  k: number,
): number | null {
  if (expected.length === 0) return null;
  const top = retrieved.slice(0, k).filter((s): s is string => !!s);
  const hits = expected.filter((e) =>
    top.some((s) => s === e || s.startsWith(`${e}.`) || e.startsWith(`${s}.`)),
  );
  return hits.length / expected.length;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

/**
 * Runs one question against the live index.
 *
 * `withContext` is off by default and no HTTP surface turns it on. A context
 * bundle costs roughly six extra index round trips per question (a hybrid
 * search plus several symbol and group lookups), and the eval listing route
 * scores up to MAX_SCORED questions per request, so enabling it there would
 * let a single caller-triggered GET amplify into hundreds of index queries.
 *
 * The consequence, stated plainly because the API response makes it easy to
 * misread: on the eval listing route every question reports
 * `contextHitRate: null`, and so does the aggregate. Only the offline harness
 * (`npm run eval` — scripts/eval.ts) passes `true` and produces a real context
 * hit rate. The two surfaces agree on recall@k because they share `recallAt`;
 * they do not both report a context hit rate.
 *
 * For the same reason of honesty, `recallSymbols` comes back empty — with no
 * k keys at all — for any question that states no `expectedSymbols`. The API
 * path always takes that branch, because `eval_question` stores no symbols; a
 * dashboard reading `recallSymbols[5]` gets undefined and renders nothing,
 * where it used to get 1.0 and render a perfect symbol score.
 */
export async function evaluateQuestion(
  projectId: string,
  q: EvalQuestion,
  limit: number,
  withContext = false,
): Promise<QuestionResult> {
  const result: QuestionResult = {
    id: q.id,
    query: q.query,
    mode: q.mode ?? DEFAULT_SEARCH_MODE,
    expectedFiles: q.expectedFiles,
    expectedSymbols: q.expectedSymbols ?? [],
    recallFiles: {},
    recallSymbols: {},
    contextHitRate: null,
    topFiles: [],
  };
  try {
    const search = await searchProject(projectId, q.query, { mode: q.mode, limit });
    const paths = search.items.map((i) => i.path);
    const symbols = search.items.map((i) => i.symbol);
    result.topFiles = unique(paths).slice(0, 10);
    for (const k of K_VALUES) {
      result.recallFiles[k] = recallAt(paths, q.expectedFiles, k);
      // Absent key, not 1: a question with no expected symbols measures nothing.
      const symbolRecall = symbolHitAt(symbols, result.expectedSymbols, k);
      if (symbolRecall !== null) result.recallSymbols[k] = symbolRecall;
    }

    if (withContext && q.expectedFiles.length > 0) {
      const bundle = await buildContextBundle(projectId, q.query, { limit: 8 });
      const bundleFiles = unique([
        ...bundle.symbols.map((s) => s.path),
        ...bundle.docs.map((d) => d.path),
        ...bundle.relatedSymbols.map((r) => r.path),
        ...bundle.tests.map((t) => t.path),
      ]);
      const matched = q.expectedFiles.filter((f) =>
        bundleFiles.some((p) => normalizePath(p) === normalizePath(f)),
      );
      result.contextHitRate = matched.length / q.expectedFiles.length;
    }
  } catch (err) {
    result.error = (err as Error).message;
  }
  return result;
}

export function aggregateResults(results: QuestionResult[]): Aggregate {
  const completed = results.filter((r) => !r.error && Object.keys(r.recallFiles).length > 0);
  const filesAt = (k: number) =>
    completed.map((r) => r.recallFiles[k]).filter((v): v is number => v !== undefined);
  const symbolsAt = (k: number) =>
    completed.map((r) => r.recallSymbols[k]).filter((v): v is number => v !== undefined);
  const ctx = completed.map((r) => r.contextHitRate).filter((v): v is number => v !== null);
  // Counted on k=5 because a question is either scored at every K_VALUE or at
  // none; this is the denominator the two symbol averages are read against.
  const symbolQuestions = completed.filter((r) => r.recallSymbols[K_VALUES[0]] !== undefined).length;
  return {
    questions: results.length,
    failed: results.filter((r) => r.error).length,
    recallFilesAt5: filesAt(5).length ? mean(filesAt(5)) : null,
    recallFilesAt10: filesAt(10).length ? mean(filesAt(10)) : null,
    recallSymbolsAt5: symbolsAt(5).length ? mean(symbolsAt(5)) : null,
    recallSymbolsAt10: symbolsAt(10).length ? mean(symbolsAt(10)) : null,
    symbolQuestions,
    contextHitRate: ctx.length ? mean(ctx) : null,
  };
}
