import { beforeAll, describe, expect, it } from "vitest";
import { parseFile, preloadGrammars } from "@/lib/indexing/parser";
import {
  CancelledError,
  STALE_SCAN_PAGE_SIZE,
  createSyncStatusGuard,
  scanStaleFiles,
} from "@/lib/indexing/pipeline";

/**
 * Regression tests for the two halves of the indexing pipeline that decide what
 * ends up in the symbol index and what happens to a repository's `syncStatus`
 * when a run does not finish. Both are pure with respect to the network and the
 * database: the parser talks to tree-sitter, and the pipeline helpers are
 * driven with an injected page fetcher and an injected state writer.
 */
describe("module-scope constants", () => {
  beforeAll(async () => {
    await preloadGrammars();
  });

  const names = (path: string, source: string) =>
    parseFile(path, source).symbols.map((s) => s.qualifiedName);

  /**
   * The top-level test used to look at the immediate parent only. In the TS
   * grammar an exported constant's parent is an `export_statement`, not the
   * `program` node, so `export const` / `export let` / `export var` produced no
   * symbol at all — the constants a module exists to export were the one kind
   * of declaration the index dropped.
   */
  it("emits exported typescript constants", () => {
    const found = names(
      "src/config.ts",
      [
        "export const A = 1;",
        "export let B = 2;",
        "export var C = 3;",
        "const D = 4;",
      ].join("\n"),
    );
    expect(found).toContain("A");
    expect(found).toContain("B");
    expect(found).toContain("C");
    expect(found).toContain("D");
  });

  it("emits exported javascript constants", () => {
    expect(names("src/config.js", "export const A = 1;\n")).toContain("A");
  });

  it("emits an ambient exported constant", () => {
    expect(names("src/types.ts", "export declare const PORT: number;\n")).toContain("PORT");
  });

  it("emits constants inside a namespace", () => {
    const found = names("src/ns.ts", "export namespace N { const inner = 1; }\n");
    expect(found).toContain("inner");
  });

  it("still drops function locals", () => {
    const found = names(
      "src/locals.ts",
      ["function f() {", "  const local = 1;", "  return local;", "}"].join("\n"),
    );
    expect(found).toContain("f");
    expect(found).not.toContain("local");
  });

  it("still drops class fields", () => {
    const found = names("src/model.ts", ["class K {", "  static s = 1;", "  i = 2;", "}"].join("\n"));
    expect(found).toContain("K");
    expect(found).not.toContain("K.s");
    expect(found).not.toContain("K.i");
  });

  it("emits file-root constants in the grammars that hang them off a root node", () => {
    expect(names("a.go", "package m\nconst A = 1\nvar B = 2\n")).toEqual(
      expect.arrayContaining(["A", "B"]),
    );
    expect(names("a.c", "int A = 1;\n")).toContain("A");
    expect(names("a.rs", "const A: u32 = 1;\n")).toContain("A");
    expect(names("a.php", "<?php const A = 1;\n")).toContain("A");
  });

  it("drops locals in those grammars too", () => {
    expect(names("a.c", "void f(void) { int local = 2; (void)local; }\n")).not.toContain("local");
    expect(names("a.rs", "fn f() { let local = 1; }\n")).not.toContain("local");
  });
});

describe("stale-file reconciliation", () => {
  /**
   * Stands in for `db.file.findMany({ where: { repositoryId, path: { gt: after } },
   * orderBy: { path: "asc" }, take: PAGE })` over a sorted array, and records
   * every cursor it was handed so the test can assert the scan never asks for
   * a parameter list proportional to the repository.
   */
  function fakeIndex(paths: string[], deleted: Set<string> = new Set()) {
    const cursors: Array<string | null> = [];
    // Ordered the way `orderBy: { path: "asc" }` would return them, so the
    // keyset comparison in the scan is exercised against a real ordering.
    const sorted = [...paths].sort();
    const remaining = () => sorted.filter((p) => !deleted.has(p));
    return {
      cursors,
      deleted,
      fetchPage: async (after: string | null) => {
        cursors.push(after);
        const live = remaining();
        if (after === null) return live.slice(0, STALE_SCAN_PAGE_SIZE).map((path) => ({ path }));
        const start = live.findIndex((p) => p > after);
        if (start < 0) return [];
        return live.slice(start, start + STALE_SCAN_PAGE_SIZE).map((path) => ({ path }));
      },
    };
  }

  it("visits only the indexed paths git no longer tracks", async () => {
    const index = fakeIndex(["a.ts", "b.ts", "gone.ts", "z.ts"]);
    const visited: string[] = [];
    const count = await scanStaleFiles(
      new Set(["a.ts", "b.ts", "z.ts"]),
      index.fetchPage,
      async (path) => {
        visited.push(path);
      },
    );
    expect(visited).toEqual(["gone.ts"]);
    expect(count).toBe(1);
  });

  it("pages with a bounded cursor instead of an N-element IN-list", async () => {
    const paths = Array.from({ length: STALE_SCAN_PAGE_SIZE * 3 + 7 }, (_, i) =>
      `src/file-${String(i).padStart(5, "0")}.ts`,
    );
    const index = fakeIndex(paths);
    const visited: string[] = [];
    await scanStaleFiles(new Set(paths), index.fetchPage, async (path) => {
      visited.push(path);
    });
    expect(visited).toEqual([]);
    // One empty page at the end, one per page of rows, and every cursor is a
    // single path — the scan never carries the tracked set to the database.
    expect(index.cursors.length).toBe(Math.ceil(paths.length / STALE_SCAN_PAGE_SIZE) + 1);
    for (const cursor of index.cursors) {
      if (cursor === null) continue;
      expect(paths).toContain(cursor);
    }
  });

  it("deletes as it goes without revisiting a removed row", async () => {
    const paths = Array.from({ length: STALE_SCAN_PAGE_SIZE + 5 }, (_, i) => `f${i}.ts`);
    const index = fakeIndex(paths);
    const visited: string[] = [];
    const count = await scanStaleFiles(
      new Set(),
      index.fetchPage,
      async (path) => {
        visited.push(path);
        index.deleted.add(path);
      },
    );
    expect(count).toBe(paths.length);
    expect([...visited].sort()).toEqual([...paths].sort());
    expect(new Set(visited).size).toBe(visited.length);
  });

  it("stops rather than spinning when the fetcher ignores the cursor", async () => {
    let calls = 0;
    const count = await scanStaleFiles(new Set(), async () => {
      calls += 1;
      if (calls > 10) throw new Error("runaway scan");
      return [{ path: "a.ts" }];
    }, async () => {});
    expect(count).toBe(1);
    expect(calls).toBe(2);
  });
});

describe("terminal sync status", () => {
  it("records a thrown error as terminal", async () => {
    const applied: Array<{ syncStatus: string; syncError: string; cancelled: boolean }> = [];
    const guard = createSyncStatusGuard(async (state) => {
      applied.push(state);
    });
    await guard.fail(new Error("qdrant unreachable"));
    expect(applied).toEqual([
      {
        syncStatus: "error",
        syncError: "Index failed: qdrant unreachable",
        cancelled: false,
      },
    ]);
  });

  // A cancellation must be distinguishable from a failure. The project status
  // is derived from `cancelled`, and getting it wrong marked a deliberately
  // cancelled project as errored — which the scheduled-sync sweep then treated
  // as broken and never synced again.
  it("marks a cancelled run as cancelled, not as an error", async () => {
    const applied: Array<{ syncStatus: string; syncError: string; cancelled: boolean }> = [];
    const guard = createSyncStatusGuard(async (state) => {
      applied.push(state);
    });
    await guard.fail(new CancelledError());
    expect(applied).toHaveLength(1);
    expect(applied[0]!.syncError).toMatch(/cancelled/i);
    expect(applied[0]!.cancelled).toBe(true);
  });

  it("leaves a status that was already finalized alone", async () => {
    const applied: string[] = [];
    const guard = createSyncStatusGuard(async (state) => {
      applied.push(state.syncError);
    });
    guard.finalized();
    await guard.fail(new Error("pruneWorkspaces failed after the run completed"));
    expect(applied).toEqual([]);
  });

  it("still fails cleanly when writing the status itself fails", async () => {
    const guard = createSyncStatusGuard(async () => {
      throw new Error("database is down");
    });
    await expect(guard.fail(new Error("original"))).resolves.toBeUndefined();
  });

  // The title used to say "the syncError column", implying a length limit the
  // schema does not have: syncError is TEXT. The cap is self-imposed.
  it("caps a non-Error throw to a length the dashboard can render", async () => {
    const applied: Array<{ syncError: string }> = [];
    const guard = createSyncStatusGuard(async (state) => {
      applied.push(state);
    });
    await guard.fail("x".repeat(5000));
    expect(applied[0]!.syncError.length).toBeLessThanOrEqual("Index failed: ".length + 2000);
  });
});
