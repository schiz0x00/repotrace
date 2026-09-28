/**
 * Hermetic tests for the dashboard's client fetch helpers.
 *
 * The defect these guard against is a failed request rendering as a normal
 * empty state: a 401 or 500 whose body was cast to the success shape made an
 * expired session look like a project with no files, no symbols and no jobs.
 * Every case here runs against a stubbed `fetch` — no database, no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteProject,
  getJson,
  pickDefaultProject,
  postAction,
} from "@/components/dashboard/dashboard-helpers";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const spy = vi.fn((url: unknown, init?: RequestInit) => Promise.resolve(handler(String(url), init)));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("getJson", () => {
  it("returns the parsed body on 2xx", async () => {
    stubFetch(() => jsonResponse({ projects: [{ slug: "a" }] }));
    await expect(getJson("/api/v1/projects")).resolves.toEqual({ projects: [{ slug: "a" }] });
  });

  it("throws the API's own message on 401 instead of resolving with the error body", async () => {
    // The core regression: an expired session must never reach a caller as data.
    stubFetch(() => jsonResponse({ error: { message: "Unauthorized" } }, 401));
    await expect(getJson("/api/v1/projects")).rejects.toThrow("Unauthorized");
  });

  it("falls back to the status when the error body is not JSON", async () => {
    stubFetch(() => new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }));
    await expect(getJson("/api/v1/projects")).rejects.toThrow("Request failed (502)");
  });

  it("falls back to a caller-supplied message, not the status", async () => {
    stubFetch(() => new Response("", { status: 500 }));
    await expect(getJson("/api/v1/jobs", undefined, "Could not load jobs.")).rejects.toThrow("Could not load jobs.");
  });

  it("ignores an empty API message rather than rendering a blank error", async () => {
    stubFetch(() => jsonResponse({ error: { message: "" } }, 500));
    await expect(getJson("/api/v1/projects")).rejects.toThrow("Request failed (500)");
  });

  it("propagates the init to fetch and forwards the request options", async () => {
    const spy = stubFetch(() => jsonResponse({ ok: true }));
    await getJson("/api/v1/search", { method: "POST", body: "{}" });
    expect(spy).toHaveBeenCalledWith("/api/v1/search", { method: "POST", body: "{}" });
  });

  it("propagates a transport failure rather than swallowing it", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    await expect(getJson("/api/v1/projects")).rejects.toThrow("Failed to fetch");
  });
});

describe("postAction", () => {
  it("reports the API message on a non-2xx", async () => {
    stubFetch(() => jsonResponse({ error: { message: "Job is not running" } }, 409));
    await expect(postAction("/api/v1/jobs/x/cancel")).resolves.toEqual({ ok: false, message: "Job is not running" });
  });

  it("never rejects on a transport failure, so callers cannot strand a pending button", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    const result = await postAction("/api/v1/projects/x/sync");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Failed to fetch");
  });

  it("sends the body as JSON and reports success", async () => {
    const spy = stubFetch(() => jsonResponse({}));
    await expect(postAction("/api/v1/projects/x/reindex", { type: "full" })).resolves.toEqual({ ok: true });
    expect(spy).toHaveBeenCalledWith("/api/v1/projects/x/reindex", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "full" }),
    });
  });

  it("defaults the body to an empty object", async () => {
    const spy = stubFetch(() => jsonResponse({}));
    await postAction("/api/v1/jobs/x/retry");
    expect(spy).toHaveBeenCalledWith("/api/v1/jobs/x/retry", expect.objectContaining({ body: "{}" }));
  });
});

describe("deleteProject", () => {
  it("falls back to its own message when the body carries none", async () => {
    stubFetch(() => new Response("", { status: 403 }));
    await expect(deleteProject("demo")).resolves.toEqual({ ok: false, message: "Delete failed." });
  });

  it("never rejects on a transport failure", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    await expect(deleteProject("demo")).resolves.toEqual({ ok: false, message: "Failed to fetch" });
  });

  it("reports success for a 2xx", async () => {
    const spy = stubFetch(() => new Response(null, { status: 202 }));
    await expect(deleteProject("demo")).resolves.toEqual({ ok: true });
    expect(spy).toHaveBeenCalledWith("/api/v1/projects/demo", { method: "DELETE" });
  });
});

describe("pickDefaultProject", () => {
  it("preselects the first project when nothing is chosen", () => {
    expect(pickDefaultProject("", [{ slug: "alpha" }, { slug: "beta" }])).toBe("alpha");
  });

  it("keeps an existing choice — the ?project= parameter or a later selection", () => {
    expect(pickDefaultProject("beta", [{ slug: "alpha" }, { slug: "beta" }])).toBe("beta");
  });

  it("returns an empty string when there is nothing to select", () => {
    expect(pickDefaultProject("", [])).toBe("");
  });

  it("is idempotent, so re-applying the default cannot change the selection", () => {
    // The effect that calls this used to list `project` in its dependency list,
    // which refetched /api/v1/projects on every application of the default.
    const projects = [{ slug: "alpha" }];
    const first = pickDefaultProject("", projects);
    expect(pickDefaultProject(first, projects)).toBe(first);
  });
});
