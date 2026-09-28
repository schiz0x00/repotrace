import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import {
  cleanupProject,
  createProjectRow,
  randomSuffix,
  requireInfra,
} from "../helpers";

const run = process.env.RUN_INTEGRATION === "1";

/**
 * The database is replaced by an in-memory stand-in — but only for the hermetic
 * suite below. `gate.fake` is off by default and the live integration suite
 * never turns it on, so both can share this file: `importOriginal` loads the
 * real module (constructing nothing — `prisma()` is lazy) and every call falls
 * through to it while the gate is shut.
 */
const gate = vi.hoisted(() => ({ fake: false, db: null as null | unknown }));

vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>();
  return { ...actual, prisma: () => (gate.fake ? gate.db : actual.prisma()) };
});

describe.runIf(run)("auth + api-key scoping", () => {
  let userId = "";
  const projectIds: string[] = [];

  beforeAll(async () => {
    await requireInfra(["db"]);
  });

  afterAll(async () => {
    if (userId) {
      const { prisma } = await import("@/lib/prisma");
      await prisma().user.delete({ where: { id: userId } });
    }
    for (const id of projectIds) await cleanupProject(id);
  });

  it("signs up, signs in and verifies the session", async () => {
    const { auth } = await import("@/lib/auth");
    const email = `user-${randomSuffix()}@example.com`;
    const password = "Repotrace-Test-123!";

    const created = await auth.api.signUpEmail({ body: { name: "Test User", email, password } });
    userId = created.user.id;
    expect(created.user.email).toBe(email);
    expect(created.token).toBeTruthy();

    // The session cookie value is signed by better-auth, so grab it from the
    // sign-in response's set-cookie header rather than using the raw token.
    const res = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toContain("better-auth.session_token=");

    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session).not.toBeNull();
    expect(session!.user.id).toBe(userId);
  });

  it("scopes api keys to their project", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { generateApiKey } = await import("@/lib/api-keys");
    const { authenticateRequest, canAccessProject } = await import("@/lib/authn");
    const { requireScopedProject } = await import("@/lib/api/guard");

    const projectA = await createProjectRow(`test-${randomSuffix()}`, "https://github.com/example/alpha");
    const projectB = await createProjectRow(`test-${randomSuffix()}`, "https://github.com/example/beta");
    projectIds.push(projectA.id, projectB.id);

    const makeRequest = (plaintext: string) =>
      new Request("http://localhost/api", { headers: { authorization: `Bearer ${plaintext}` } });

    // Owner-level key (no project scope) can reach every project.
    const owner = generateApiKey();
    await prisma().apiKey.create({
      data: { name: "owner", keyPrefix: owner.prefix, keyHash: owner.hash, projectId: null },
    });
    const ownerPrincipal = await authenticateRequest(makeRequest(owner.plaintext));
    expect(ownerPrincipal?.type).toBe("api_key");
    if (!ownerPrincipal) throw new Error("expected an api_key principal");
    expect(canAccessProject(ownerPrincipal, projectA.id)).toBe(true);
    expect(canAccessProject(ownerPrincipal, projectB.id)).toBe(true);
    await expect(
      requireScopedProject(makeRequest(owner.plaintext), projectA.slug),
    ).resolves.toMatchObject({ project: { id: projectA.id } });

    // Scoped key only reaches its own project.
    const scoped = generateApiKey();
    await prisma().apiKey.create({
      data: { name: "scoped", keyPrefix: scoped.prefix, keyHash: scoped.hash, projectId: projectA.id },
    });
    const scopedPrincipal = await authenticateRequest(makeRequest(scoped.plaintext));
    expect(scopedPrincipal?.type).toBe("api_key");
    if (!scopedPrincipal) throw new Error("expected an api_key principal");
    expect(canAccessProject(scopedPrincipal, projectA.id)).toBe(true);
    expect(canAccessProject(scopedPrincipal, projectB.id)).toBe(false);

    // Asserted through requireScopedProject — the guard every route actually
    // calls — rather than a helper that existed only to be tested. The status
    // is 403, not 401: the principal is authenticated, it is simply not scoped
    // to this project. This assertion used to expect 401, so the one API-key
    // test in the suite asserted a response no route produces, and the suite
    // is skipped in CI, so nothing caught it.
    await expect(
      requireScopedProject(makeRequest(scoped.plaintext), projectA.slug),
    ).resolves.toMatchObject({ project: { id: projectA.id } });
    let thrown: unknown;
    try {
      await requireScopedProject(makeRequest(scoped.plaintext), projectB.slug);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("project_forbidden");
    expect((thrown as AppError).status).toBe(403);

    // Invalid keys are rejected with a 401 rather than a null principal.
    let invalid: unknown;
    try {
      await authenticateRequest(makeRequest("rt_not-a-real-key"));
    } catch (err) {
      invalid = err;
    }
    expect(invalid).toBeInstanceOf(AppError);
    expect((invalid as AppError).code).toBe("invalid_api_key");
    expect((invalid as AppError).status).toBe(401);

    // No credentials at all -> null (anonymous request).
    const anonymous = await authenticateRequest(new Request("http://localhost/api"));
    expect(anonymous).toBeNull();
  });
});
/**
 * The same contract, without a database — so it runs in CI.
 *
 * The live suite above is gated on `RUN_INTEGRATION=1`, so in CI the only
 * coverage of API-key scoping and of the status codes a client actually sees
 * was zero. That is how an assertion expecting 401 from a path that answers
 * 403 survived: nothing ran it. This suite asserts the same contract against
 * an in-memory stand-in for `@/lib/prisma`; the hash comparison, the query
 * shapes and the guard itself are the real ones.
 */
describe("api-key scoping and guard status codes (hermetic)", () => {
  interface FakeKey {
    id: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    projectId: string | null;
    revokedAt: Date | null;
    lastUsedAt: Date | null;
  }

  const keys: FakeKey[] = [];
  const projects = [
    { id: "p-alpha", slug: "alpha", name: "Alpha" },
    { id: "p-beta", slug: "beta", name: "Beta" },
  ];
  const apiKeyQueries: unknown[] = [];
  const apiKeyWrites: Array<{ where: unknown; data: unknown }> = [];

  beforeEach(() => {
    keys.length = 0;
    projects.length = 0;
    projects.push(
      { id: "p-alpha", slug: "alpha", name: "Alpha" },
      { id: "p-beta", slug: "beta", name: "Beta" },
    );
    apiKeyQueries.length = 0;
    apiKeyWrites.length = 0;

    gate.db = {
      apiKey: {
        findMany: async (args: { where: { keyPrefix: string; revokedAt: null } }) => {
          apiKeyQueries.push(args);
          return keys
            .filter((k) => k.keyPrefix === args.where.keyPrefix && k.revokedAt === null)
            .map(({ id, keyHash, projectId, lastUsedAt }) => ({
              id,
              keyHash,
              projectId,
              lastUsedAt,
            }));
        },
        update: async (args: { where: { id: string }; data: { lastUsedAt: Date } }) => {
          apiKeyWrites.push(args);
          const row = keys.find((k) => k.id === args.where.id);
          if (row) row.lastUsedAt = args.data.lastUsedAt;
          return row;
        },
      },
      project: {
        findFirst: async (args: { where: { OR: Array<{ id?: string; slug?: string }> } }) =>
          projects.find((p) =>
            args.where.OR.some((c) => c.id === p.id || c.slug === p.slug),
          ) ?? null,
      },
    };
    gate.fake = true;
  });

  /** A real key, stored the way the schema stores it: prefix + SHA-256 hash. */
  async function storeKey(
    name: string,
    projectId: string | null,
  ): Promise<{ plaintext: string }> {
    const { generateApiKey } = await import("@/lib/api-keys");
    const key = generateApiKey();
    keys.push({
      id: `key-${name}`,
      name,
      keyPrefix: key.prefix,
      keyHash: key.hash,
      projectId,
      revokedAt: null,
      lastUsedAt: null,
    });
    return { plaintext: key.plaintext };
  }

  const bearer = (plaintext: string) =>
    new Request("http://localhost/api", { headers: { authorization: `Bearer ${plaintext}` } });

  /** The AppError a call threw, or null. */
  async function thrownBy(fn: () => Promise<unknown>): Promise<AppError | null> {
    try {
      await fn();
      return null;
    } catch (err) {
      return err as AppError;
    }
  }

  it("gives an owner-level key (no project scope) access to every project", async () => {
    const { authenticateRequest, canAccessProject } = await import("@/lib/authn");
    const { requireScopedProject } = await import("@/lib/api/guard");
    const owner = await storeKey("owner", null);

    const principal = await authenticateRequest(bearer(owner.plaintext));
    expect(principal).toEqual({ type: "api_key", apiKeyId: "key-owner", projectId: null });
    expect(canAccessProject(principal!, "p-alpha")).toBe(true);
    expect(canAccessProject(principal!, "p-beta")).toBe(true);
    await expect(
      requireScopedProject(bearer(owner.plaintext), "alpha"),
    ).resolves.toMatchObject({ project: { id: "p-alpha" } });
  });

  it("confines a project-scoped key to its own project", async () => {
    const { authenticateRequest, canAccessProject } = await import("@/lib/authn");
    const { requireScopedProject } = await import("@/lib/api/guard");
    const scoped = await storeKey("scoped", "p-alpha");

    const principal = await authenticateRequest(bearer(scoped.plaintext));
    expect(canAccessProject(principal!, "p-alpha")).toBe(true);
    expect(canAccessProject(principal!, "p-beta")).toBe(false);
    await expect(
      requireScopedProject(bearer(scoped.plaintext), "alpha"),
    ).resolves.toMatchObject({ project: { id: "p-alpha" } });

    const err = await thrownBy(() => requireScopedProject(bearer(scoped.plaintext), "beta"));
    expect(err).toBeInstanceOf(AppError);
    expect(err!.code).toBe("project_forbidden");
    // 403, not 401: the credential is real, it is just scoped elsewhere. A
    // client cannot tell a missing credential from an out-of-scope one if both
    // answer 401, and every project-scoped route used to answer 401 while the
    // top-level /search routes answered 403.
    expect(err!.status).toBe(403);
  });

  // The distinction the whole guard exists to draw, stated as one test so a
  // future "simplification" of 403 back to 401 fails loudly.
  it("answers 401 without credentials and 403 with credentials that are out of scope", async () => {
    const { requirePrincipal, requireScopedProject } = await import("@/lib/api/guard");
    const scoped = await storeKey("scoped", "p-alpha");

    const anonymous = await thrownBy(() => requirePrincipal(new Request("http://localhost/api")));
    expect(anonymous!.code).toBe("authentication_required");
    expect(anonymous!.status).toBe(401);

    const outOfScope = await thrownBy(() => requireScopedProject(bearer(scoped.plaintext), "beta"));
    expect(outOfScope!.code).toBe("project_forbidden");
    expect(outOfScope!.status).toBe(403);
  });

  it("rejects an unknown, malformed or revoked key with 401 and never returns a principal", async () => {
    const { authenticateRequest } = await import("@/lib/authn");
    const { generateApiKey } = await import("@/lib/api-keys");

    const unknown = await thrownBy(() => authenticateRequest(bearer("rt_not-a-real-key")));
    expect(unknown!.code).toBe("invalid_api_key");
    expect(unknown!.status).toBe(401);

    // A bare "Bearer" with nothing after it is *not* the "Missing API key"
    // case: the Fetch `Headers` implementation strips trailing whitespace, so
    // the value arrives as "Bearer", the `startsWith("Bearer ")` test misses,
    // and the request is answered as anonymous. Pinned here because the
    // `!token` branch inside `authenticateRequest` is therefore unreachable
    // through a real `Request` — it is a guard against a caller that hands it
    // a non-standard header object, not against HTTP.
    await expect(
      authenticateRequest(
        new Request("http://localhost/api", { headers: { authorization: "Bearer" } }),
      ),
    ).resolves.toBeNull();

    // Revoked keys share a prefix with live ones (the prefix is only the first
    // ten characters), so the `revokedAt: null` filter is the whole defence.
    const revoked = await storeKey("revoked", "p-alpha");
    const row = keys.find((k) => k.id === "key-revoked")!;
    row.revokedAt = new Date();
    const afterRevoke = await thrownBy(() => authenticateRequest(bearer(revoked.plaintext)));
    expect(afterRevoke!.code).toBe("invalid_api_key");
    expect(afterRevoke!.status).toBe(401);
    expect(generateApiKey().plaintext).toMatch(/^rt_/);
  });

  // Prefix collisions are normal, not exceptional: the plaintext is looked up
  // by its first ten characters and then verified against each candidate's
  // hash. A key that shares a prefix with a stored one must not authenticate.
  it("verifies the hash, so a prefix collision does not authenticate", async () => {
    const { authenticateRequest } = await import("@/lib/authn");
    const { generateApiKey } = await import("@/lib/api-keys");
    const stored = await storeKey("owner", null);

    const impostor = generateApiKey();
    // Force the collision rather than waiting for one.
    keys[0].keyPrefix = impostor.prefix;
    const err = await thrownBy(() => authenticateRequest(bearer(stored.plaintext)));
    expect(err!.code).toBe("invalid_api_key");
  });

  it("returns null for a request with no credentials at all", async () => {
    const { authenticateRequest } = await import("@/lib/authn");
    await expect(authenticateRequest(new Request("http://localhost/api"))).resolves.toBeNull();
    // A non-Bearer Authorization header is still anonymous, not an error.
    await expect(
      authenticateRequest(
        new Request("http://localhost/api", { headers: { authorization: "Basic dXNlcjpwdw==" } }),
      ),
    ).resolves.toBeNull();
  });

  it("looks a project up by id as well as by slug", async () => {
    const { requireScopedProject } = await import("@/lib/api/guard");
    const owner = await storeKey("owner", null);
    await expect(
      requireScopedProject(bearer(owner.plaintext), "p-beta"),
    ).resolves.toMatchObject({ project: { id: "p-beta" } });
  });

  it("answers 404 for a project that does not exist", async () => {
    const { requireScopedProject } = await import("@/lib/api/guard");
    const owner = await storeKey("owner", null);
    const err = await thrownBy(() => requireScopedProject(bearer(owner.plaintext), "no-such-project"));
    expect(err!.code).toBe("project_not_found");
    expect(err!.status).toBe(404);
  });

  // `lastUsedAt` ran on every authenticated request, turning read-only traffic
  // into a write and a new row version per call. A client polling search would
  // otherwise generate a steady stream of dead tuples for a timestamp that only
  // needs minute-level resolution.
  it("throttles the lastUsedAt write instead of doing it per request", async () => {
    const { authenticateRequest } = await import("@/lib/authn");
    const owner = await storeKey("owner", null);
    keys[0].lastUsedAt = new Date();

    await authenticateRequest(bearer(owner.plaintext));
    expect(apiKeyWrites).toHaveLength(0);

    keys[0].lastUsedAt = new Date(Date.now() - 10 * 60_000);
    await authenticateRequest(bearer(owner.plaintext));
    expect(apiKeyWrites).toHaveLength(1);
    expect(apiKeyWrites[0].where).toEqual({ id: "key-owner" });
    expect((apiKeyWrites[0].data as { lastUsedAt: Date }).lastUsedAt).toBeInstanceOf(Date);
  });

  it("reads only the first ten characters of the key as its prefix", async () => {
    const { authenticateRequest } = await import("@/lib/authn");
    const owner = await storeKey("owner", null);
    await authenticateRequest(bearer(owner.plaintext));
    expect(apiKeyQueries[0]).toMatchObject({
      where: { keyPrefix: owner.plaintext.slice(0, 10), revokedAt: null },
    });
  });

  // A session principal is not project-scoped at all; only API keys are. This
  // is pure, so it needs neither the fake nor a database.
  it("treats a session principal as unrestricted", async () => {
    const { canAccessProject } = await import("@/lib/authn");
    expect(canAccessProject({ type: "session", userId: "u1" }, "p-alpha")).toBe(true);
    expect(canAccessProject({ type: "session", userId: "u1" }, "p-beta")).toBe(true);
  });

  afterAll(() => {
    gate.fake = false;
    gate.db = null;
  });
});
