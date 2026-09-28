import { beforeEach, describe, expect, it } from "vitest";
import { safeNext } from "@/app/(auth)/login/safe-next";
import {
  BASE_DELAY_MS,
  FREE_ATTEMPTS,
  IDLE_RESET_MS,
  MAX_DELAY_MS,
  backoffMs,
  checkLoginThrottle,
  clearLoginFailures,
  clientIp,
  isSignInPath,
  pruneThrottle,
  recordLoginFailure,
  retryAfterSeconds,
  throttleKey,
  type ThrottleStore,
} from "@/app/api/auth/login-throttle";
import { describeUserAgent } from "@/components/dashboard/account-settings";

describe("safeNext", () => {
  it("passes through ordinary same-origin paths", () => {
    for (const path of ["/", "/projects", "/projects/repotrace?tab=symbols", "/settings"]) {
      expect(safeNext(path), path).toBe(path);
    }
  });

  it("falls back to the dashboard root for missing or non-path targets", () => {
    for (const raw of [null, undefined, "", "https://evil.com", "javascript:alert(1)", "settings", "//evil.com", "/\\evil.com"]) {
      expect(safeNext(raw), String(raw)).toBe("/");
    }
  });

  // Regression: browsers and the Next router strip tab/newline characters from
  // a URL before resolving it, so a target that only *looks* single-slashed is
  // delivered as //evil.com and navigates off-origin right after sign-in.
  it("rejects targets containing control characters or whitespace", () => {
    const payloads = [
      "/\u0009/evil.com",
      "/\u000A/evil.com",
      "/\u000D\u000A/evil.com",
      "/\u0000/evil.com",
      "/ /evil.com",
      "/path ",
      "/path\u0008",
      "/projects\u007F",
    ];
    for (const raw of payloads) {
      expect(safeNext(raw), JSON.stringify(raw)).toBe("/");
    }
  });

  it("normalises the percent-encoded forms a browser decodes after the check", () => {
    // %09 survives the prefix check as a literal string, so the raw form is
    // harmless; the decoded form is what must be refused.
    expect(safeNext("/%09//evil.com")).toBe("/%09//evil.com");
    expect(safeNext(decodeURIComponent("/%09//evil.com"))).toBe("/");
  });
});

describe("auth configuration", () => {
  // Importing @/lib/auth builds the better-auth instance (adapter included) but
  // performs no I/O: the adapter only connects on the first query, so this stays
  // hermetic. It is the only place the resolved options can be asserted.
  it("revokes sessions when a password is reset", async () => {
    const { auth } = await import("@/lib/auth");
    // Without the flag better-auth skips deleteUserSessions on reset
    // (api/routes/password.mjs), so a stolen session cookie survives a reset.
    expect(auth.options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
  });

  it("defers cookie security to better-auth when the flag is not set", async () => {
    const { auth } = await import("@/lib/auth");
    const { env } = await import("@/lib/env");
    const flag = env().USE_SECURE_COOKIES;
    // `undefined` is meaningful: better-auth only infers the protocol when the
    // option is absent, and an explicit false would pin a TLS deployment to
    // insecure cookies and strip the __Secure- prefix.
    expect(auth.options.advanced?.useSecureCookies).toBe(flag ? true : undefined);
    const attributes = auth.options.advanced?.defaultCookieAttributes ?? {};
    // Same rule for the attribute override: never force secure off.
    expect("secure" in attributes ? attributes.secure : undefined).toBe(flag ? true : undefined);
    expect(attributes.httpOnly).toBe(true);
  });
});

describe("login throttle", () => {
  let store: ThrottleStore;
  const now = 1_700_000_000_000;

  beforeEach(() => {
    store = new Map();
  });

  it("recognises sign-in endpoints and ignores the rest", () => {
    expect(isSignInPath("/api/auth/sign-in/email")).toBe(true);
    expect(isSignInPath("/api/auth/sign-in/social")).toBe(true);
    expect(isSignInPath("/api/auth/sign-out")).toBe(false);
    expect(isSignInPath("/api/auth/sign-up/email")).toBe(false);
  });

  it("reads the client address from the first forwarded hop", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(new Headers())).toBe("unknown");
  });

  it("keys on ip and normalised email so neither alone is enough", () => {
    expect(throttleKey("203.0.113.7", "User@Example.com")).toBe("203.0.113.7|user@example.com");
    expect(throttleKey("203.0.113.7", "user@example.com")).toBe(
      throttleKey("203.0.113.7", "USER@EXAMPLE.COM"),
    );
    expect(throttleKey("203.0.113.7", null)).toBe("203.0.113.7|");
  });

  it("allows the free attempts and locks out with exponential backoff", () => {
    const key = throttleKey("203.0.113.7", "user@example.com");
    for (let i = 0; i < FREE_ATTEMPTS; i++) {
      expect(checkLoginThrottle(store, key, now).allowed, `attempt ${i + 1}`).toBe(true);
      recordLoginFailure(store, key, now);
    }
    // The failure that exhausts the budget arms the first lockout window.
    recordLoginFailure(store, key, now);

    const locked = checkLoginThrottle(store, key, now);
    expect(locked.allowed).toBe(false);
    expect(locked.retryAfterSeconds).toBe(Math.ceil(BASE_DELAY_MS / 1000));

    // Each further failure doubles the window (reported in whole seconds).
    recordLoginFailure(store, key, now);
    expect(retryAfterSeconds(store.get(key)!.lockedUntil, now)).toBe((BASE_DELAY_MS * 2) / 1000);

    for (let i = 0; i < 20; i++) recordLoginFailure(store, key, now);
    expect(retryAfterSeconds(store.get(key)!.lockedUntil, now)).toBe(MAX_DELAY_MS / 1000);
  });

  it("caps the backoff", () => {
    expect(backoffMs(FREE_ATTEMPTS)).toBe(0);
    expect(backoffMs(FREE_ATTEMPTS + 1)).toBe(BASE_DELAY_MS);
    expect(backoffMs(100)).toBe(MAX_DELAY_MS);
  });

  it("never reports a zero Retry-After", () => {
    expect(retryAfterSeconds(now + 1, now)).toBe(1);
    expect(retryAfterSeconds(now, now)).toBe(1);
    expect(retryAfterSeconds(now + 2500, now)).toBe(3);
  });

  it("unlocks once the window elapses and a successful sign-in clears the count", () => {
    const key = throttleKey("203.0.113.7", "user@example.com");
    for (let i = 0; i <= FREE_ATTEMPTS; i++) recordLoginFailure(store, key, now);
    expect(checkLoginThrottle(store, key, now + BASE_DELAY_MS).allowed).toBe(true);

    for (let i = 0; i <= FREE_ATTEMPTS; i++) recordLoginFailure(store, key, now);
    clearLoginFailures(store, key);
    expect(store.size).toBe(0);
    expect(checkLoginThrottle(store, key, now).allowed).toBe(true);
  });

  it("resets a key that has been quiet past the idle window", () => {
    const key = throttleKey("203.0.113.7", "user@example.com");
    for (let i = 0; i < FREE_ATTEMPTS; i++) recordLoginFailure(store, key, now);
    const later = now + IDLE_RESET_MS + 1;
    expect(checkLoginThrottle(store, key, later).allowed).toBe(true);
    // The counter is dropped, so the next failure is the first again.
    recordLoginFailure(store, key, later);
    expect(store.get(key)!.failures).toBe(1);
  });

  it("prunes only keys that are neither locked nor recent", () => {
    const longAgo = now - IDLE_RESET_MS - 1;
    const stale = throttleKey("203.0.113.7", "stale@example.com");
    const locked = throttleKey("203.0.113.7", "locked@example.com");
    const recent = throttleKey("203.0.113.7", "recent@example.com");
    recordLoginFailure(store, stale, longAgo);
    recordLoginFailure(store, recent, now);
    for (let i = 0; i <= FREE_ATTEMPTS; i++) recordLoginFailure(store, locked, now);

    pruneThrottle(store, now);
    expect(store.has(stale)).toBe(false);
    // Still inside its lockout window, and still inside the idle window.
    expect(store.has(locked)).toBe(true);
    expect(store.has(recent)).toBe(true);
  });
});

describe("describeUserAgent", () => {
  it("labels common desktop and mobile agents", () => {
    expect(describeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")).toBe(
      "Chrome on macOS",
    );
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0")).toBe(
      "Edge on Windows",
    );
    expect(describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile/15E148 Safari/604.1")).toBe(
      "Safari on iOS",
    );
    expect(describeUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0")).toBe(
      "Firefox on Linux",
    );
    // Edge and Opera both advertise Chrome; the more specific token must win.
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36 OPR/106.0")).toBe(
      "Opera on Windows",
    );
  });

  it("handles non-browser clients and missing metadata", () => {
    expect(describeUserAgent("curl/8.4.0")).toBe("curl");
    expect(describeUserAgent("wget/1.21")).toBe("wget");
    expect(describeUserAgent("Googlebot/2.1 (+http://www.google.com/bot.html)")).toBe("bot");
    expect(describeUserAgent(null)).toBe("Unknown device");
    expect(describeUserAgent("")).toBe("Unknown device");
    // A recognisable OS without a recognisable browser still reads as a device.
    expect(describeUserAgent("SomeCustomAgent/1.0 (Windows NT 10.0)")).toBe("Windows");
  });

  it("truncates an unrecognised agent instead of hiding it", () => {
    const long = `custom-${"x".repeat(200)}`;
    const label = describeUserAgent(long);
    expect(label.length).toBeLessThan(long.length);
    expect(label.endsWith("…")).toBe(true);
  });
});
