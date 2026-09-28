/**
 * Dependency-free throttle for failed sign-in attempts.
 *
 * Scope warning: the counters live in this process's memory. That is enough to
 * slow a single-host deployment (and to blunt credential stuffing against one
 * instance) but it is NOT a shared store — behind a load balancer each instance
 * keeps its own counters, so an attacker gets the full free budget per replica,
 * and a restart clears the history. A multi-instance deployment needs Redis
 * (already a dependency via BullMQ) or an edge/WAF rate limiter; this is
 * deliberately not built here because it would change the deployment topology.
 *
 * Counters are cached on globalThis so `next dev` hot reloads do not hand every
 * visitor a fresh allowance.
 *
 * Three independent scopes are counted, and a request is refused as soon as any
 * one of them is locked:
 *
 *  - `account` — keyed on the email alone, and AUTHORITATIVE. It is what makes
 *    the protection accumulate: an attacker who rotates `X-Forwarded-For` to
 *    dodge the address key still spends the account's budget, because this key
 *    does not contain the address. (An earlier version keyed only on the
 *    `ip|email` conjunction, so a fresh header per request bought a fresh
 *    budget and the per-account protection never accumulated at all.)
 *  - `pair` — the original `ip|email` key. Redundant for protection once
 *    `account` and `address` exist, but kept as the default scope for callers
 *    that only hold a composite key, and it is the only scope available for a
 *    request that names no account (social sign-in, unparseable body).
 *  - `address` — keyed on the client address alone. This is an ADDITIONAL bound
 *    on a single host spraying many accounts; it is NOT trusted for the
 *    per-account lockout, because the address is attacker-chosen (see
 *    `clientIp`). It is deliberately much more forgiving than the account
 *    budget because a shared egress NAT (an office, CI, a mobile carrier's
 *    CGNAT pool) concentrates many honest users behind one address.
 */

export interface ThrottleEntry {
  /** Consecutive failed attempts, reset after IDLE_RESET_MS without a failure. */
  failures: number;
  /** Epoch ms until which sign-in is refused; 0 when not locked. */
  lockedUntil: number;
  /** Epoch ms of the most recent failure, used for the idle reset. */
  lastFailureAt: number;
}

export type ThrottleStore = Map<string, ThrottleEntry>;

/** A scope's budget: how many failures are free and how the lockout grows. */
export interface ThrottlePolicy {
  /** Failures allowed before the scope starts locking. */
  freeAttempts: number;
  /** Lockout armed by the first lockable failure. */
  baseDelayMs: number;
  /** Ceiling on the exponential backoff. */
  maxDelayMs: number;
}

/** Failed attempts allowed before the key starts being locked out. */
export const FREE_ATTEMPTS = 3;
/** Lockout after the first lockable failure; doubles per further failure. */
export const BASE_DELAY_MS = 1_000;
/** Ceiling on the exponential backoff. */
export const MAX_DELAY_MS = 15 * 60_000;
/** A key that sees no failure for this long is treated as clean. */
export const IDLE_RESET_MS = 60 * 60_000;

/**
 * The address budget is an order of magnitude looser than the account budget on
 * purpose: it only has to bound how fast one host can spray across *different*
 * accounts, and tightening it to match FREE_ATTEMPTS would let a single typoing
 * user lock out everyone behind the same NAT. The cost of these numbers is
 * explicit — a shared egress that sees 50 failed sign-ins within an hour locks
 * itself out for 30s, doubling up to 15 minutes. Deployments that terminate
 * traffic at a proxy they control should raise ADDRESS_FREE_ATTEMPTS to
 * something like their largest concurrent user count.
 */
export const ADDRESS_FREE_ATTEMPTS = 50;
export const ADDRESS_BASE_DELAY_MS = 30_000;
export const ADDRESS_MAX_DELAY_MS = 15 * 60_000;

export const ACCOUNT_POLICY: ThrottlePolicy = {
  freeAttempts: FREE_ATTEMPTS,
  baseDelayMs: BASE_DELAY_MS,
  maxDelayMs: MAX_DELAY_MS,
};

export const ADDRESS_POLICY: ThrottlePolicy = {
  freeAttempts: ADDRESS_FREE_ATTEMPTS,
  baseDelayMs: ADDRESS_BASE_DELAY_MS,
  maxDelayMs: ADDRESS_MAX_DELAY_MS,
};

/**
 * Hard ceiling on distinct keys held in memory. Both the email and the address
 * are attacker-chosen, so without a ceiling a spray across fresh addresses or
 * fresh emails grows this Map until the process dies. Bounded memory wins over
 * perfect accounting: at the ceiling the least-recently-failed unlocked key is
 * dropped, which does hand an attacker who can flood 10k distinct keys a way to
 * clear an existing lockout. Reaching the ceiling at all costs 10k password
 * checks on our side, which is the more expensive attack.
 */
export const MAX_STORE_KEYS = 10_000;

/**
 * Longest email honoured as an account key. Addresses longer than this cannot
 * match a real row (the column is a 320-char bound in practice) so they are
 * treated as "no account" rather than allowed to become an unbounded map key.
 */
export const MAX_EMAIL_LENGTH = 320;

/** Sign-in endpoints, both email and social. */
const SIGN_IN_PATH = /\/sign-in(\/|$)/;

export function isSignInPath(pathname: string): boolean {
  return SIGN_IN_PATH.test(pathname);
}

declare global {
  var __repotraceLoginThrottle: ThrottleStore | undefined;
}

export function loginThrottleStore(): ThrottleStore {
  globalThis.__repotraceLoginThrottle ??= new Map();
  return globalThis.__repotraceLoginThrottle;
}

/**
 * Best-effort client address. `x-forwarded-for` is only trustworthy when a
 * proxy in front of the app strips inbound copies of it — otherwise an attacker
 * picks their own key. There is no "trusted proxy" setting in the env schema to
 * check against, so this is documented rather than enforced, and the account
 * scope (not this one) is what carries the per-account lockout.
 *
 * A value that is not a plausible IPv4/IPv6 literal is folded into the shared
 * `"unknown"` bucket rather than used verbatim: that keeps an attacker from
 * minting unlimited distinct address keys with junk header values.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first && isPlausibleIp(first)) return first;
  }
  const real = headers.get("x-real-ip")?.trim();
  if (real && isPlausibleIp(real)) return real;
  return "unknown";
}

function isPlausibleIp(value: string): boolean {
  if (value.length < 3 || value.length > 45) return false;
  if (!/^[0-9a-fA-F:.]+$/.test(value)) return false;
  // Require a separator so a bare hex word ("deadbeef") is not treated as a host.
  return value.includes(".") || value.includes(":");
}

/** Lowercased and length-bounded so a huge body field cannot become a map key. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase().slice(0, MAX_EMAIL_LENGTH);
}

/**
 * The pair scope's key: address and account together. The email is lowercased
 * because addresses are matched case-insensitively; the IP is included
 * verbatim. This key is NOT what decides a lockout (see the module header) — it
 * is the scope available when no account was named, and the default for callers
 * that only hold a composite key.
 */
export function throttleKey(ip: string, email: string | null): string {
  return `${ip}|${email === null ? "" : normalizeEmail(email)}`;
}

/** The address's own key, used to bound spraying across many accounts. */
export function addressThrottleKey(ip: string): string {
  return `address:${ip}`;
}

/** The account's own key, which does not contain the (attacker-chosen) address. */
export function accountThrottleKey(email: string | null): string | null {
  if (email === null) return null;
  const normalized = normalizeEmail(email);
  return normalized ? `account:${normalized}` : null;
}

/**
 * Everything the throttle counts a request against. A bare string is accepted
 * as a pair-only target so callers holding nothing but a composite key keep
 * working; the sign-in route always passes a full target.
 */
export interface ThrottleTarget {
  /** `ip|email`. */
  pair: string;
  /** `address:ip`, or null when only a composite key is known. */
  address: string | null;
  /** `account:email`, or null when the request named no account. */
  account: string | null;
}

export function throttleTarget(ip: string, email: string | null): ThrottleTarget {
  return { pair: throttleKey(ip, email), address: addressThrottleKey(ip), account: accountThrottleKey(email) };
}

function toTarget(key: string | ThrottleTarget): ThrottleTarget {
  return typeof key === "string" ? { pair: key, address: null, account: null } : key;
}

export type ThrottleScope = "account" | "pair" | "address";

/** Account first: it is the authoritative budget. */
function activeScopes(target: ThrottleTarget): [ThrottleScope, string, ThrottlePolicy][] {
  const scopes: [ThrottleScope, string, ThrottlePolicy][] = [];
  if (target.account !== null) scopes.push(["account", target.account, ACCOUNT_POLICY]);
  scopes.push(["pair", target.pair, ACCOUNT_POLICY]);
  if (target.address !== null) scopes.push(["address", target.address, ADDRESS_POLICY]);
  return scopes;
}

/** Lockout duration for a failure count: 0 while still within the free budget. */
export function backoffMs(failures: number, policy: ThrottlePolicy = ACCOUNT_POLICY): number {
  if (failures <= policy.freeAttempts) return 0;
  const exponent = failures - policy.freeAttempts - 1;
  return Math.min(policy.baseDelayMs * Math.pow(2, exponent), policy.maxDelayMs);
}

/** Whole seconds remaining on a lock, never rounded down to 0. */
export function retryAfterSeconds(lockedUntil: number, now: number): number {
  return Math.max(1, Math.ceil((lockedUntil - now) / 1000));
}

export interface ThrottleVerdict {
  allowed: boolean;
  /**
   * Which scope refused, or null when the request may proceed. Server-side
   * only: it is deliberately NOT communicated to the client, because telling a
   * caller that it is throttled is what makes the throttle observable (see
   * `FailureEnvelope`).
   */
  scope: ThrottleScope | null;
  retryAfterSeconds: number;
}

export function checkLoginThrottle(store: ThrottleStore, key: string | ThrottleTarget, now: number): ThrottleVerdict {
  for (const [scope, k] of activeScopes(toTarget(key))) {
    const entry = store.get(k);
    if (!entry) continue;
    // Idle keys are dropped rather than kept: the map is only ever read on the
    // sign-in path, so an expired key costs nothing until someone retries.
    if (entry.lockedUntil <= now && now - entry.lastFailureAt > IDLE_RESET_MS) {
      store.delete(k);
      continue;
    }
    if (entry.lockedUntil > now) {
      return { allowed: false, scope, retryAfterSeconds: retryAfterSeconds(entry.lockedUntil, now) };
    }
  }
  return { allowed: true, scope: null, retryAfterSeconds: 0 };
}

export function recordLoginFailure(store: ThrottleStore, key: string | ThrottleTarget, now: number): void {
  for (const [, k, policy] of activeScopes(toTarget(key))) {
    reserveSlot(store, now);
    const previous = store.get(k);
    const stale = !previous || now - previous.lastFailureAt > IDLE_RESET_MS;
    const failures = (stale ? 0 : previous.failures) + 1;
    // Re-insert so the key's position in the Map's insertion order tracks its
    // most recent failure; `reserveSlot` evicts from the front.
    store.delete(k);
    store.set(k, { failures, lockedUntil: now + backoffMs(failures, policy), lastFailureAt: now });
  }
}

/**
 * A successful sign-in clears the account's budget, and the pair budget for the
 * address it came from. It does NOT clear the address budget: one honest
 * success says nothing about the other accounts the same host is guessing, and
 * clearing it would let an attacker holding any single valid account reset the
 * volume bound. The address budget decays on IDLE_RESET_MS instead.
 */
export function clearLoginFailures(store: ThrottleStore, key: string | ThrottleTarget): void {
  const target = toTarget(key);
  store.delete(target.pair);
  if (target.account !== null) store.delete(target.account);
}

/**
 * How much of the shared address budget a successful sign-in pays back.
 *
 * The address scope is what bounds a spray across many accounts from one host,
 * and it deliberately does NOT clear on success: an attacker who holds any one
 * valid account could otherwise authenticate repeatedly and erase the bound.
 *
 * But never crediting it at all is its own problem. The address is shared by
 * everyone behind a NAT or a corporate proxy, so 50 legitimate typos across an
 * office in an hour walked everyone into an escalating lockout that no honest
 * sign-in could lift — one user's mistyped password locking out their
 * colleagues, with nothing to do about it.
 *
 * Crediting a fixed amount resolves both. An attacker cannot authenticate, so
 * they never earn credit and the bound holds against them exactly as before.
 * Legitimate traffic repays the shared budget as it is used, so an office that
 * is not under attack never accumulates one.
 */
export const ADDRESS_SUCCESS_CREDIT = 5;

export function creditAddressOnSuccess(
  store: ThrottleStore,
  key: string | ThrottleTarget,
): void {
  const target = toTarget(key);
  if (target.address === null) return;
  const entry = store.get(target.address);
  if (!entry) return;
  const failures = entry.failures - ADDRESS_SUCCESS_CREDIT;
  if (failures <= ADDRESS_FREE_ATTEMPTS) {
    store.delete(target.address);
    return;
  }
  store.set(target.address, { ...entry, failures });
}

/** Drops keys that are neither locked nor recent. Keeps the map from growing without bound. */
export function pruneThrottle(store: ThrottleStore, now: number): void {
  for (const [key, entry] of store) {
    if (entry.lockedUntil <= now && now - entry.lastFailureAt > IDLE_RESET_MS) store.delete(key);
  }
}

/**
 * A full sweep is O(keys), and every key in the map can be attacker-minted, so
 * sweeping on each sign-in (or on each insert once the map is at its ceiling)
 * would turn a spray into quadratic work on the request path. It is therefore
 * rate-limited. Bounded memory does not depend on it: `reserveSlot` evicts.
 */
export const PRUNE_COOLDOWN_MS = 30_000;

let lastSweepAt = Number.NEGATIVE_INFINITY;

export function sweepLoginThrottle(store: ThrottleStore, now: number): void {
  if (now - lastSweepAt <= PRUNE_COOLDOWN_MS) return;
  lastSweepAt = now;
  pruneThrottle(store, now);
}

/** How far into the map `reserveSlot` looks for an unlocked key to drop. */
const EVICTION_SCAN = 64;

function reserveSlot(store: ThrottleStore, now: number): void {
  if (store.size < MAX_STORE_KEYS) return;
  sweepLoginThrottle(store, now);
  if (store.size < MAX_STORE_KEYS) return;
  // Insertion order is failure order, so the front of the map holds the
  // stalest keys. The scan is bounded on purpose: a full pass would be O(keys)
  // on every insert once the map is at its ceiling, which is the cheapest way
  // for an attacker to burn our CPU. Giving up after a short scan and dropping
  // the front key anyway is O(1) and costs at most one lockout window on a key
  // that old.
  let scanned = 0;
  for (const [key, entry] of store) {
    if (entry.lockedUntil <= now) {
      store.delete(key);
      return;
    }
    if (++scanned >= EVICTION_SCAN) break;
  }
  const oldest = store.keys().next();
  if (!oldest.done) store.delete(oldest.value);
}

/**
 * The response a refused sign-in returns, as an opaque envelope.
 *
 * A throttled request must be indistinguishable from a failed one, otherwise the
 * throttle itself becomes an oracle: an attacker who can tell "you are locked"
 * from "wrong password" learns the state of the account budget, and a client
 * that surfaces a distinct error tells the user something an attacker could not
 * otherwise see. So the route replies with better-auth's own 401
 * INVALID_EMAIL_OR_PASSWORD envelope — no 429, no Retry-After, no distinct
 * message. The cost is real: a locked-out user is told their credentials were
 * wrong and has to discover the wait by retrying. That is the price of not
 * leaking the lock state, and it is the same trade GitHub and others make.
 */
export interface FailureEnvelope {
  status: number;
  statusText: string;
  contentType: string;
  body: string;
}

/**
 * better-auth's INVALID_EMAIL_OR_PASSWORD response, reproduced as the fallback.
 * It returns this for a wrong password and for an unknown account alike (it
 * even hashes a dummy password on the unknown-account path to keep the timing
 * flat), which is what makes the envelope safe to replay.
 */
export const FALLBACK_FAILURE_ENVELOPE: FailureEnvelope = {
  status: 401,
  statusText: "UNAUTHORIZED",
  contentType: "application/json",
  body: JSON.stringify({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }),
};

/**
 * Captures the real failure response so the throttle can replay it verbatim.
 * Copying the observed response beats hard-coding a shape that a better-auth
 * upgrade could change out from under us.
 */
export async function captureFailureEnvelope(response: Response): Promise<FailureEnvelope> {
  return {
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type") ?? "application/json",
    body: await response.clone().text(),
  };
}

export function buildFailureResponse(envelope: FailureEnvelope): Response {
  return new Response(envelope.body, {
    status: envelope.status,
    statusText: envelope.statusText,
    headers: { "content-type": envelope.contentType },
  });
}

/** The reply to a throttled attempt: the same bytes a failed attempt returns. */
export function throttledFailureResponse(envelope: FailureEnvelope | null): Response {
  return buildFailureResponse(envelope ?? FALLBACK_FAILURE_ENVELOPE);
}

/**
 * A throttled attempt is refused before better-auth runs, so it would otherwise
 * return in ~1ms while a real failure costs a password verify. That difference
 * is a timing oracle for the lock state, so both paths are padded to a common
 * floor measured from the start of the request. The floor must stay above the
 * password-verify cost (scrypt, tens of milliseconds) or the shorter of the two
 * paths becomes the tell. Cost: a failed or throttled sign-in takes at least
 * FAILURE_FLOOR_MS. Successful sign-ins are not padded and are unaffected.
 */
export const FAILURE_FLOOR_MS = 400;
/** Spreads the two paths' latencies over a range so neither is a clean cut. */
export const FAILURE_JITTER_MS = 50;

export function failureFloorDelayMs(elapsedMs: number, random: () => number = Math.random): number {
  if (elapsedMs >= FAILURE_FLOOR_MS + FAILURE_JITTER_MS) return 0;
  const shortfall = Math.max(0, FAILURE_FLOOR_MS - elapsedMs);
  return shortfall + Math.floor(random() * FAILURE_JITTER_MS);
}
