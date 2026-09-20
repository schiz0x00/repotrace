import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import {
  cleanupProject,
  createProjectRow,
  randomSuffix,
  requireInfra,
} from "../helpers";

const run = process.env.RUN_INTEGRATION === "1";

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
    const { authenticateRequest, canAccessProject, assertProjectAccess } = await import("@/lib/authn");

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
    expect(() => assertProjectAccess(ownerPrincipal, projectA.id)).not.toThrow();

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
    expect(() => assertProjectAccess(scopedPrincipal, projectA.id)).not.toThrow();
    let thrown: unknown;
    try {
      assertProjectAccess(scopedPrincipal, projectB.id);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("project_forbidden");

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