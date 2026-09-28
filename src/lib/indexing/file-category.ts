/**
 * File category classification: code, test, documentation or configuration.
 *
 * This lives on its own, deliberately, rather than beside the grammar registry
 * in `languages.ts`. It is pure path matching with no tree-sitter dependency,
 * and the search layer needs it to filter symbol-name hits by chunk type. When
 * it lived in `languages.ts`, importing it from the search layer pulled that
 * module — and with it the native `tree-sitter` C++ addon — into the Next.js
 * server bundle, and Turbopack refuses to place a non-ECMAScript native addon
 * in an ESM chunk. Importing this file from anywhere, including a route
 * handler, is safe.
 */
export type FileCategory = "code" | "test" | "documentation" | "configuration";

/**
 * Directory names that mark every file beneath them as test code.
 *
 * `__tests__` is, by convention, a directory name, so it is matched as a whole
 * path segment. Matching it as a substring of the basename instead (the
 * previous behaviour) both missed the case that matters —
 * `src/__tests__/orders.ts`, whose basename is `orders.ts` — and over-matched
 * files that merely have the token glued into their name, such as
 * `__tests__helper.ts`. Segment equality rejects both near misses:
 * `__tests__helper/`, `my__tests__/` and `orders__tests__.ts` are ordinary
 * code.
 */
const TEST_DIRECTORIES = new Set(["__tests__"]);

/**
 * Classifies a file by path.
 *
 * Rule order is significant and unchanged: test, then documentation, then
 * configuration, then code. A test rule that matches on a path segment
 * therefore also outranks the documentation and configuration rules — a
 * `.json` fixture under `__tests__/` is a test file, not configuration.
 */
export function fileCategory(path: string): FileCategory {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const base = segments[segments.length - 1] ?? path;
  // Only directory segments qualify: `__tests__` is never a file's own name.
  const inTestDirectory = segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment));
  if (inTestDirectory || /\.(test|spec)\.[a-z0-9]+$|_test\.[a-z0-9]+$|\.tests?\.[a-z0-9]+$|^test_|_test\.py$|\.test\.|\.spec\./.test(base)) {
    return "test";
  }
  if (/\.(md|mdx|markdown|rst|txt|adoc)$/.test(base) || /^docs?\//.test(path)) {
    return "documentation";
  }
  if (/\.(json|jsonc|yaml|yml|toml|ini|cfg|conf|config|properties|env|editorconfig|gitignore|dockerignore)$/.test(base) ||
      /^(Dockerfile|Containerfile|Makefile|makefile|GNUMakefile|\.env.*)$/.test(base) ||
      /\.(lock|lockb)$/.test(base) ||
      /^(package\.json|tsconfig.*\.json|vitest\.config.*|jest\.config.*|next\.config.*|eslint\.config.*|prettier\.config.*|biome\.json|pyproject\.toml|Cargo\.toml|go\.mod|go\.sum|requirements.*\.txt|Pipfile|poetry\.lock)$/.test(base)) {
    return "configuration";
  }
  return "code";
}

/**
 * Maps a file category onto the chunk type the indexing pipeline assigns.
 *
 * Lives beside {@link fileCategory} so the mapping has exactly one definition.
 * It was duplicated across the lexical and search legs, which is how the symbol
 * leg ended up still hardcoding "code" after the other leg was fixed.
 */
export const CATEGORY_TO_CHUNK_TYPE: Record<FileCategory, "code" | "test" | "documentation" | "configuration"> = {
  code: "code",
  test: "test",
  documentation: "documentation",
  configuration: "configuration",
};
