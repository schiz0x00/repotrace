import { badRequest } from "@/lib/errors";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Keyset pagination for commit history.
 *
 * This is the single implementation. `encodeCommitCursor`, `parseCommitCursor`
 * and `commitCursorWhere` were previously duplicated verbatim into the MCP
 * server so the REST route and the `list_commits` tool could each have their
 * own copy, on the stated grounds that the two callers sat on opposite sides
 * of the app/lib boundary. They did not: both are in `src/lib`, and one of
 * them could simply import the other. Two copies of a pagination cursor is two
 * chances to page the same history differently, and the parity tests that
 * guarded them only proved a function equalled itself.
 *
 * `finalizeCommitPage` is deliberately not shared: the MCP tool takes exactly
 * `limit` rows and cannot prove the history ended, so it always emits a hint on
 * a full page (`commitPageHint`). Only the REST route over-fetches by one row,
 * which is what lets it return `nextBefore: null` at the true end of the
 * history instead of sending a client for a page that cannot exist.
 */

/** Separates the two halves of a cursor. A git sha is hex, so it cannot collide. */
const CURSOR_SEPARATOR = "|";

/** Git object names are hex; a cursor is only ever built from a stored sha. */
const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

/**
 * A keyset cursor into commit history.
 *
 * `sha` is null only for a legacy bare-timestamp cursor (see
 * `parseCommitCursor`); every cursor this module hands out carries one.
 */
export interface CommitCursor {
  /** Authored-at instant of the last commit already returned to the caller. */
  at: Date;
  /** The sha that broke the tie on `at`; null for a bare-timestamp cursor. */
  sha: string | null;
}

export function encodeCommitCursor(row: { sha: string; authoredAt: Date }): string {
  return `${row.authoredAt.toISOString()}${CURSOR_SEPARATOR}${row.sha}`;
}

/**
 * Parses a `before` cursor.
 *
 * The composite form is `<ISO-8601>|<sha>`, and it is the only form the API
 * hands out. A bare ISO-8601 timestamp is still accepted, because it is what
 * clients written against the older timestamp-only API send, but it is lossy: it
 * cannot address the commits that share its exact instant. That is accepted
 * silently rather than rejected, since a cursor is a machine-issued opaque token
 * and refusing the old one would break those clients mid-rollout.
 */
export function parseCommitCursor(raw: string): CommitCursor {
  const value = raw.trim();
  const separator = value.indexOf(CURSOR_SEPARATOR);
  const timestamp = separator === -1 ? value : value.slice(0, separator);
  const sha = separator === -1 ? null : value.slice(separator + 1);
  const at = new Date(timestamp);
  if (!timestamp || !Number.isFinite(at.getTime())) {
    throw badRequest(
      "invalid_cursor",
      "`before` must be a commit cursor: an ISO-8601 timestamp and a sha separated by `|`",
    );
  }
  if (sha !== null && !SHA_PATTERN.test(sha)) {
    throw badRequest("invalid_cursor", "`before` has a malformed sha component");
  }
  return { at, sha };
}

/**
 * Rows strictly after the cursor in the (authoredAt DESC, sha DESC) order the
 * query uses.
 *
 * Filtering on `authoredAt` alone was the bug: two commits with the same
 * authored-at — a bulk commit, a rebase, a merge landing several commits in one
 * second — straddle the boundary and every one of them equal to it is dropped
 * from the next page, with no error to show for it. `sha` is unique per
 * repository (`@@unique([repositoryId, sha])`), so pairing it with the
 * timestamp makes the order total and the boundary exact. The equality branch
 * compares a DateTime, which round-trips exactly because Prisma stores it as
 * `timestamp(3)` — the same millisecond precision `toISOString` emits.
 */
export function commitCursorWhere(cursor: CommitCursor): Prisma.CommitWhereInput {
  if (cursor.sha === null) {
    // Bare-timestamp cursor: strictly older, which can skip same-instant commits.
    return { authoredAt: { lt: cursor.at } };
  }
  return {
    OR: [
      { authoredAt: { lt: cursor.at } },
      { authoredAt: cursor.at, sha: { lt: cursor.sha } },
    ],
  };
}

/**
 * Splits an over-fetched window (limit + 1 rows) into the page and the cursor
 * that continues it.
 *
 * A cursor is only returned when there really is another page. Returning one at
 * the end of the history would send an agent looping on empty pages forever.
 */
export function finalizeCommitPage<T extends { sha: string; authoredAt: Date }>(
  rows: readonly T[],
  limit: number,
): { commits: T[]; nextBefore: string | null } {
  const hasMore = rows.length > limit;
  const commits = rows.slice(0, limit);
  const last = commits[commits.length - 1];
  return {
    commits,
    nextBefore: hasMore && last ? encodeCommitCursor(last) : null,
  };
}
