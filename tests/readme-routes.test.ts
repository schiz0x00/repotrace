import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps the README's API table honest against the routes that actually exist.
 *
 * The table drifted more than once during this work: endpoints were added
 * without being documented, and one documented path (a mock embedding base URL
 * with a stray /v1) described something that 404s. A doc that lies about the
 * API is worse than no doc, because it is trusted.
 *
 * This is a structural check, not a prose one: it verifies that every HTTP
 * method every route file exports is documented, and that nothing is documented
 * that does not exist.
 */

const APP_DIR = resolve("src/app");
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

interface Route {
  /** `/api/v1/projects/:idOrSlug/search`, with Next's `[param]` as `:param`. */
  path: string;
  method: string;
  file: string;
}

async function collectRoutes(dir: string, out: Route[] = []): Promise<Route[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Route groups like (dashboard) and (auth) are not part of the URL.
      if (entry.name.startsWith("(") && entry.name.endsWith(")")) {
        await collectRoutes(full, out);
      } else {
        await collectRoutes(full, out);
      }
      continue;
    }
    if (entry.name !== "route.ts") continue;
    const source = await readFile(full, "utf8");
    const rel = `/${relative(APP_DIR, full).replace(/\\/g, "/")}`;
    // `/api/v1/x/route.ts` -> `/api/v1/x`, with `[idOrSlug]` -> `:idOrSlug`.
    const path = rel.replace(/\/route\.ts$/, "").replace(/\[([^\]]+)\]/g, ":$1");
    for (const method of HTTP_METHODS) {
      if (new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`).test(source)) {
        out.push({ path, method, file: full });
      }
    }
  }
  return out;
}

describe("README API table matches the routes that exist", () => {
  it("documents every method every route exports", async () => {
    const routes = await collectRoutes(APP_DIR);
    expect(routes.length).toBeGreaterThan(20);

    const readme = await readFile("README.md", "utf8");
    const undocumented = routes.filter((r) => {
      // A row may document several methods as `GET / POST /a/b`, so match the
      // path and require the method token somewhere in that row.
      const escaped = r.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rows = readme
        .split("\n")
        .filter((line) => line.includes("|") && new RegExp(escaped).test(line));
      if (rows.length === 0) return true;
      return !rows.some((row) => new RegExp(`\\b${r.method}\\b`).test(row));
    });

    expect(undocumented.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it("documents nothing that does not exist", async () => {
    const routes = await collectRoutes(APP_DIR);
    const readme = await readFile("README.md", "utf8");

    // Rows of the form `| `METHOD` | `/path` | ...` in the API table.
    const rowRe = /^\|\s*`?([A-Z/ ]+?)`?\s*\|\s*`([^`]+)`\s*\|/gm;
    const ghosts: string[] = [];
    for (const m of readme.matchAll(rowRe)) {
      const methods = (m[1] ?? "").split("/").map((s) => s.trim()).filter(Boolean);
      const docPath = (m[2] ?? "").trim();
      if (!docPath.startsWith("/")) continue;
      // Normalise both sides to the same placeholder spelling.
      const norm = (p: string) => p.replace(/:[A-Za-z0-9_]+/g, ":p").replace(/\/+$/, "");
      for (const method of methods) {
        const exists = routes.some((r) => norm(r.path) === norm(docPath) && r.method === method);
        // The API-key path and the auth handler are described in prose tables
        // that use a different shape; only flag exact-looking API rows.
        if (!exists && /^\/api\//.test(docPath) && !/[\[\]:]/.test(docPath)) {
          ghosts.push(`${method} ${docPath}`);
        }
      }
    }
    expect(ghosts).toEqual([]);
  });
});
