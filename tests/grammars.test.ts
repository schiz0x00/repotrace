import { describe, expect, it } from "vitest";
import { LANGUAGES, detectLanguage } from "@/lib/indexing/languages";
import { parseFile, preloadGrammars, unavailableGrammars } from "@/lib/indexing/parser";

/**
 * Every declared language must actually produce a working tree-sitter grammar.
 *
 * `loadGrammarModule` used to unwrap each package's exports by a per-language
 * rule, and a rule that did not match the installed package's shape returned
 * `undefined`. `preloadGrammars` swallowed that, so the failure mode was not an
 * error — it was that Go, Rust, Java, Ruby, Bash, HTML, JSON and the C family
 * were indexed with *zero symbols* and silently stopped being structurally
 * searchable while every job still reported success.
 */
describe("tree-sitter grammars", () => {
  it("loads a grammar for every language that declares AST declarations", async () => {
    // markdown/yaml/toml/sql/dockerfile/makefile have no grammar package and
    // no `declarations`; they are chunked as plain text by design. Only the
    // AST languages are required to resolve.
    const astLanguages = Object.keys(LANGUAGES).filter((id) => !!LANGUAGES[id].declarations);
    expect(astLanguages.length).toBeGreaterThan(10);
    const failures: string[] = [];
    for (const id of astLanguages) {
      if (!(await LANGUAGES[id].loadGrammar())) failures.push(id);
    }
    expect(failures).toEqual([]);
  });

  it("extracts symbols from a file in every language that declares them", async () => {
    await preloadGrammars();
    // A grammar that fails to resolve makes parseFile fall back to block
    // chunking, so the symbol list comes back empty — the silent degradation.
    const samples: Record<string, string> = {
      typescript: "export function alpha(): number { return 1; }\n",
      tsx: "export function alpha(): number { return 1; }\n",
      javascript: "function alpha() { return 1; }\n",
      python: "def alpha():\n    return 1\n",
      go: "package main\n\nfunc Alpha() int { return 1 }\n",
      rust: "pub fn alpha() -> i32 { 1 }\n",
      java: "class Alpha { int alpha() { return 1; } }\n",
      c: "int alpha(void) { return 1; }\n",
      cpp: "int alpha() { return 1; }\n",
      csharp: "class Alpha { int Alpha() { return 1; } }\n",
      php: "<?php\nfunction alpha() { return 1; }\n",
      ruby: "def alpha\n  1\nend\n",
      bash: "alpha() {\n  echo 1\n}\n",
      json: '{ "alpha": 1 }\n',
      css: ".alpha { color: red; }\n",
      html: "<div class=\"alpha\"></div>\n",
    };

    const failures: string[] = [];
    for (const [id, source] of Object.entries(samples)) {
      const path = `sample.${EXTENSIONS[id]}`;
      const detected = detectLanguage(path);
      if (detected.id !== id) {
        failures.push(`${id} (detected as ${detected.id})`);
        continue;
      }
      // json/css/html have grammars but declare no extractable symbol node
      // types, so producing no symbols is correct for them. Only languages
      // that declare `declarations` are required to yield one.
      if (!LANGUAGES[id].declarations) continue;
      try {
        if (parseFile(path, source).symbols.length === 0) failures.push(`${id} (no symbols)`);
      } catch (err) {
        failures.push(`${id} (threw: ${(err as Error).message.split("\n")[0].slice(0, 60)})`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("reports no unavailable grammars after preloading", async () => {
    await preloadGrammars();
    expect(unavailableGrammars()).toEqual([]);
  });

  it("maps extensions to declared languages", () => {
    expect(detectLanguage("main.go").id).toBe("go");
    expect(detectLanguage("lib.rs").id).toBe("rust");
    expect(detectLanguage("App.java").id).toBe("java");
    expect(detectLanguage("app.rb").id).toBe("ruby");
    expect(detectLanguage("run.sh").id).toBe("bash");
    // An unknown extension is not an error; it falls back to block chunking.
    expect(detectLanguage("data.unknownext").supportsAst).toBe(false);
  });

  // The pipeline guards `parseFile` and falls back to block chunking, because a
  // throw there used to abort the entire index job. This pins the property that
  // guard relies on: a real grammar must not throw on malformed source, so the
  // fallback is for the pathological case and not the everyday one.
  it("does not throw on malformed source in any language", async () => {
    await preloadGrammars();
    const garbage = [
      "",
      "   \n\n\t",
      "function ( { [ <<< }}}",
      "class extends implements interface {",
      "\u0000\u0001\u0002",
      "def f(:\n  return ???",
      "<?php class extends {",
      "x".repeat(50_000),
    ];
    const failures: string[] = [];
    for (const id of Object.keys(LANGUAGES)) {
      const ext = EXTENSIONS[id];
      if (!ext) continue;
      for (const source of garbage) {
        try {
          parseFile(`sample.${ext}`, source);
        } catch (err) {
          failures.push(`${id}: ${(err as Error).message.split("\n")[0].slice(0, 60)}`);
          break;
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

/** Sample file extension per declared language id. */
const EXTENSIONS: Record<string, string> = {
  typescript: "ts",
  tsx: "tsx",
  javascript: "js",
  python: "py",
  go: "go",
  rust: "rs",
  java: "java",
  c: "c",
  cpp: "cpp",
  csharp: "cs",
  php: "php",
  ruby: "rb",
  bash: "sh",
  json: "json",
  css: "css",
  html: "html",
};
