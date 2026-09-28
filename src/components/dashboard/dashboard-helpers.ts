/**
 * Fetch helpers shared by the dashboard's client components.
 *
 * These live in a plain .ts module (no "use client", no React) because they hold
 * the logic that decides whether a failed request is reported as an error or
 * silently renders as an empty list. Every one of these helpers therefore has to
 * be correct about non-2xx responses and about transport failures, which is
 * exactly the part that is worth unit testing without a DOM.
 */

/** Error envelope every /api/v1 route returns. */
interface ApiErrorBody {
  error?: {
    message?: string
    /** Zod failures carry the offending field and why, per issue. */
    details?: unknown
  }
}

export interface ActionResult {
  ok: boolean
  message?: string
}

/**
 * Best human-readable message for a failed response. The API's own message is
 * preferred because it is specific ("Project not found", "Session expired");
 * `fallback` covers the cases where the body is not JSON at all.
 */
function messageFrom(status: number, body: unknown, fallback?: string): string {
  const message = (body as ApiErrorBody | null)?.error?.message
  if (typeof message === "string" && message.length > 0) return message
  return fallback ?? `Request failed (${status})`
}

/**
 * fetch + JSON with `res.ok` checked, throwing on any non-2xx.
 *
 * Without the check, a 401 or 500 was cast to the success shape and rendered as
 * "no rows" — an expired session looked exactly like an empty project.
 */
export async function getJson<T>(path: string, init?: RequestInit, fallback?: string): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    throw new Error(messageFrom(res.status, await res.json().catch(() => null), fallback))
  }
  return res.json() as Promise<T>
}

/**
 * POST a JSON action and report the outcome. Never rejects: a transport failure
 * is folded into `{ ok: false }` so no caller can end up with an unhandled
 * rejection and a control stuck in its pending state.
 */
export async function postAction(path: string, body?: Record<string, unknown>): Promise<ActionResult> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    })
    if (!res.ok) {
      return { ok: false, message: messageFrom(res.status, await res.json().catch(() => null), "Request failed.") }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

/** Queue a project deletion. Same no-reject contract as {@link postAction}. */
export async function deleteProject(slug: string): Promise<ActionResult> {
  try {
    const res = await fetch(`/api/v1/projects/${slug}`, { method: "DELETE" })
    if (!res.ok) {
      return { ok: false, message: messageFrom(res.status, await res.json().catch(() => null), "Delete failed.") }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

/**
 * Message for a failed response, including the field-level detail a 400
 * carries.
 *
 * A rejected request the operator cannot act on is barely better than a
 * swallowed one: `validation_failed` alone does not say which field the server
 * refused or why, so the obvious reaction is to retry the same payload. The
 * first few issues are appended, bounded so a pathological body cannot flood
 * the alert.
 */
export function apiErrorMessage(body: unknown, status: number, fallback?: string): string {
  const base = messageFrom(status, body, fallback)
  const details = (body as ApiErrorBody | null)?.error?.details
  if (!Array.isArray(details) || details.length === 0) return base
  const issues = details.slice(0, 5).map((entry) => {
    const issue = entry as { path?: unknown; message?: unknown }
    const path = typeof issue.path === "string" && issue.path.length > 0 ? `${issue.path}: ` : ""
    const message = typeof issue.message === "string" ? issue.message : "invalid value"
    return `${path}${message}`
  })
  return `${base} — ${issues.join("; ")}`
}

/**
 * Monotonic request gate.
 *
 * A component that fires a request per keystroke, per filter change or on a
 * timer can receive those responses out of order: a slow request for "src/"
 * lands after a fast one for "src/app" and repopulates the view with results
 * for a filter the user has already typed past. Counting requests and applying
 * only the newest response makes the newest request win, whatever order the
 * responses arrive in.
 *
 * Kept as a plain factory (not a hook) so it can be unit tested without React.
 */
export interface RequestGate {
  /** Start a request and get its id. */
  next(): number
  /** True while `id` is the most recently started request. */
  isCurrent(id: number): boolean
}

export function createRequestGate(): RequestGate {
  let latest = 0
  return {
    next: () => ++latest,
    isCurrent: (id: number) => id === latest,
  }
}

/**
 * Which project the search page should preselect.
 *
 * `current` is the value already in state (the `?project=` parameter, or a
 * choice the user has since made), so a non-empty value always wins — the
 * default must never overwrite a real selection.
 */
export function pickDefaultProject(current: string, projects: { slug: string }[]): string {
  return current || projects[0]?.slug || ""
}
