/**
 * Post-login redirect target validation.
 *
 * `next` arrives from the query string, so login would otherwise be an open
 * redirect. Kept in its own module (rather than inline in the page) so it can
 * be unit tested without pulling the client component tree into the runner.
 */

/**
 * ASCII control characters (C0 + DEL/C1) and any whitespace. Browsers and the
 * Next router strip tabs, newlines and leading spaces from a URL before
 * resolving it, so `/%09//evil.com` — which starts with a single slash and
 * passes a naive prefix check — is delivered to the browser as `//evil.com`
 * and navigates off-origin after sign-in.
 */
const UNSAFE_CHARS = /[\u0000- \u007F-\u009F]/;

/**
 * Only same-origin, single-slash paths are honoured. Anything else falls back
 * to the dashboard root.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (UNSAFE_CHARS.test(raw)) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}
