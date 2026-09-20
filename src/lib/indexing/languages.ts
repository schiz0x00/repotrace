/**
 * Language registry: extension detection + tree-sitter grammar wiring.
 *
 * Languages without a grammar entry (or without declarations in the grammar)
 * are handled by the fallback chunker — unsupported languages must never
 * crash an indexing job.
 */

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
 * Loads a grammar module and unwraps its exports. CJS packages surface as
 * { default: exports } under ESM dynamic import; some grammars export named
 * languages (typescript -> { typescript, tsx }) while others export the
 * language directly or as default.language.
 */
async function loadGrammarModule(
  pkg: string,
  named?: string[],
  isEsm?: boolean,
): Promise<unknown> {
  const mod: any = await import(pkg);
  const exports_ = mod.default ?? mod;
  if (named) {
    for (const name of named) {
      const candidate = exports_[name] ?? exports_.default?.[name];
      if (candidate) return candidate;
    }
    return undefined;
  }
  if (isEsm) return exports_.language ?? exports_.default?.language;
  return exports_.language ?? exports_ ?? undefined;
}

const grammarModules: Record<string, () => Promise<unknown> | unknown> = {
  typescript: () => loadGrammarModule("tree-sitter-typescript", ["typescript"]),
  tsx: () => loadGrammarModule("tree-sitter-typescript", ["tsx"]),
  javascript: () => loadGrammarModule("tree-sitter-javascript", ["javascript"]),
  python: () => loadGrammarModule("tree-sitter-python", ["python"]),
  go: () => loadGrammarModule("tree-sitter-go", ["go"]),
  rust: () => loadGrammarModule("tree-sitter-rust", ["rust"]),
  java: () => loadGrammarModule("tree-sitter-java", ["java"]),
  c: () => loadGrammarModule("tree-sitter-c", ["c"]),
  cpp: () => loadGrammarModule("tree-sitter-cpp", ["cpp"]),
  csharp: () => loadGrammarModule("tree-sitter-c-sharp", undefined, true),
  php: () => loadGrammarModule("tree-sitter-php", ["php"]),
  ruby: () => loadGrammarModule("tree-sitter-ruby", ["ruby"]),
  bash: () => loadGrammarModule("tree-sitter-bash", ["bash"]),
  json: () => loadGrammarModule("tree-sitter-json", ["json"]),
  css: () => loadGrammarModule("tree-sitter-css", undefined, true),
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

/** Classifies a file by path: code, test, documentation, or configuration. */
export function fileCategory(path: string): "code" | "test" | "documentation" | "configuration" {
  const base = path.split("/").pop() ?? path;
  if (/\.(test|spec)\.[a-z0-9]+$|_test\.[a-z0-9]+$|\.tests?\.[a-z0-9]+$|^test_|__tests__|_test\.py$|\.test\.|\.spec\./.test(base)) {
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