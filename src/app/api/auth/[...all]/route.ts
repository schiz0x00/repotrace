import { toNextJsHandler } from "better-auth/next-js";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { smtpConfigured } from "@/lib/mailer";
import {
  captureFailureEnvelope,
  checkLoginThrottle,
  clearLoginFailures,
  creditAddressOnSuccess,
  clientIp,
  failureFloorDelayMs,
  isSignInPath,
  loginThrottleStore,
  MAX_EMAIL_LENGTH,
  recordLoginFailure,
  sweepLoginThrottle,
  throttleTarget,
  throttledFailureResponse,
  type FailureEnvelope,
} from "@/app/api/auth/login-throttle";

export const runtime = "nodejs";

const handlers = toNextJsHandler(auth);

export const GET = handlers.GET;

/** Password-reset endpoints, which cannot work without a mail transport. */
const PASSWORD_RESET_PATH = /\/(request-password-reset|reset-password)(\/|$)/;

function isPasswordResetPath(pathname: string): boolean {
  return PASSWORD_RESET_PATH.test(pathname);
}

/**
 * The email is only used to key the throttle; better-auth owns the payload.
 * The bound matches MAX_EMAIL_LENGTH so a body field that could never be a real
 * account is simply not given an account key: an over-long "email" only ever
 * reaches the address scope, and it cannot belong to a real user anyway.
 */
const SignInBody = z.object({ email: z.string().trim().toLowerCase().max(MAX_EMAIL_LENGTH).optional() });

/** Reads the email from a cloned body so the handler still sees the stream. */
async function readEmail(request: Request): Promise<string | null> {
  try {
    const parsed = SignInBody.safeParse(await request.clone().json());
    return parsed.success ? parsed.data.email ?? null : null;
  } catch {
    // Non-JSON or unreadable body: throttle on the address alone and let
    // better-auth produce the real validation error. Nothing is guessed without
    // a parseable email, so losing the account scope here costs no protection.
    return null;
  }
}

/**
 * The exact bytes better-auth returned for the most recent failed sign-in, so a
 * throttled attempt can be answered with the identical response. It is a plain
 * module variable rather than globalThis state: losing it on hot reload only
 * falls back to `FALLBACK_FAILURE_ENVELOPE`, which is the same envelope.
 */
let lastFailure: FailureEnvelope | null = null;

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** Holds a refusal to the same latency floor a real failure takes. */
const padToFloor = async (startedAt: number): Promise<void> => {
  await sleep(failureFloorDelayMs(Date.now() - startedAt));
};

/**
 * Wraps better-auth's handler with a per-process throttle on failed sign-ins.
 *
 * Only 401s count: that is better-auth's INVALID_EMAIL_OR_PASSWORD response,
 * i.e. a real credential guess. A 400 (malformed body) or a 403 (disabled
 * account) is not a guess and must not lock a legitimate user out. better-auth
 * returns that same 401 for an unknown account, so a failure is counted against
 * a target whether or not it exists and the response never reveals which.
 */
export const POST = async (request: Request): Promise<Response> => {
  const { pathname } = new URL(request.url);

  // Refuse password reset when there is nowhere to send the mail.
  //
  // better-auth dispatches `sendResetPassword` through `runInBackgroundOrAwait`,
  // so a mailer that throws is swallowed: the request succeeds, the user is
  // told to check their inbox, and no mail is ever sent — with nothing logged
  // and nothing to diagnose it by. Checking here is the only place the failure
  // can still reach the person who can act on it.
  if (isPasswordResetPath(pathname) && !smtpConfigured()) {
    return Response.json(
      {
        error: {
          code: "email_delivery_unavailable",
          message: "Password reset is unavailable because this server has no email transport configured.",
        },
      },
      { status: 503 },
    );
  }

  if (!isSignInPath(pathname)) return handlers.POST(request);

  const startedAt = Date.now();
  const store = loginThrottleStore();
  // Rate-limited inside: a sweep is O(keys) and keys are attacker-minted.
  sweepLoginThrottle(store, startedAt);

  const target = throttleTarget(clientIp(request.headers), await readEmail(request));
  const verdict = checkLoginThrottle(store, target, startedAt);
  if (!verdict.allowed) {
    // Answer with the failure envelope, not a 429: a distinct status, message
    // or Retry-After would tell an attacker that this account is being counted.
    await padToFloor(startedAt);
    return throttledFailureResponse(lastFailure);
  }

  const response = await handlers.POST(request);
  if (response.status === 401) {
    recordLoginFailure(store, target, Date.now());
    lastFailure = await captureFailureEnvelope(response);
    await padToFloor(startedAt);
  } else if (response.ok) {
    clearLoginFailures(store, target);
    // The address budget is shared by everyone behind a NAT, so a success pays
    // part of it back. Without this, ordinary typos in an office accumulate
    // until everyone behind the same address is locked out and no honest
    // sign-in can lift it; an attacker never authenticates, so they never earn
    // the credit and the anti-spray bound is unchanged for them.
    creditAddressOnSuccess(store, target);
  }
  return response;
};
