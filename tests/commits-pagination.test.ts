import { describe, expect, it } from "vitest";
import {
  commitCursorWhere as restCursorWhere,
  encodeCommitCursor as restEncodeCursor,
  finalizeCommitPage,
  parseCommitCursor as restParseCursor,
} from "@/lib/commits/cursor";
import { commitPageHint } from "@/lib/mcp/server";
import { AppError } from "@/lib/errors";

/**
 * Commit keyset pagination.
 *
 * The REST route and the MCP `list_commits` tool used to carry verbatim
 * duplicates of `encodeCommitCursor` / `parseCommitCursor` / `commitCursorWhere`,
 * justified by an app/lib layering argument that was never true — both live in
 * `src/lib` — and guarded by parity tests that only proved a function equalled
 * itself. There is now one implementation, in `@/lib/commits/cursor`, imported
 * by both, so these tests exercise it directly instead of diffing two copies
 * that can no longer drift.
 *
 * `finalizeCommitPage` (REST) and `commitPageHint` (MCP) stay separate on
 * purpose: the MCP tool takes exactly `limit` rows and cannot prove the history
 * ended, so it always hints on a full page, while the REST route over-fetches
 * by one and can return `nextBefore: null` at the true end.
 */

interface Commit {
  repositoryId: string;
  sha: string;
  author: string;
  message: string;
  authoredAt: Date;
}

const REPO = "repo_1";
const OTHER_REPO = "repo_2";

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second));

function commit(sha: string, second: number, repositoryId = REPO): Commit {
  return {
    repositoryId,
    sha,
    author: "dev",
    message: `commit ${sha}`,
    authoredAt: at(second),
  };
}

/**
 * A history built to break a timestamp-only cursor: three commits share the
 * newest instant (a rebase or a merge landing several commits in one second),
 * two share another, and a commit from another repository must never surface.
 */
const HISTORY: Commit[] = [
  commit("a3a3a3a", 10),
  commit("b2b2b2b", 10),
  commit("c1c1c1c", 10),
  commit("d4d4d4d", 9),
  commit("e5e5e5e", 8),
  commit("f6f6f6f", 8),
  commit("07abcde", 7),
  commit("1111111", 6, OTHER_REPO),
  commit("0000000", 5, OTHER_REPO),
];

/** The order the query asks for: newest first, ties broken by descending sha. */
const EXPECTED = ["c1c1c1c", "b2b2b2b", "a3a3a3a", "d4d4d4d", "f6f6f6f", "e5e5e5e", "07abcde"];

type Scalar = string | Date;
type Condition = Scalar | { lt?: Scalar; gt?: Scalar } | { OR: Condition[] };

function matchesScalar(value: Scalar, expected: Scalar): boolean {
  return value instanceof Date && expected instanceof Date
    ? value.getTime() === expected.getTime()
    : value === expected;
}

function compare(a: Scalar, b: Scalar): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function matchesCondition(value: Scalar, condition: Condition): boolean {
  if (condition instanceof Date || typeof condition === "string") {
    return matchesScalar(value, condition);
  }
  if ("OR" in condition) return condition.OR.some((c) => matchesCondition(value, c));
  if (condition.lt !== undefined) return compare(value, condition.lt) < 0;
  if (condition.gt !== undefined) return compare(value, condition.gt) > 0;
  throw new Error(`unsupported condition: ${JSON.stringify(condition)}`);
}

function matches(row: Commit, where: Record<string, unknown>): boolean {
  for (const [field, condition] of Object.entries(where)) {
    if (field === "repositoryId") {
      if (row.repositoryId !== condition) return false;
      continue;
    }
    if (field === "OR") {
      const clauses = condition as Record<string, unknown>[];
      if (!clauses.some((clause) => matches(row, clause))) return false;
      continue;
    }
    if (!matchesCondition(row[field as "sha"], condition as Condition)) return false;
  }
  return true;
}

/** Stands in for `prisma().commit.findMany({ where, orderBy, take })`. */
function queryCommits(
  where: Record<string, unknown>,
  take: number,
  history: Commit[] = HISTORY,
): Commit[] {
  return history
    .filter((row) => matches(row, where))
    .sort((a, b) => b.authoredAt.getTime() - a.authoredAt.getTime() || (a.sha < b.sha ? 1 : -1))
    .slice(0, take);
}

describe("commit cursor encoding", () => {
  it("round-trips a timestamp and a sha", () => {
    const cursor = restParseCursor(restEncodeCursor(commit("a3a3a3a", 10)));
    expect(cursor.at.toISOString()).toBe(at(10).toISOString());
    expect(cursor.sha).toBe("a3a3a3a");
  });


  it("tolerates surrounding whitespace from a copy-pasted cursor", () => {
    const cursor = restParseCursor(`  ${at(9).toISOString()}|d4d4d4d\n`);
    expect(cursor.sha).toBe("d4d4d4d");
  });

  it("still accepts a bare ISO-8601 timestamp, but marks it as lossy", () => {
    const cursor = restParseCursor(at(9).toISOString());
    expect(cursor.at.toISOString()).toBe(at(9).toISOString());
    expect(cursor.sha).toBeNull();
  });

  it("rejects a cursor that is not a timestamp with a 400", () => {
    for (const bad of ["", "not-a-date", "abc|def", "|d4d4d4d"]) {
      const err = (() => {
        try {
          restParseCursor(bad);
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err, `expected ${JSON.stringify(bad)} to be rejected`).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(400);
      expect((err as AppError).code).toBe("invalid_cursor");
    }
  });

  it("rejects a malformed sha component", () => {
    expect(() => restParseCursor(`${at(9).toISOString()}|zzzz`)).toThrow(AppError);
    expect(() => restParseCursor(`${at(9).toISOString()}|ab`)).toThrow(AppError);
  });
});

describe("commitCursorWhere", () => {
  it("keeps the repository filter alongside the cursor clause", () => {
    const where = restCursorWhere(restParseCursor(restEncodeCursor(commit("c1c1c1c", 10))));
    expect(where.OR).toEqual([
      { authoredAt: { lt: at(10) } },
      { authoredAt: at(10), sha: { lt: "c1c1c1c" } },
    ]);
  });

  // A bare timestamp cannot address the commits sharing its instant, so it must
  // degrade to "strictly older" rather than pretending to be a composite.
  it("treats a bare-timestamp cursor as strictly older", () => {
    const where = restCursorWhere({ at: at(10), sha: null });
    expect(where).toEqual({ authoredAt: { lt: at(10) } });
  });
});

describe("REST commit pagination", () => {
  /** Walks the whole history the way a client would, page by page. */
  function walk(limit: number): string[][] {
    const pages: string[][] = [];
    let before: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const where: Record<string, unknown> = { repositoryId: REPO };
      if (before) Object.assign(where, restCursorWhere(restParseCursor(before)));
      const rows = queryCommits(where, limit + 1);
      const page = finalizeCommitPage(rows, limit);
      pages.push(page.commits.map((c) => c.sha));
      if (!page.nextBefore) return pages;
      before = page.nextBefore;
    }
    throw new Error("pagination did not terminate");
  }

  it("returns every commit exactly once, with none lost to a shared timestamp", () => {
    for (const limit of [1, 2, 3, 4, 7, 8, 100]) {
      const pages = walk(limit);
      const seen = pages.flat();
      expect(seen, `limit=${limit}`).toEqual(EXPECTED);
      expect(new Set(seen).size, `limit=${limit}`).toBe(seen.length);
    }
  });

  it("straddles the three-way timestamp tie when the page breaks inside it", () => {
    // limit 2 cuts between "b2b2b2b" and "c1c1c1c", the exact boundary the
    // timestamp-only cursor used to get wrong.
    const pages = walk(2);
    expect(pages[0]).toEqual(["c1c1c1c", "b2b2b2b"]);
    expect(pages[1]).toEqual(["a3a3a3a", "d4d4d4d"]);
  });

  it("emits a cursor only when the over-fetched window proves there is more", () => {
    const where = { repositoryId: REPO };
    // limit 2: the window takes 3 rows, so a cursor is warranted...
    const first = finalizeCommitPage(queryCommits(where, 3), 2);
    expect(first.commits.map((c) => c.sha)).toEqual(["c1c1c1c", "b2b2b2b"]);
    expect(first.nextBefore).not.toBeNull();
    // ...and the final window comes back short, which ends the walk. A cursor
    // here would send the client round for a page that can never arrive.
    const tail = finalizeCommitPage(
      queryCommits({ ...where, ...restCursorWhere(restParseCursor(restEncodeCursor(commit("f6f6f6f", 8)))) }, 3),
      2,
    );
    expect(tail.commits.map((c) => c.sha)).toEqual(["e5e5e5e", "07abcde"]);
    expect(tail.nextBefore).toBeNull();
  });

  it("returns an empty page rather than a dangling cursor", () => {
    const page = finalizeCommitPage([], 25);
    expect(page.commits).toEqual([]);
    expect(page.nextBefore).toBeNull();
  });

  it("stays scoped to the resolved project's repository", () => {
    // Two other tenants' commits share every timestamp; none may appear.
    const where: Record<string, unknown> = { repositoryId: REPO };
    Object.assign(where, restCursorWhere(restParseCursor(restEncodeCursor(commit("a3a3a3a", 10)))));
    const shas = queryCommits(where, 50).map((c) => c.sha);
    expect(shas).not.toContain("1111111");
    expect(shas).not.toContain("0000000");
  });
});

describe("legacy timestamp-only cursor", () => {
  it("is the defect the composite cursor fixed: it drops same-instant commits", () => {
    // Regression witness. If this ever starts passing, the composite clause has
    // been weakened somewhere it should not have been.
    const cursor = restParseCursor(at(10).toISOString());
    const where: Record<string, unknown> = { repositoryId: REPO, ...restCursorWhere(cursor) };
    const shas = queryCommits(where, 50).map((c) => c.sha);
    expect(shas).toEqual(["d4d4d4d", "f6f6f6f", "e5e5e5e", "07abcde"]);
    expect(shas).not.toContain("c1c1c1c");
  });
});

describe("MCP list_commits paging", () => {
  /** Walks the whole history the way an agent would, following the hint line. */
  function walk(limit: number): string[][] {
    const pages: string[][] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const where: Record<string, unknown> = { repositoryId: REPO };
      if (before) Object.assign(where, restCursorWhere(restParseCursor(before)));
      const rows = queryCommits(where, limit);
      pages.push(rows.map((c) => c.sha));
      const hint = commitPageHint(rows, limit);
      if (!hint) return pages;
      // The cursor is the only thing after `before=` up to the closing bracket;
      // an agent copies it verbatim, so the walk must too.
      before = hint.slice(hint.indexOf("before=") + "before=".length, -1);
    }
    throw new Error("pagination did not terminate");
  }

  it("offers no hint on a short page", () => {
    expect(commitPageHint(HISTORY.slice(0, 2), 25)).toBeNull();
  });

  it("offers a composite cursor on a full page", () => {
    // Ordered as the query returns them, so the last row is the oldest of the
    // page and is the one the cursor has to point after.
    const rows = queryCommits({ repositoryId: REPO }, 3);
    const hint = commitPageHint(rows, 3)!;
    expect(hint).toBe(
      `[more commits may exist; call again with before=${at(10).toISOString()}|a3a3a3a]`,
    );
  });

  it("returns every commit exactly once, with none lost to a shared timestamp", () => {
    for (const limit of [1, 2, 3, 4, 7, 8, 100]) {
      const seen = walk(limit).flat();
      expect(seen, `limit=${limit}`).toEqual(EXPECTED);
      expect(new Set(seen).size, `limit=${limit}`).toBe(seen.length);
    }
  });
});
