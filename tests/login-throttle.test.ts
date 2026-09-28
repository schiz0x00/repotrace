import { describe, expect, it } from "vitest";
import {
  ACCOUNT_POLICY,
  ADDRESS_FREE_ATTEMPTS,
  ADDRESS_POLICY,
  ADDRESS_SUCCESS_CREDIT,
  creditAddressOnSuccess,
  BASE_DELAY_MS,
  FALLBACK_FAILURE_ENVELOPE,
  FAILURE_FLOOR_MS,
  FAILURE_JITTER_MS,
  FREE_ATTEMPTS,
  IDLE_RESET_MS,
  MAX_DELAY_MS,
  MAX_STORE_KEYS,
  PRUNE_COOLDOWN_MS,
  accountThrottleKey,
  addressThrottleKey,
  backoffMs,
  buildFailureResponse,
  captureFailureEnvelope,
  checkLoginThrottle,
  clearLoginFailures,
  clientIp,
  failureFloorDelayMs,
  normalizeEmail,
  recordLoginFailure,
  sweepLoginThrottle,
  throttleTarget,
  throttledFailureResponse,
  type ThrottleStore,
} from "@/app/api/auth/login-throttle";

const now = 1_700_000_000_000;

describe("clientIp", () => {
  it("reads the first forwarded hop", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(new Headers())).toBe("unknown");
  });

  it("accepts IPv6 literals and ignores the real-ip fallback when the hop is junk", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientIp(new Headers({ "x-forwarded-for": "::1", "x-real-ip": "198.51.100.4" }))).toBe("::1");
    // A non-address first hop must not silently promote the spoofable fallback.
    expect(clientIp(new Headers({ "x-forwarded-for": "unknown", "x-real-ip": "198.51.100.4" }))).toBe(
      "198.51.100.4",
    );
  });

  // Regression: the first hop is attacker-chosen, so a literal that is not an
  // address must not become a fresh map key per request — that is exactly the
  // "rotate the header to dodge the throttle" trick, one string at a time.
  it("folds implausible hops into the shared unknown bucket", () => {
    for (const junk of ["", "   ", "not-an-ip", "deadbeef", "x".repeat(500), "1.2.3.4; DROP", "0x7f000001"]) {
      expect(clientIp(new Headers({ "x-forwarded-for": junk })), JSON.stringify(junk)).toBe("unknown");
    }
  });
});

describe("throttle keys", () => {
  it("keeps the pair key but makes the account key independent of the address", () => {
    const here = throttleTarget("203.0.113.7", "User@Example.com");
    const elsewhere = throttleTarget("198.51.100.4", "user@example.com");
    expect(here.pair).toBe("203.0.113.7|user@example.com");
    // The address is the only difference between the two requests...
    expect(here.pair).not.toBe(elsewhere.pair);
    // ...and it is deliberately absent from the account key, which is the scope
    // the lockout is decided on.
    expect(here.account).toBe(elsewhere.account);
    expect(here.account).toBe("account:user@example.com");
    expect(here.address).toBe("address:203.0.113.7");
    expect(elsewhere.address).toBe("address:198.51.100.4");
  });

  it("has no account scope when the request names no account", () => {
    const social = throttleTarget("203.0.113.7", null);
    expect(social.account).toBeNull();
    expect(social.pair).toBe("203.0.113.7|");
    expect(social.address).toBe("address:203.0.113.7");
    expect(accountThrottleKey(null)).toBeNull();
    expect(accountThrottleKey("   ")).toBeNull();
  });

  it("bounds the key so a huge body field cannot become a map key", () => {
    const huge = `${"a".repeat(10_000)}@example.com`;
    expect(normalizeEmail(huge)).toHaveLength(320);
    expect(throttleTarget("203.0.113.7", huge).account).toHaveLength("account:".length + 320);
  });
});

describe("account scope is authoritative", () => {
  let store: ThrottleStore;

  it("accumulates against one account across rotating addresses", () => {
    store = new Map();
    const target = throttleTarget("203.0.113.7", "victim@example.com");
    for (let i = 0; i < FREE_ATTEMPTS; i++) {
      expect(checkLoginThrottle(store, target, now).allowed, `attempt ${i + 1}`).toBe(true);
      recordLoginFailure(store, target, now);
    }

    // The attack this closes: a fresh X-Forwarded-For on every request used to
    // mint a fresh `ip|email` key, so the per-account budget never accumulated
    // and the account was guessable forever.
    recordLoginFailure(store, throttleTarget("198.51.100.99", "victim@example.com"), now);
    recordLoginFailure(store, throttleTarget("192.0.2.44", "victim@example.com"), now);

    const locked = checkLoginThrottle(store, throttleTarget("203.0.113.200", "victim@example.com"), now);
    expect(locked.allowed).toBe(false);
    expect(locked.scope).toBe("account");
    // Two further failures past the free budget, so the window has doubled once.
    expect(locked.retryAfterSeconds).toBe((BASE_DELAY_MS * 2) / 1000);
  });

  it("counts a guess against an account that does not exist the same way", () => {
    // better-auth answers an unknown account with the same 401, so a nonexistent
    // target reaches the same budget as a real one and the throttle's behaviour
    // cannot be used to probe which accounts exist.
    const store: ThrottleStore = new Map();
    const target = throttleTarget("203.0.113.7", "nobody@example.com");
    for (let i = 0; i <= FREE_ATTEMPTS; i++) recordLoginFailure(store, target, now);
    expect(checkLoginThrottle(store, target, now).allowed).toBe(false);
  });

  it("leaves other accounts on the same address alone", () => {
    const store: ThrottleStore = new Map();
    const victim = throttleTarget("203.0.113.7", "victim@example.com");
    for (let i = 0; i <= FREE_ATTEMPTS; i++) recordLoginFailure(store, victim, now);
    expect(checkLoginThrottle(store, throttleTarget("203.0.113.7", "other@example.com"), now).allowed).toBe(true);
  });
});

describe("address scope", () => {
  it("bounds a spray across many accounts but is far looser than the account budget", () => {
    expect(ADDRESS_FREE_ATTEMPTS).toBeGreaterThan(FREE_ATTEMPTS);
    const store: ThrottleStore = new Map();
    for (let i = 0; i < ADDRESS_FREE_ATTEMPTS; i++) {
      const target = throttleTarget("203.0.113.7", `sprayed-${i}@example.com`);
      // Each distinct account is well inside its own budget...
      expect(checkLoginThrottle(store, target, now).allowed, `account ${i}`).toBe(true);
      recordLoginFailure(store, target, now);
    }
    // ...so the shared address is what eventually refuses the host.
    const spray = throttleTarget("203.0.113.7", "sprayed-final@example.com");
    expect(checkLoginThrottle(store, spray, now).allowed).toBe(true);
    recordLoginFailure(store, spray, now);
    const verdict = checkLoginThrottle(store, spray, now);
    expect(verdict.allowed).toBe(false);
    expect(verdict.scope).toBe("address");
    expect(verdict.retryAfterSeconds).toBe(ADDRESS_POLICY.baseDelayMs / 1000);
  });

  it("scales the address budget with its own policy", () => {
    expect(backoffMs(ADDRESS_FREE_ATTEMPTS, ADDRESS_POLICY)).toBe(0);
    expect(backoffMs(ADDRESS_FREE_ATTEMPTS + 1, ADDRESS_POLICY)).toBe(ADDRESS_POLICY.baseDelayMs);
    expect(backoffMs(1_000, ADDRESS_POLICY)).toBe(ADDRESS_POLICY.maxDelayMs);
    // The account policy is unaffected by the address numbers.
    expect(backoffMs(FREE_ATTEMPTS + 1)).toBe(ACCOUNT_POLICY.baseDelayMs);
    expect(backoffMs(1_000)).toBe(MAX_DELAY_MS);
  });
});

describe("clearing on success", () => {
  it("clears the account and pair budget but not the shared address budget", () => {
    const store: ThrottleStore = new Map();
    const target = throttleTarget("203.0.113.7", "user@example.com");
    for (let i = 0; i <= FREE_ATTEMPTS; i++) recordLoginFailure(store, target, now);
    expect(store.has(addressThrottleKey("203.0.113.7"))).toBe(true);

    clearLoginFailures(store, target);
    // A success is evidence about this account, not about every other account
    // the same host may be guessing: clearing the address budget would let an
    // attacker holding one valid account reset the volume bound at will.
    expect(store.has(target.pair)).toBe(false);
    expect(store.has(target.account!)).toBe(false);
    expect(store.has(addressThrottleKey("203.0.113.7"))).toBe(true);
    expect(checkLoginThrottle(store, target, now).allowed).toBe(true);
  });

  it("still accepts a bare composite key from callers that hold nothing else", () => {
    const store: ThrottleStore = new Map();
    const key = "203.0.113.7|user@example.com";
    recordLoginFailure(store, key, now);
    expect(store.size).toBe(1);
    expect(checkLoginThrottle(store, key, now).allowed).toBe(true);
    for (let i = 0; i < FREE_ATTEMPTS; i++) recordLoginFailure(store, key, now);
    expect(checkLoginThrottle(store, key, now).allowed).toBe(false);
    clearLoginFailures(store, key);
    expect(store.size).toBe(0);
  });
});

describe("store bounds", () => {
  it("evicts the least-recently-failed unlocked key instead of growing without bound", () => {
    const store: ThrottleStore = new Map();
    // One more than the ceiling, each from a distinct address so nothing is
    // pruned as stale.
    for (let i = 0; i < MAX_STORE_KEYS; i++) {
      recordLoginFailure(store, throttleTarget(`10.0.${Math.floor(i / 256)}.${i % 256}`, `u${i}@example.com`), now);
    }
    expect(store.size).toBeLessThanOrEqual(MAX_STORE_KEYS);
    expect(store.size).toBeGreaterThan(0);
  });

  it("keeps the store bounded when every key is locked", () => {
    const store: ThrottleStore = new Map();
    for (let i = 0; i < MAX_STORE_KEYS; i++) {
      const target = throttleTarget(`10.0.${Math.floor(i / 256)}.${i % 256}`, `u${i}@example.com`);
      for (let f = 0; f <= FREE_ATTEMPTS; f++) recordLoginFailure(store, target, now);
    }
    expect(store.size).toBeLessThanOrEqual(MAX_STORE_KEYS);
    expect(store.size).toBeGreaterThan(MAX_STORE_KEYS / 2);
    // The next write has to make room; the address key is evicted, not the
    // memory.
    recordLoginFailure(store, throttleTarget("192.0.2.1", "fresh@example.com"), now);
    expect(store.size).toBeLessThanOrEqual(MAX_STORE_KEYS);
  });

  it("rate-limits the sweep rather than running it on every sign-in", () => {
    const store: ThrottleStore = new Map();
    const longAgo = now - IDLE_RESET_MS - 1;
    recordLoginFailure(store, "203.0.113.7|stale@example.com", longAgo);

    // The sweep is O(keys) and keys are attacker-minted, so it runs at most
    // once per cooldown; bounded memory is reserveSlot's job, not this one's.
    const later = now + PRUNE_COOLDOWN_MS + 1;
    sweepLoginThrottle(store, later);
    expect(store.size).toBe(0);

    recordLoginFailure(store, "203.0.113.7|stale@example.com", later);
    sweepLoginThrottle(store, later);
    expect(store.size).toBe(1);
  });
});

describe("idle reset", () => {
  it("drops a quiet key and starts the count again", () => {
    const store: ThrottleStore = new Map();
    const target = throttleTarget("203.0.113.7", "user@example.com");
    for (let i = 0; i < FREE_ATTEMPTS; i++) recordLoginFailure(store, target, now);
    const later = now + IDLE_RESET_MS + 1;
    expect(checkLoginThrottle(store, target, later).allowed).toBe(true);
    recordLoginFailure(store, target, later);
    expect(store.get(target.account!)!.failures).toBe(1);
  });
});

describe("failure envelope", () => {
  it("replays better-auth's own 401 rather than a 429", async () => {
    // better-auth serialises an APIError as its raw { code, message } body with
    // the status from the error, so the fallback has to match that byte for byte.
    const observed = new Response(JSON.stringify({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }), {
      status: 401,
      statusText: "UNAUTHORIZED",
      headers: { "content-type": "application/json" },
    });
    const captured = await captureFailureEnvelope(observed);
    expect(captured).toEqual(FALLBACK_FAILURE_ENVELOPE);

    const throttled = throttledFailureResponse(captured);
    expect(throttled.status).toBe(401);
    // No 429, no Retry-After: both would tell an attacker they are being
    // counted, which is the whole signal this is closing.
    expect(throttled.headers.get("retry-after")).toBeNull();
    expect(throttled.headers.get("content-type")).toBe("application/json");
    expect(await throttled.text()).toBe(await observed.clone().text());
  });

  it("falls back to the documented envelope before any failure has been seen", async () => {
    const throttled = throttledFailureResponse(null);
    expect(throttled.status).toBe(FALLBACK_FAILURE_ENVELOPE.status);
    expect(JSON.parse(await throttled.text())).toEqual({
      code: "INVALID_EMAIL_OR_PASSWORD",
      message: "Invalid email or password",
    });
  });

  it("captures a drifted shape instead of assuming one", async () => {
    // If a better-auth upgrade changes the body, the replayed envelope follows
    // the observed one rather than a stale hard-coded string.
    const drifted = new Response(JSON.stringify({ code: "SOMETHING_ELSE", message: "nope" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    const captured = await captureFailureEnvelope(drifted);
    const replayed = buildFailureResponse(captured);
    expect(replayed.status).toBe(401);
    expect(JSON.parse(await replayed.text()).code).toBe("SOMETHING_ELSE");
    // The original response is left unread for the caller to return.
    expect(await drifted.text()).toContain("SOMETHING_ELSE");
  });
});

describe("failureFloorDelayMs", () => {
  const noJitter = () => 0;

  it("pads a fast refusal up to the floor", () => {
    // A throttled request is refused before better-auth runs, so without a floor
    // it returns in about a millisecond and "faster than a password check" is
    // itself a lock-state oracle.
    expect(failureFloorDelayMs(0, noJitter)).toBe(FAILURE_FLOOR_MS);
    expect(failureFloorDelayMs(1, noJitter)).toBe(FAILURE_FLOOR_MS - 1);
    expect(failureFloorDelayMs(FAILURE_FLOOR_MS - 10, noJitter)).toBe(10);
  });

  it("overlaps the two paths instead of cutting at an exact value", () => {
    // The real failure path is measured from the start of the request too, so
    // a handler that beats the floor lands in the same band as a refusal.
    const throttledAt = 0 + failureFloorDelayMs(0, () => 0.99);
    const failedAt = 5 + failureFloorDelayMs(5, () => 0.01);
    expect(throttledAt).toBeGreaterThanOrEqual(FAILURE_FLOOR_MS);
    expect(failedAt).toBeGreaterThanOrEqual(FAILURE_FLOOR_MS);
    expect(Math.abs(throttledAt - failedAt)).toBeLessThan(FAILURE_JITTER_MS);
  });

  it("does not hold a request that is already slower than the floor", () => {
    expect(failureFloorDelayMs(FAILURE_FLOOR_MS + FAILURE_JITTER_MS, noJitter)).toBe(0);
    expect(failureFloorDelayMs(10_000, noJitter)).toBe(0);
    expect(failureFloorDelayMs(FAILURE_FLOOR_MS, noJitter)).toBeLessThan(FAILURE_JITTER_MS);
  });
});

describe("shared-address budget", () => {
  // Regression: the address scope never cleared on success, and the address is
  // shared by everyone behind a NAT or corporate proxy. Ordinary typos in an
  // office therefore accumulated past ADDRESS_FREE_ATTEMPTS into a lockout
  // that no honest sign-in could lift -- one person's mistyped password locking
  // out their colleagues with no recourse.
  //
  // The fix credits the shared budget on success rather than clearing it:
  // clearing would hand an attacker holding any single valid account a way to
  // erase the anti-spray bound, while crediting only rewards people who can
  // actually authenticate.
  const IP = "203.0.113.7";

  it("repays the shared budget as legitimate users sign in", () => {
    const store = new Map<string, { failures: number; lockedUntil: number; lastFailureAt: number }>();
    const now = Date.now();
    const addressKey = addressThrottleKey(IP);

    // 80 failures from the shared address, spread across different accounts.
    for (let i = 0; i < 80; i++) {
      recordLoginFailure(store, throttleTarget(IP, `u${i}@example.com`), now);
    }
    const before = store.get(addressKey)?.failures ?? 0;
    expect(before).toBe(80);
    expect(before).toBeGreaterThan(ADDRESS_FREE_ATTEMPTS);

    // Real users behind that address keep signing in.
    for (let i = 0; i < 4; i++) {
      creditAddressOnSuccess(store, throttleTarget(IP, `u${i}@example.com`));
    }

    const after = store.get(addressKey)?.failures ?? 0;
    expect(after).toBe(before - 4 * ADDRESS_SUCCESS_CREDIT);
    // Still above the free budget: one success must not erase the bound.
    expect(after).toBeGreaterThan(ADDRESS_FREE_ATTEMPTS);
  });

  it("clears the address entry entirely once the credit takes it to the floor", () => {
    const store = new Map<string, { failures: number; lockedUntil: number; lastFailureAt: number }>();
    const now = Date.now();
    const addressKey = addressThrottleKey(IP);
    const total = ADDRESS_FREE_ATTEMPTS + 3;
    for (let i = 0; i < total; i++) {
      recordLoginFailure(store, throttleTarget(IP, `v${i}@example.com`), now);
    }
    expect(store.get(addressKey)?.failures).toBe(total);
    creditAddressOnSuccess(store, throttleTarget(IP, "v0@example.com"));
    expect(store.get(addressKey)).toBeUndefined();
  });

  it("cannot be erased by a spray, because a spray never authenticates", () => {
    const store = new Map<string, { failures: number; lockedUntil: number; lastFailureAt: number }>();
    const now = Date.now();
    const addressKey = addressThrottleKey(IP);
    for (let i = 0; i < 40; i++) {
      recordLoginFailure(store, throttleTarget(IP, `w${i}@example.com`), now);
    }
    // No success, no credit: the anti-spray bound is unchanged by the change.
    expect(store.get(addressKey)?.failures).toBe(40);
  });

  it("does not touch a budget when no address is known", () => {
    const store = new Map<string, { failures: number; lockedUntil: number; lastFailureAt: number }>();
    expect(() =>
      creditAddressOnSuccess(store, { pair: "1.2.3.4|x@y.z", address: null, account: null }),
    ).not.toThrow();
    expect(store.size).toBe(0);
  });
});
