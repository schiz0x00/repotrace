import { z } from "zod";
import { route, json, jsonBody, getParam } from "@/lib/http";
import { requireScopedProject } from "@/lib/api/guard";
import { prisma } from "@/lib/prisma";
import { conflict, notFound } from "@/lib/errors";
import {
  aggregateResults,
  evaluateQuestion,
  K_VALUES,
  type EvalQuestion,
  type QuestionResult,
} from "@/lib/eval/recall";

export const runtime = "nodejs";

/** Questions scored per listing request. Each one is a real search. */
const MAX_SCORED = 50;
const MAX_QUESTIONS = 500;

/**
 * Live searches in flight at once, for one listing request.
 *
 * Every question is a real hybrid search: an outbound embedding call plus
 * several Postgres queries. The questions were previously started with a single
 * `Promise.all` over all fifty, so one GET could put fifty concurrent searches
 * on a single project — a self-inflicted thundering herd from one authenticated
 * request, and a connection-pool queue behind it. Bounded, and small enough
 * that the pool is never asked for more than a few of these at a time.
 */
const SCORING_CONCURRENCY = 4;

/**
 * `map` over `items` with at most `limit` calls in flight, preserving input
 * order. A worker pool rather than a sliding window so at most `limit` promises
 * are ever allocated; results are written by index, so the caller's question
 * order is unchanged.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * What a caller is told when a single question could not be scored.
 *
 * evaluateQuestion catches per-question errors so one bad question cannot take
 * the listing down, but it stores the raw `err.message` in the result — and a
 * search failure carries a Qdrant collection name, a hostname, a connection
 * string fragment or the raw query. Returning it would break the invariant
 * errorBody() enforces for every other failure in this API, so the detail is
 * logged server-side and the response carries a fixed string instead. The
 * message is still useful: the dashboard renders it in place of the top file.
 */
const QUESTION_FAILED = "This question could not be scored.";

/** Replaces a question's internal error message with the stable public one. */
function redactQuestionError(result: QuestionResult): QuestionResult {
  if (!result.error) return result;
  console.error(`[evals:question] ${result.id} failed to score: ${result.error}`);
  return { ...result, error: QUESTION_FAILED };
}

/**
 * GET  /api/v1/projects/:idOrSlug/evals        — questions + live recall@k
 * POST /api/v1/projects/:idOrSlug/evals        — add a question
 *
 * The `eval_question` table existed in the schema and was cascaded on project
 * delete, but nothing ever wrote to or read from it: the offline harness loads
 * JSON files from data/evals instead. That left a project unable to answer the
 * only question that matters for a retrieval product — is this index actually
 * finding the right code?
 */
export async function GET(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const { searchParams } = new URL(req.url);
    const limit = Math.min(50, Math.max(1, Number(searchParams.get("limit")) || 10));

    const db = prisma();
    const [rows, stored] = await Promise.all([
      db.evalQuestion.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: "asc" },
        take: MAX_QUESTIONS,
      }),
      // Counted rather than inferred from `rows.length`, which saturates at
      // MAX_QUESTIONS: a project holding 600 questions reported 50 fewer
      // unscored than it actually had.
      db.evalQuestion.count({ where: { projectId: project.id } }),
    ]);

    const questions: EvalQuestion[] = rows.map((r) => ({
      id: r.id,
      query: r.question,
      expectedFiles: r.expectedFiles,
    }));

    // Scored with the same recallAt the CLI uses, against the live index, so
    // the dashboard and `npm run eval` can never disagree about a number.
    // Redacted on the way out: a per-question failure is reported, but its
    // cause is not.
    const toScore = questions.slice(0, MAX_SCORED);
    const scored = (
      await mapWithConcurrency(toScore, SCORING_CONCURRENCY, (q) =>
        evaluateQuestion(project.id, q, limit),
      )
    ).map(redactQuestionError);
    // The aggregate below is a mean over exactly these questions, so the
    // response now says how many that is: a project with more questions than
    // the cap gets a recall number over the first MAX_SCORED, and a reader of
    // the response has to be able to see that rather than infer it from a
    // missing field.
    const notScored = Math.max(0, stored - scored.length);

    return json({
      questions: scored,
      aggregate: aggregateResults(scored),
      k: K_VALUES,
      /** How many questions were actually scored against the index. */
      scored: scored.length,
      /** How many eval questions the project has stored. */
      total: stored,
      /** Stored questions this request did not score. */
      notScored,
      // Unchanged alias of `notScored`, kept for the documented contract.
      truncated: notScored > 0 ? notScored : undefined,
    });
  })(request, {});
}

const createSchema = z.object({
  question: z.string().min(3).max(500),
  expectedFiles: z.array(z.string().min(1).max(500)).min(1).max(25),
});

export async function POST(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const body = createSchema.parse(await jsonBody(req));

    const db = prisma();
    const existing = await db.evalQuestion.count({ where: { projectId: project.id } });
    if (existing >= MAX_QUESTIONS) {
      throw conflict("eval_limit_reached", `A project may hold at most ${MAX_QUESTIONS} eval questions`);
    }
    const created = await db.evalQuestion.create({
      data: { projectId: project.id, question: body.question, expectedFiles: body.expectedFiles },
    });
    return json({ question: created }, 201);
  })(request, {});
}

export async function DELETE(request: Request, context: { params: Promise<{ idOrSlug: string }> }) {
  return route(async (req) => {
    const { idOrSlug } = await context.params;
    const { project } = await requireScopedProject(req, getParam({ idOrSlug }, "idOrSlug"));
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    if (!id) throw notFound("eval_question_not_found", "Query parameter `id` is required");

    const db = prisma();
    // Scoped by projectId so one project cannot delete another's question.
    const { count } = await db.evalQuestion.deleteMany({ where: { id, projectId: project.id } });
    if (count === 0) throw notFound("eval_question_not_found", "Eval question not found");
    return json({ deleted: true });
  })(request, {});
}
