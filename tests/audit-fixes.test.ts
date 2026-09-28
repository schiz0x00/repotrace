import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for the repository audit.
 *
 * Every test here imports the code it names and exercises it. The previous
 * version of this file asserted string literals (`expect("strict").toBe("strict")`),
 * so it reported coverage for the lexical query builder, the health probe and
 * the session cookie policy while passing unchanged if all three were deleted.
 *
 * Three of the original entries — the Qdrant image tag in docker-compose.yml, a
 * dummy embedding key in .env.example, and the determinism of
 * scripts/mock-embeddings.mjs — describe configuration or a standalone script,
 * not importable module code, and are not reproduced here. The mock server binds
 * a port on import and exports nothing, so a hermetic test of it is not possible
 * without starting it; asserting on the literal it used to contain proved
 * nothing.
 */

// Infrastructure reachability, stubbed so the health probe can be exercised
// without Postgres, Qdrant or Redis. Hoisted so the mock factories below — which
// run before the imports — can close over it.
const infra = vi.hoisted(() => ({ postgres: true, qdrant: true, depth: 0 }));

vi.mock("@/lib/prisma", () => ({
  prisma: () => ({
    $queryRaw: async () => {
      if (!infra.postgres) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      return [{ ok: 1 }];
    },
  }),
}));

vi.mock("@/lib/qdrant", () => ({
  qdrantHealth: async () =>
    infra.qdrant
      ? { healthy: true, version: "1.19.0" }
      : { healthy: false, error: "connect ECONNREFUSED 127.0.0.1:6333" },
}));

vi.mock("@/lib/jobs/queue", () => ({
  queueDepth: async () => infra.depth,
}));

// @/lib/auth builds a better-auth instance at module scope and hands the Prisma
// client straight to the adapter. Only the resolved cookie attributes are under
// test, so the already-mocked client is enough and nothing ever queries.
vi.mock("@/lib/mailer", () => ({ sendMail: async () => {} }));

describe("lexical query building", () => {
  it("ORs a multi-word query instead of requiring every word", async () => {
    const { buildTsQuery } = await import("@/lib/search/lexical");
    // `to_tsquery` reads whitespace as `&`, so a natural-language question used
    // to demand a chunk containing all five words — which is why the lexical leg
    // returned nothing for exactly the questions this product exists to answer.
    expect(buildTsQuery("how does order expiry work")).toEqual({
      tsQuery: "how | does | order | expiry | work",
      terms: ["how", "does", "order", "expiry", "work"],
    });
  });

  it("strips every tsquery operator out of the query text", async () => {
    const { buildTsQuery } = await import("@/lib/search/lexical");
    // Nothing but word characters survives, so `&`, `|`, quotes, parentheses and
    // the `:*` prefix operator cannot reach the parser.
    const { tsQuery, terms } = buildTsQuery("order & state | 'canceled' !(*)");
    expect(terms).toEqual(["order", "state", "canceled"]);
    expect(tsQuery).toBe("order | state | canceled");
    expect(tsQuery).not.toMatch(/[^A-Za-z0-9_ |]/);
  });

  it("keeps underscores and digits, which are part of identifiers", async () => {
    const { buildTsQuery } = await import("@/lib/search/lexical");
    expect(buildTsQuery("OrderRepository.find_by_id 2").terms).toEqual([
      "OrderRepository",
      "find_by_id",
      "2",
    ]);
  });

  it("reports no query at all for text with no word character", async () => {
    const { buildTsQuery } = await import("@/lib/search/lexical");
    // lexicalSearch branches on this to take the ILIKE fallback; a stray `null`
    // here would send an empty string to `to_tsquery` and error the request.
    expect(buildTsQuery("!!! ?? ...")).toEqual({ tsQuery: null, terms: [] });
    expect(buildTsQuery("   ")).toEqual({ tsQuery: null, terms: [] });
  });

  it("caps the term count so one long query cannot become a huge expression", async () => {
    const { buildTsQuery } = await import("@/lib/search/lexical");
    const { terms, tsQuery } = buildTsQuery(Array.from({ length: 40 }, (_, i) => `t${i}`).join(" "));
    expect(terms).toHaveLength(16);
    expect(tsQuery!.split(" | ")).toHaveLength(16);
  });
});

describe("parseFile failure handling", () => {
  it("degrades to fallback chunking, with the reason recorded, when no grammar is loaded", async () => {
    // A fresh module registry gives a fresh grammar cache, which is what a
    // worker that has not preloaded grammars looks like.
    vi.resetModules();
    const { parseFile } = await import("@/lib/indexing/parser");
    const parsed = parseFile("src/orders/model.ts", "export const x = 1;\nexport const y = 2;\n");
    expect(parsed.error).toMatch(/No tree-sitter grammar/);
    // Still searchable as text; it just contributes no symbols.
    expect(parsed.symbols).toEqual([]);
    expect(parsed.chunks.length).toBeGreaterThan(0);
    expect(parsed.chunks[0].content).toContain("export const x = 1;");
  });

  it("does not throw on source that does not parse", async () => {
    vi.resetModules();
    const { parseFile, preloadGrammars } = await import("@/lib/indexing/parser");
    await preloadGrammars();
    // The pipeline's per-file loop only survives a malformed file because
    // parseFile never throws here: an uncaught throw aborted the job, and since
    // the watermark only advances when filesFailed is zero, one bad file wedged
    // the project permanently.
    let parsed: ReturnType<typeof parseFile> | null = null;
    expect(() => {
      parsed = parseFile("src/broken.ts", "class {{{ function (((\n");
    }).not.toThrow();
    expect(parsed!.chunks.length).toBeGreaterThan(0);
  });

  it("still extracts symbols from a file it can parse", async () => {
    vi.resetModules();
    const { parseFile, preloadGrammars } = await import("@/lib/indexing/parser");
    await preloadGrammars();
    const parsed = parseFile(
      "src/orders/model.ts",
      "export class OrderRepository {\n  static findById(id: string) { return id; }\n}\n",
    );
    expect(parsed.error).toBeNull();
    expect(parsed.symbols.map((s) => s.qualifiedName)).toContain("OrderRepository.findById");
  });
});

describe("GET /api/v1/health", () => {
  const probe = () => import("@/app/api/v1/health/route");

  beforeEach(() => {
    infra.postgres = true;
    infra.qdrant = true;
    infra.depth = 0;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("answers without any credential", async () => {
    const { GET } = await probe();
    // A container healthcheck and a load balancer cannot present a session or
    // an API key, so this route is deliberately the one public endpoint. If an
    // auth guard were ever added here the probe would start returning 401 and
    // the deployment would be declared unhealthy while perfectly able to serve.
    const res = await GET(new Request("http://localhost/api/v1/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("healthy");
    expect(body.checks).toEqual({ postgres: true, qdrant: true, queue: true });
  });

  it("returns 503 when Postgres is unreachable", async () => {
    const { GET } = await probe();
    infra.postgres = false;
    const res = await GET(new Request("http://localhost/api/v1/health"));
    // It used to always answer 200, so a failing instance looked healthy.
    expect(res.status).toBe(503);
    expect((await res.json()).checks.postgres).toBe(false);
  });

  it("returns 503 when Qdrant is unreachable", async () => {
    const { GET } = await probe();
    infra.qdrant = false;
    const res = await GET(new Request("http://localhost/api/v1/health"));
    expect(res.status).toBe(503);
    expect((await res.json()).checks.qdrant).toBe(false);
  });

  it("returns 503 when the job queue cannot be reached", async () => {
    const { GET } = await probe();
    // queueDepth reports -1 when Redis is down; a negative depth is the only
    // signal, so a truthiness check here would have passed a dead queue.
    infra.depth = -1;
    const res = await GET(new Request("http://localhost/api/v1/health"));
    expect(res.status).toBe(503);
    expect((await res.json()).checks.queue).toBe(false);
  });

  it("discloses no infrastructure detail to an unauthenticated caller", async () => {
    const { GET } = await probe();
    infra.qdrant = false;
    const body = await (await GET(new Request("http://localhost/api/v1/health"))).json();
    // The component *names* are fine — a boolean saying "qdrant is down" is the
    // point of the probe. What must not leave is the detail: the connection
    // error, a hostname, a port or a version.
    expect(Object.values(body.checks).every((v) => typeof v === "boolean")).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|localhost|:\d{4,5}|1\.19\.0/);
  });
});

describe("session cookie policy", () => {
  it("marks every session cookie httpOnly and SameSite=Strict", async () => {
    const { auth } = await import("@/lib/auth");
    // Resolved through better-auth's own cookie factory rather than read off
    // the config object, so a later change to how the defaults are applied (or
    // a plugin overriding them) still fails this test.
    const { getCookies } = await import("better-auth/cookies");
    const cookies = getCookies(auth.options);
    for (const name of ["sessionToken", "sessionData", "dontRememberToken", "accountData"] as const) {
      const cookie = cookies[name];
      expect(cookie, `no ${name} cookie was resolved`).toBeDefined();
      expect(cookie.attributes.httpOnly, name).toBe(true);
      // SameSite=Strict is what keeps a cross-site POST from riding the session
      // cookie; Lax would still send it on top-level navigations.
      expect(String(cookie.attributes.sameSite).toLowerCase(), name).toBe("strict");
    }
  });
});
