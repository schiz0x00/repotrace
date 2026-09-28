/**
 * Language registry: extension detection + tree-sitter grammar wiring.
 *
 * Languages without a grammar entry (or without declarations in the grammar)
 * are handled by the fallback chunker — unsupported languages must never
 * crash an indexing job.
 */
import Parser from "tree-sitter";
import type { Language } from "tree-sitter";

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "constant"
  | "module"
  | "section";

export interface LanguageDefinition {
  id: string;
  extensions: string[];
  /** Node types that begin a symbol declaration, mapped to the symbol kind. */
  declarations?: Record<string, SymbolKind>;
  /** Node types for call sites (name extracted from the `function` field). */
  callNodeTypes?: string[];
  /** Node types that reference an imported module. */
  importNodeTypes?: string[];
  /** Node type that is a file-scoped module/namespace container (if any). */
  moduleNodeTypes?: string[];
  /** Loads the tree-sitter language object (sync or async). */
  loadGrammar: () => Promise<unknown> | unknown;
}

/**
 * Resolves a tree-sitter grammar module to the object `Parser.setLanguage`
 * actually accepts.
 *
 * There is no single export shape. `tree-sitter-typescript` and
 * `tree-sitter-php` export the language under a name (`{ typescript, tsx }`,
 * `{ php, php_only }`); every other grammar's `module.exports` *is* the
 * Language object, and merely carries enumerable `language` and
 * `nodeTypeInfo` properties alongside it. Under ESM, a CJS package arrives as
 * `{ default: exports }` — but the exact nesting differs between plain node,
 * vitest and a bundled build.
 *
 * The previous code guessed, by looking up the named export and otherwise
 * returning the module. The guess was wrong in both directions, and it failed
 * *silently*: a wrong shape made `preloadGrammars` swallow the error, the
 * language never entered the cache, and every file of that language was
 * indexed with zero symbols and zero relationships while the job still
 * reported success. The majority of the declared AST languages were affected.
 *
 * So rather than guess, try each plausible shape and keep the first one the
 * parser actually accepts. A grammar that cannot be resolved returns
 * undefined, which `preloadGrammars` logs and `unavailableGrammars()` reports
 * instead of hiding.
 */
async function loadGrammarModule(
  pkg: string,
  named?: string[],
): Promise<unknown> {
  const mod = (await import(pkg)) as Record<string, unknown>;
  const root = (mod.default ?? mod) as Record<string, unknown>;
  const inner = (root?.default as Record<string, unknown> | undefined) ?? root;

  const candidates: unknown[] = [];
  if (named) {
    for (const name of named) {
      candidates.push(root?.[name], inner?.[name], mod[name]);
    }
  }
  // The module object itself is the Language for every non-named grammar, and
  // is a valid fallback for the named ones too.
  candidates.push(mod, root, inner);

  for (const candidate of candidates) {
    if (candidate && isUsableGrammar(candidate)) return candidate;
  }
  return undefined;
}

/** Whether the parser actually accepts this object as a language. */
function isUsableGrammar(candidate: unknown): boolean {
  try {
    const parser = new Parser();
    parser.setLanguage(candidate as Language);
    // setLanguage alone is not proof. Under a bundler or a test runner's
    // module interop the ESM namespace object itself can be accepted here and
    // then fail on any real input, so parse actual tokens: an empty string
    // short-circuits before the grammar's node table is ever touched, which
    // let a broken candidate through.
    const tree = parser.parse("a");
    return typeof tree.rootNode.type === "string" && tree.rootNode.type.length > 0;
  } catch {
    return false;
  }
}

const grammarModules: Record<string, () => Promise<unknown> | unknown> = {
  typescript: () => loadGrammarModule("tree-sitter-typescript", ["typescript"]),
  tsx: () => loadGrammarModule("tree-sitter-typescript", ["tsx"]),
  javascript: () => loadGrammarModule("tree-sitter-javascript"),
  python: () => loadGrammarModule("tree-sitter-python"),
  go: () => loadGrammarModule("tree-sitter-go", ["go"]),
  rust: () => loadGrammarModule("tree-sitter-rust", ["rust"]),
  java: () => loadGrammarModule("tree-sitter-java", ["java"]),
  c: () => loadGrammarModule("tree-sitter-c", ["c"]),
  cpp: () => loadGrammarModule("tree-sitter-cpp", ["cpp"]),
  csharp: () => loadGrammarModule("tree-sitter-c-sharp"),
  php: () => loadGrammarModule("tree-sitter-php", ["php"]),
  ruby: () => loadGrammarModule("tree-sitter-ruby", ["ruby"]),
  bash: () => loadGrammarModule("tree-sitter-bash", ["bash"]),
  json: () => loadGrammarModule("tree-sitter-json", ["json"]),
  css: () => loadGrammarModule("tree-sitter-css"),
  html: () => loadGrammarModule("tree-sitter-html", ["html"]),
};

const tsDeclarations: Record<string, SymbolKind> = {
  class_declaration: "class",
  abstract_class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  type_alias_declaration: "type",
  function_declaration: "function",
  generator_function_declaration: "function",
  method_definition: "method",
  method_signature: "method",
  function_signature: "function",
  lexical_declaration: "constant",
  variable_declaration: "constant",
  public_field_definition: "constant",
  module: "module",
  namespace_declaration: "module",
};

export const LANGUAGES: Record<string, LanguageDefinition> = {
  typescript: {
    id: "typescript",
    extensions: [".ts", ".mts", ".cts"],
    declarations: tsDeclarations,
    callNodeTypes: ["call_expression", "new_expression"],
    importNodeTypes: ["import_statement"],
    loadGrammar: grammarModules.typescript,
  },
  tsx: {
    id: "tsx",
    extensions: [".tsx"],
    declarations: tsDeclarations,
    callNodeTypes: ["call_expression", "new_expression"],
    importNodeTypes: ["import_statement"],
    loadGrammar: grammarModules.tsx,
  },
  javascript: {
    id: "javascript",
    extensions: [".js", ".mjs", ".cjs", ".jsx"],
    declarations: {
      class_declaration: "class",
      interface_declaration: "interface",
      function_declaration: "function",
      generator_function_declaration: "function",
      method_definition: "method",
      lexical_declaration: "constant",
      variable_declaration: "constant",
      public_field_definition: "constant",
      module: "module",
    },
    callNodeTypes: ["call_expression", "new_expression"],
    importNodeTypes: ["import_statement"],
    loadGrammar: grammarModules.javascript,
  },
  python: {
    id: "python",
    extensions: [".py"],
    declarations: {
      function_definition: "function",
      class_definition: "class",
      decorated_definition: "function",
      type_alias_statement: "type",
    },
    callNodeTypes: ["call"],
    importNodeTypes: ["import_statement", "import_from_statement"],
    loadGrammar: grammarModules.python,
  },
  go: {
    id: "go",
    extensions: [".go"],
    declarations: {
      function_declaration: "function",
      method_declaration: "method",
      type_declaration: "type",
      const_declaration: "constant",
      var_declaration: "constant",
    },
    callNodeTypes: ["call_expression"],
    importNodeTypes: ["import_spec"],
    loadGrammar: grammarModules.go,
  },
  rust: {
    id: "rust",
    extensions: [".rs"],
    declarations: {
      function_item: "function",
      struct_item: "class",
      enum_item: "enum",
      impl_item: "module",
      type_item: "type",
      const_item: "constant",
      static_item: "constant",
      mod_item: "module",
      trait_item: "interface",
    },
    callNodeTypes: ["call_expression"],
    importNodeTypes: ["use_declaration", "extern_crate_declaration"],
    loadGrammar: grammarModules.rust,
  },
  java: {
    id: "java",
    extensions: [".java"],
    declarations: {
      class_declaration: "class",
      interface_declaration: "interface",
      enum_declaration: "enum",
      annotation_type_declaration: "interface",
      record_declaration: "class",
      method_declaration: "method",
      constructor_declaration: "method",
      field_declaration: "constant",
      constant_declaration: "constant",
      package_declaration: "module",
      module_declaration: "module",
    },
    callNodeTypes: ["method_invocation", "object_creation_expression"],
    importNodeTypes: ["import_declaration"],
    loadGrammar: grammarModules.java,
  },
  c: {
    id: "c",
    extensions: [".c", ".h"],
    declarations: {
      function_definition: "function",
      struct_specifier: "class",
      enum_specifier: "enum",
      typedef: "type",
      declaration: "constant",
    },
    callNodeTypes: ["call_expression"],
    importNodeTypes: ["preproc_include"],
    loadGrammar: grammarModules.c,
  },
  cpp: {
    id: "cpp",
    extensions: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
    declarations: {
      function_definition: "function",
      class_specifier: "class",
      struct_specifier: "class",
      enum_specifier: "enum",
      alias_declaration: "type",
      typedef: "type",
      namespace_definition: "module",
      concept_definition: "interface",
      declaration: "constant",
    },
    callNodeTypes: ["call_expression"],
    importNodeTypes: ["preproc_include"],
    loadGrammar: grammarModules.cpp,
  },
  csharp: {
    id: "csharp",
    extensions: [".cs"],
    declarations: {
      class_declaration: "class",
      interface_declaration: "interface",
      enum_declaration: "enum",
      record_declaration: "class",
      struct_declaration: "class",
      delegate_declaration: "type",
      method_declaration: "method",
      constructor_declaration: "method",
      destructor_declaration: "method",
      property_declaration: "constant",
      field_declaration: "constant",
      enum_member_declaration: "constant",
      namespace_declaration: "module",
      file_scoped_namespace_declaration: "module",
    },
    callNodeTypes: ["invocation_expression"],
    importNodeTypes: ["using_directive"],
    loadGrammar: grammarModules.csharp,
  },
  php: {
    id: "php",
    extensions: [".php"],
    declarations: {
      function_definition: "function",
      method_declaration: "method",
      class_declaration: "class",
      interface_declaration: "interface",
      trait_declaration: "class",
      enum_declaration: "enum",
      const_declaration: "constant",
      property_declaration: "constant",
      namespace_definition: "module",
    },
    callNodeTypes: ["function_call_expression", "member_call_expression", "scoped_call_expression"],
    importNodeTypes: ["namespace_use_declaration", "use_declaration"],
    loadGrammar: grammarModules.php,
  },
  ruby: {
    id: "ruby",
    extensions: [".rb"],
    declarations: {
      method: "method",
      singleton_method: "method",
      class: "class",
      module: "module",
    },
    callNodeTypes: ["call"],
    importNodeTypes: [],
    loadGrammar: grammarModules.ruby,
  },
  bash: {
    id: "bash",
    extensions: [".sh", ".bash", ".zsh"],
    declarations: {
      function_definition: "function",
      declaration_command: "constant",
    },
    callNodeTypes: ["command"],
    importNodeTypes: [],
    loadGrammar: grammarModules.bash,
  },
  json: {
    id: "json",
    extensions: [".json", ".jsonc"],
    loadGrammar: grammarModules.json,
  },
  css: {
    id: "css",
    extensions: [".css", ".scss", ".sass", ".less"],
    loadGrammar: grammarModules.css,
  },
  html: {
    id: "html",
    extensions: [".html", ".htm", ".vue", ".svelte"],
    loadGrammar: grammarModules.html,
  },
  markdown: {
    id: "markdown",
    extensions: [".md", ".mdx", ".markdown"],
    loadGrammar: () => undefined,
  },
  yaml: {
    id: "yaml",
    extensions: [".yaml", ".yml"],
    loadGrammar: () => undefined,
  },
  toml: {
    id: "toml",
    extensions: [".toml"],
    loadGrammar: () => undefined,
  },
  sql: {
    id: "sql",
    extensions: [".sql"],
    loadGrammar: () => undefined,
  },
  dockerfile: {
    id: "dockerfile",
    extensions: ["Dockerfile", "Containerfile"],
    loadGrammar: () => undefined,
  },
  makefile: {
    id: "makefile",
    extensions: ["Makefile", "makefile", "GNUMakefile"],
    loadGrammar: () => undefined,
  },
};

/** All language entries including alias-style entries (tsx etc.). */
export function allLanguages(): LanguageDefinition[] {
  return Object.values(LANGUAGES);
}

/** Languages with full AST/symbol support. */
export function astLanguages(): string[] {
  return Object.values(LANGUAGES)
    .filter((l) => l.declarations && Object.keys(l.declarations).length > 0)
    .map((l) => l.id);
}

export interface DetectedLanguage {
  id: string;
  definition: LanguageDefinition;
  /** True when the grammar supports AST symbol extraction. */
  supportsAst: boolean;
}

/** Detects the language of a file path; falls back to a generic definition. */
export function detectLanguage(path: string): DetectedLanguage {
  const basename = path.split("/").pop() ?? path;
  for (const def of Object.values(LANGUAGES)) {
    if (def.extensions.some((ext) => basename.endsWith(ext))) {
      return { id: def.id, definition: def, supportsAst: !!def.declarations };
    }
  }
  return {
    id: "text",
    definition: { id: "text", extensions: [], loadGrammar: () => undefined },
    supportsAst: false,
  };
}

// Re-exported for callers that already import the language registry. The
// implementation lives in file-category.ts so the search layer can use it
// without importing the native tree-sitter addon into the server bundle.
export { fileCategory } from "@/lib/indexing/file-category";
