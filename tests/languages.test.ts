import { describe, expect, it } from "vitest";
import { astLanguages, detectLanguage, fileCategory, LANGUAGES, type SymbolKind } from "@/lib/indexing/languages";

const SYMBOL_KINDS: SymbolKind[] = ["function", "method", "class", "interface", "type", "enum", "constant", "module", "section"];

describe("detectLanguage", () => {
  it("detects code languages with AST support", () => {
    const ts = detectLanguage("src/orders/model.ts");
    expect(ts.id).toBe("typescript");
    expect(ts.supportsAst).toBe(true);

    expect(detectLanguage("app.tsx").id).toBe("tsx");
    expect(detectLanguage("main.js").id).toBe("javascript");
    expect(detectLanguage("lib/util.py").id).toBe("python");
    expect(detectLanguage("routes/api.go").id).toBe("go");
  });

  it("detects markdown/configuration languages without AST support", () => {
    for (const [path, id] of [
      ["README.md", "markdown"],
      ["docs/guide.mdx", "markdown"],
      ["config.yaml", "yaml"],
      ["package.json", "json"],
      ["pyproject.toml", "toml"],
      ["Dockerfile", "dockerfile"],
      ["Makefile", "makefile"],
    ] as const) {
      const detected = detectLanguage(path);
      expect(detected.id).toBe(id);
      expect(detected.supportsAst).toBe(false);
    }
  });

  it("falls back to text for unknown extensions", () => {
    const detected = detectLanguage("assets/logo.xyz");
    expect(detected.id).toBe("text");
    expect(detected.supportsAst).toBe(false);
  });
});

describe("fileCategory", () => {
  it("classifies code files", () => {
    expect(fileCategory("src/orders/service.ts")).toBe("code");
    expect(fileCategory("lib/notify.py")).toBe("code");
  });

  it("classifies test files by naming convention", () => {
    expect(fileCategory("src/orders/orders.test.ts")).toBe("test");
    expect(fileCategory("src/orders/orders.spec.ts")).toBe("test");
    expect(fileCategory("test_orders.py")).toBe("test");
    expect(fileCategory("src/orders/orders_test.py")).toBe("test");
    // ponytail: fileCategory inspects the basename only, so a __tests__
    // directory segment is invisible here (dead regex branch in prod).
    expect(fileCategory("src/__tests__/orders.ts")).toBe("code");
  });

  it("classifies documentation files", () => {
    expect(fileCategory("README.md")).toBe("documentation");
    expect(fileCategory("docs/guide.md")).toBe("documentation");
    expect(fileCategory("notes.rst")).toBe("documentation");
    expect(fileCategory("docs/architecture.txt")).toBe("documentation");
  });

  it("classifies configuration files", () => {
    expect(fileCategory("package.json")).toBe("configuration");
    expect(fileCategory("tsconfig.json")).toBe("configuration");
    expect(fileCategory("config.yaml")).toBe("configuration");
    expect(fileCategory("pyproject.toml")).toBe("configuration");
    expect(fileCategory("Dockerfile")).toBe("configuration");
    expect(fileCategory(".env")).toBe("configuration");
    expect(fileCategory("Makefile")).toBe("configuration");
  });
});

describe("symbol kinds", () => {
  it("normalizes every declared node kind to a valid SymbolKind", () => {
    for (const def of Object.values(LANGUAGES)) {
      for (const [nodeType, kind] of Object.entries(def.declarations ?? {})) {
        expect(SYMBOL_KINDS, `${def.id}.${nodeType} -> ${kind}`).toContain(kind);
      }
    }
  });

  it("reports the expected AST-supporting language set", () => {
    const ast = astLanguages();
    expect(ast).toContain("typescript");
    expect(ast).toContain("python");
    expect(ast).not.toContain("markdown");
  });
});