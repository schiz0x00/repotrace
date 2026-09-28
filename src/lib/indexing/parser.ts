import Parser from "tree-sitter";
import type { Language } from "tree-sitter";
import { LANGUAGES, detectLanguage, fileCategory, type SymbolKind } from "@/lib/indexing/languages";
import type { ChunkType } from "@/generated/prisma/enums";

export interface ParsedSymbol {
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  parentName: string | null;
  calls: string[];
  imports: string[];
  extends: string[];
  implements: string[];
}

export interface ParsedChunk {
  /** Qualified symbol name when this chunk is a symbol body, else null. */
  symbolName: string | null;
  kind: string;
  startLine: number;
  endLine: number;
  content: string;
  chunkType: ChunkType;
}

export interface ParsedFile {
  language: string;
  symbols: ParsedSymbol[];
  chunks: ParsedChunk[];
  /** Non-fatal parse note; indexing continues with fallback chunking. */
  error: string | null;
}

export const MAX_CHUNK_LINES = 150;

interface DeclNode {
  node: Parser.SyntaxNode;
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  parentName: string | null;
  startLine: number;
  endLine: number;
}

const NAME_NODE_TYPES = new Set([
  "identifier",
  "property_identifier",
  "type_identifier",
  "name",
  "function_name",
  "method_name",
  "class_name",
  "interface_name",
  "enum_name",
  "struct_name",
  "module_name",
  "constant_name",
  "variable_name",
  "statement_identifier",
]);

/** Resolved grammars, populated by {@link preloadGrammars} before parsing. */
const grammarCache = new Map<string, Language>();

/**
 * Node types that sit between a module-scope declaration and the file root
 * without opening a scope of their own.
 *
 * The top-level test used to look only at the immediate parent, which is wrong
 * for every grammar that wraps its file-level declarations. `export const x = 1`
 * is an `export_statement` around a `lexical_declaration`, not a
 * `lexical_declaration` under `program` — so every exported constant in a
 * TypeScript or JavaScript file read as a declaration inside something and was
 * dropped from the symbol index. The file roots themselves are listed too, for
 * the grammars that do hang a declaration directly off one (C:
 * `translation_unit`, Go: `source_file`, bash: `program`).
 */
const TRANSPARENT_WRAPPERS = new Set([
  "export_statement", // `export const x = 1`
  "ambient_declaration", // `export declare const x: number`
  "expression_statement", // `namespace N { … }` is an expression statement
  "internal_module", // …wrapping the `namespace N { … }` body container
  "program",
  "source_file",
  "translation_unit",
  "compilation_unit",
  "body",
  "module", // Python's root, and the TS ambient `module "x" { … }`
]);

/**
 * Node types that open a scope. A constant inside one is a local — a function
 * temporary or a class member — not a module-level constant, and emitting those
 * would fill the symbol index with every `i` in every loop in the repository.
 */
const SCOPE_BLOCK_TYPES = new Set([
  "statement_block", // TS/JS/Java braces
  "block", // Go
  "compound_statement", // C, C++, bash
  "statement_list",
  "class_body", // TS/JS class members
  "declaration_list", // C#, PHP class members
  "field_declaration_list",
]);

/**
 * Whether a constant declaration sits at module scope.
 *
 * Walks up from the declaration rather than testing only the immediate parent,
 * because a file-root declaration is not always a direct child of the root (see
 * {@link TRANSPARENT_WRAPPERS}). The walk passes through wrappers, and through
 * the body of a namespace — its members are module scope — and stops at the
 * first node that opens a real scope: a function body, a class body, or
 * anything else that is neither a wrapper nor a file root.
 *
 * `namespace N { const x = 1 }` is the case that needs the block type to be
 * qualified: the TS grammar gives the namespace body the same `statement_block`
 * node as a function body, and only the owner of the block tells them apart.
 */
function isModuleScope(
  node: Parser.SyntaxNode,
  root: Parser.SyntaxNode,
  declarations: Record<string, SymbolKind>,
): boolean {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current === root) return true;
    if (TRANSPARENT_WRAPPERS.has(current.type)) {
      current = current.parent;
      continue;
    }
    if (SCOPE_BLOCK_TYPES.has(current.type)) {
      const owner = current.parent;
      const ownerIsNamespace = !!owner && (declarations[owner.type] === "module" || owner.type === "internal_module");
      if (!ownerIsNamespace) return false;
      current = owner;
      continue;
    }
    // A namespace reached without an intervening block node. Its members are
    // module scope; a class's are not, and neither are a function's locals.
    if (declarations[current.type] === "module") {
      current = current.parent;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Parses a file with tree-sitter, extracting symbols (declarations),
 * relationships (calls, imports) and semantic chunks. Falls back to plain
 * block chunking when the language lacks AST support or parsing fails —
 * a malformed file never aborts an indexing job.
 */
export function parseFile(path: string, content: string): ParsedFile {
  const { id, supportsAst } = detectLanguage(path);
  const category = fileCategory(path);

  if (!supportsAst || id === "markdown") {
    if (id === "markdown") return parseMarkdown(path, content);
    return {
      language: id,
      symbols: [],
      chunks: fallbackChunks(content, category),
      error: null,
    };
  }

  const grammar = grammarCache.get(id);
  if (!grammar) {
    return {
      language: id,
      symbols: [],
      chunks: fallbackChunks(content, category),
      error: `No tree-sitter grammar for language "${id}"`,
    };
  }

  let tree: Parser.Tree;
  try {
    const parser = new Parser();
    parser.setLanguage(grammar);
    tree = parser.parse(content);
  } catch (err) {
    throw new Error(`Parse failed for ${path}: ${(err as Error).message}`);
  }

  const { definition: def } = detectLanguage(path);
  const declarations = def.declarations ?? {};

  // 1. Collect declaration nodes (iterative walk; trees can be deep).
  const declNodes: DeclNode[] = [];
  const ancestorDecl = new Map<Parser.SyntaxNode, DeclNode>();
  const stack: Parser.SyntaxNode[] = [tree.rootNode];
  while (stack.length) {
    const node = stack.pop()!;
    if (declarations[node.type]) {
      const kind = declarations[node.type];
      // Constants (const/var/let) only count as symbols at module scope —
      // every local variable would otherwise flood the symbol index.
      const isConstant = kind === "constant";
      const name = extractName(node);
      const parent = nearestAncestor(node, ancestorDecl);
      // Built once, and used for both the emitted symbol and the ancestor map.
      // The map entry used to store the *unqualified* name, so the level below
      // composed its qualified name from that: a method `b` in class `A`
      // registered as "b", and anything nested inside it became "b.c" instead
      // of "A.b.c". Everything three or more levels deep was misnamed.
      const qualifiedName = parent ? `${parent.qualifiedName}.${name}` : name;
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const decl: DeclNode = {
        node,
        kind,
        name,
        qualifiedName,
        parentName: parent ? parent.qualifiedName : null,
        startLine,
        endLine,
      };
      if (!isConstant || isModuleScope(node, tree.rootNode, declarations)) {
        declNodes.push(decl);
      }
      // Registered even for a non-emitted constant: a local `const` still
      // names the scope any declaration inside it belongs to.
      ancestorDecl.set(node, decl);
    }
    for (const child of node.children) stack.push(child);
  }
  declNodes.sort((a, b) => a.startLine - b.startLine);

  // 2. Calls + imports per declaration, plus a synthesized file module symbol
  //    carrying file-level calls/imports (route registrations, top-level uses).
  const callsByDecl = new Map<Parser.SyntaxNode, string[]>();
  const importsByDecl = new Map<Parser.SyntaxNode, string[]>();
  const callTypes = new Set<string>(def.callNodeTypes ?? []);
  const importTypes = new Set<string>(def.importNodeTypes ?? []);
  for (const d of declNodes) {
    const calls: string[] = [];
    const imports: string[] = [];
    collectRelations(d.node, callTypes, importTypes, calls, imports, path);
    callsByDecl.set(d.node, calls);
    importsByDecl.set(d.node, imports);
  }

  const fileCalls: string[] = [];
  const fileImports: string[] = [];
  collectFileLevelRelations(tree.rootNode, declNodes, callTypes, importTypes, fileCalls, fileImports, path);
  const fileSymbol = createFileSymbol(path, fileCalls, fileImports);

  // Hoisted out of the mapping below for readability, not for speed. That
  // mapping emits one row per declaration, so the number of `extractHeritage`
  // calls is the same as it was inline, and so is the work: the function walks
  // only its own declaration's subtree. Declarations nest, so those subtrees
  // overlap and the total is the sum of the declaration subtree sizes in either
  // form — the file is walked more than once both ways. What the hoist changes
  // is that the mapping below is a lookup rather than a call per row.
  const heritageByDecl = new Map<Parser.SyntaxNode, { extends: string[]; implements: string[] }>();
  for (const d of declNodes) {
    heritageByDecl.set(d.node, extractHeritage(d.node, def.id, declarations));
  }

  // 3. Symbols.
  const symbols: ParsedSymbol[] = [
    ...(fileSymbol ? [fileSymbol] : []),
    ...declNodes.map((d) => ({
      name: d.name,
      qualifiedName: d.qualifiedName,
      kind: d.kind,
      startLine: d.startLine,
      endLine: d.endLine,
      parentName: d.parentName,
      calls: callsByDecl.get(d.node) ?? [],
      imports: importsByDecl.get(d.node) ?? [],
      ...heritageByDecl.get(d.node) ?? { extends: [], implements: [] },
    })),
  ];

  // 4. Chunks: one per declaration + gap blocks for top-level code.
  const lines = content.split("\n");
  const chunks: ParsedChunk[] = [];
  let cursor = 0;
  for (const d of declNodes) {
    if (d.startLine - 1 > cursor) {
      chunks.push(...blockChunks(lines, cursor, d.startLine - 2, null, "module", category));
    }
    chunks.push(...declarationChunks(lines, d, category));
    // Monotonic. `declNodes` contains nested declarations, so a class spanning
    // lines 10-100 is followed by its methods at 20-30, 40-50, ... Assigning
    // `cursor = d.endLine` rewound it from 100 to 30, and every later method
    // then looked like it was preceded by an uncovered gap and emitted a block
    // for lines that were already inside the class chunk. A file of ordinary
    // classes produced 2-4x the chunks it needed, and every duplicate is a
    // duplicate embedding call.
    cursor = Math.max(cursor, d.endLine);
  }
  if (cursor < lines.length) {
    chunks.push(...blockChunks(lines, cursor, lines.length - 1, null, "module", category));
  }
  if (chunks.length === 0 && content.trim()) {
    chunks.push(...fallbackChunks(content, category));
  }
  const nonEmpty = chunks.filter((c) => c.content.trim().length > 0);
  if (nonEmpty.length === 0 && chunks.length > 0) {
    // Keep at least one chunk per file so the file stays retrievable.
    chunks[0].content = content;
    return { language: id, symbols, chunks, error: null };
  }

  return { language: id, symbols, chunks: nonEmpty, error: null };
}

/** Preloads every available grammar (used by the worker before a batch). */
export async function preloadGrammars(): Promise<void> {
  const failures: string[] = [];
  await Promise.all(
    Object.entries(LANGUAGES).map(async ([id, def]) => {
      try {
        const loaded = await def.loadGrammar();
        if (loaded) {
          grammarCache.set(id, loaded as Language);
        } else {
          failures.push(id);
        }
      } catch {
        // Language stays unavailable; files fall back to block chunking.
        failures.push(id);
      }
    }),
  );
  if (failures.length > 0) {
    // Logged rather than swallowed. A grammar that fails to resolve does not
    // throw: those files are chunked as plain text, indexed, and reported as
    // indexed — they simply have no symbols, no relationships and no
    // structural search. That silence is what let the bulk of the declared
    // languages break unnoticed, so it is surfaced at startup.
    //
    // Only languages that actually declare extractable node types are
    // reported. markdown, yaml, toml, sql, dockerfile and makefile have no
    // grammar package installed and no `declarations` map by design — they are
    // chunked as text, which is correct — so listing them as unavailable every
    // start would train an operator to ignore the message that matters.
    const structural = failures.filter((id) => !!LANGUAGES[id]?.declarations);
    if (structural.length > 0) {
      console.warn(
        `[parser] ${structural.length} language grammar(s) unavailable; those files index without symbols: ${structural.sort().join(", ")}`,
      );
    }
  }
}

/**
 * Declared languages whose grammar could not be resolved, for health reporting.
 * Non-empty means those languages are indexed but not structurally searchable.
 */
export function unavailableGrammars(): string[] {
  return Object.keys(LANGUAGES)
    .filter((id) => !!LANGUAGES[id].declarations && !grammarCache.has(id))
    .sort();
}

function nearestAncestor(
  node: Parser.SyntaxNode,
  map: Map<Parser.SyntaxNode, DeclNode>,
): DeclNode | null {
  let parent = node.parent;
  while (parent) {
    const found = map.get(parent);
    if (found) return found;
    parent = parent.parent;
  }
  return null;
}

function extractName(node: Parser.SyntaxNode): string {
  const byField = node.childForFieldName("name");
  if (byField) return cleanName(byField.text);
  // `const x = <expr>` — the declared name sits on the variable declarator,
  // not the declaration (the value expression must not leak into the name).
  if (node.type === "variable_declaration" || node.type === "lexical_declaration") {
    for (const child of node.namedChildren) {
      if (child.type === "variable_declarator") {
        const n = child.childForFieldName("name");
        if (n) return cleanName(n.text);
      }
    }
  }
  // Arrow functions / function expressions: the name lives on the
  // enclosing variable declarator.
  const parent = node.parent;
  if (
    parent &&
    (parent.type === "variable_declarator" || parent.type === "assignment_expression" || parent.type === "expression_statement")
  ) {
    const lhs = parent.childForFieldName("name") ?? parent.childForFieldName("left");
    if (lhs && lhs.type !== node.type) return cleanName(lhs.text);
  }
  // Search a shallow window of named descendants for a name-like node.
  //
  // Breadth-first, and bounded on both level count and node count. The
  // previous version used a single counter for "depth" that incremented once
  // per node popped from a LIFO stack, so `depth < 6` meant "look at six
  // arbitrary nodes in DFS order" rather than "look six levels down". For a
  // declaration whose grammar exposes no `name` field, that reached into the
  // body and returned whatever identifier it happened to hit first — a
  // parameter, a call target — as the symbol's name. The shallowest name-like
  // node is overwhelmingly the declaration's own.
  const MAX_NAME_SEARCH_LEVELS = 3;
  const MAX_NAME_SEARCH_NODES = 200;
  let frontier = node.namedChildren;
  let seen = 0;
  for (let level = 0; level < MAX_NAME_SEARCH_LEVELS && frontier.length > 0; level++) {
    const next: Parser.SyntaxNode[] = [];
    for (const child of frontier) {
      if (++seen > MAX_NAME_SEARCH_NODES) return "<anonymous>";
      if (NAME_NODE_TYPES.has(child.type) && child.text.length < 200) {
        return cleanName(child.text);
      }
      next.push(...child.namedChildren.slice(0, 12));
    }
    frontier = next;
  }
  return "<anonymous>";
}

function cleanName(text: string): string {
  return text.replace(/["'`]/g, "").split(".").pop() ?? "<anonymous>";
}

/**
 * A synthesized module-level symbol for a file when it has top-level
 * calls/imports. Gives file-level relationships (e.g. route registrations,
 * global imports) a home in the structural index.
 */
function createFileSymbol(
  path: string,
  calls: string[],
  imports: string[],
): ParsedSymbol | null {
  if (calls.length === 0 && imports.length === 0) return null;
  const name = path.split("/").pop() ?? path;
  return {
    name,
    qualifiedName: name,
    kind: "module",
    startLine: 1,
    endLine: 1,
    parentName: null,
    calls,
    imports,
    extends: [],
    implements: [],
  };
}

function collectRelations(
  node: Parser.SyntaxNode,
  callTypes: Set<string>,
  importTypes: Set<string>,
  calls: string[],
  imports: string[],
  path: string,
): void {
  const stack: Parser.SyntaxNode[] = [node];
  while (stack.length) {
    const current = stack.pop()!;
    if (callTypes.has(current.type)) {
      const fn = current.childForFieldName("function") ?? current.childForFieldName("method");
      if (fn) {
        calls.push(cleanCallName(fn.text));
      } else {
        calls.push(cleanCallName(current.text.replace(/\(.*/, "")));
      }
    }
    if (importTypes.has(current.type)) {
      const mod = importModuleFrom(current.text, path);
      if (mod) imports.push(mod);
    }
    for (const child of current.children) stack.push(child);
  }
}

function cleanCallName(text: string): string {
  return text.replace(/\(.*$/, "").trim();
}

/**
 * Walks top-level nodes only: subtrees belonging to a declaration are pruned,
 * so file-level (module-scope) calls/imports are collected without double
 * counting what the declarations already recorded.
 */
function collectFileLevelRelations(
  root: Parser.SyntaxNode,
  declNodes: DeclNode[],
  callTypes: Set<string>,
  importTypes: Set<string>,
  calls: string[],
  imports: string[],
  path: string,
): void {
  const declRanges = declNodes.map((d) => [d.node.startIndex, d.node.endIndex] as const);
  const stack: Parser.SyntaxNode[] = [root];
  while (stack.length) {
    const current = stack.pop()!;
    if (declRanges.some(([start, end]) => current.startIndex >= start && current.endIndex <= end)) {
      continue;
    }
    if (callTypes.has(current.type)) {
      const fn = current.childForFieldName("function") ?? current.childForFieldName("method");
      calls.push(fn ? cleanCallName(fn.text) : cleanCallName(current.text.replace(/\(.*/, "")));
    }
    if (importTypes.has(current.type)) {
      const mod = importModuleFrom(current.text, path);
      if (mod) imports.push(mod);
    }
    for (const child of current.children) stack.push(child);
  }
}

const IMPORT_REGEXES: Array<[string, RegExp]> = [
  ["typescript", /(?:import|export)[^'"]*?['"]([^'"]+)['"]/],
  ["javascript", /(?:import|export)[^'"]*?['"]([^'"]+)['"]/],
  ["tsx", /(?:import|export)[^'"]*?['"]([^'"]+)['"]/],
  ["python", /^\s*from\s+(\S+?)\s+import|^\s*import\s+(\S+)/],
  ["go", /"([^"]+)"/],
  ["rust", /^use\s+([\w:]+)/],
  ["java", /^import\s+(?:static\s+)?([\w.]+)/],
  ["c", /^#include\s*[<"]([^>"]+)[>"]/],
  ["cpp", /^#include\s*[<"]([^>"]+)[>"]/],
  ["csharp", /^using\s+([\w.]+)/],
  ["php", /^use\s+([\w\\]+)/],
];

function importModuleFrom(text: string, path: string): string | null {
  const languageId = detectLanguage(path).id;
  const regex = IMPORT_REGEXES.find(([id]) => id === languageId)?.[1] ?? /"([^"]+)"/;
  const match = text.match(regex);
  return match ? match[1] ?? match[0] : null;
}

/**
 * Which side of the heritage relationship each clause node sits on.
 *
 * Every entry is a node type the INSTALLED grammar actually emits. That
 * distinction is load-bearing: the previous set named `class_interface_clause`
 * for Java, which does not exist in tree-sitter-java, so Java class
 * `implements` clauses were never seen and `implements` came back empty for
 * every Java class. TypeScript and Java *interface* inheritance
 * (`extends_type_clause`, `extends_interfaces`) were missing for the same
 * reason, so an interface extending two others recorded no relationship at
 * all. Those cases were silent because the clause was simply not in the set.
 *
 * `mixed` clauses carry an explicit keyword and are split on it; the rest are
 * unambiguous from the grammar and are routed directly.
 */
const HERITAGE_CLAUSE_BY_TYPE: Record<string, "extends" | "implements" | "mixed"> = {
  // TS/JS class header: "extends A implements B, C".
  class_heritage: "mixed",
  // C# base list: "A, B" with no keyword; by convention the first is the base.
  base_list: "mixed",
  // Java class: "extends A" and "implements B, C" are separate nodes.
  superclass: "extends",
  super_interfaces: "implements",
  // Java interface: "extends A, B".
  extends_interfaces: "extends",
  // TypeScript interface: "extends A, B".
  extends_type_clause: "extends",
};

const HERITAGE_CLAUSE_TYPES = new Set(Object.keys(HERITAGE_CLAUSE_BY_TYPE));

/**
 * Splits a superclass/interface clause into `extends` and `implements`.
 *
 * The previous version took the clause's whole text and stripped the keywords
 * with a global replace, so `class Foo extends Bar, Baz` produced the single
 * string "Bar Baz" and `implements` was conflated into `extends`. It also
 * walked every descendant, so a class nested inside another contributed its
 * own superclass to the outer class.
 *
 * Interfaces are recorded separately because "what does this implement" and
 * "what does this extend" answer different questions — the first is a
 * contract, the second is a dependency — and collapsing them made the
 * structural index answer neither precisely.
 */
function extractHeritage(
  node: Parser.SyntaxNode,
  languageId: string,
  declarationTypes: Record<string, SymbolKind> | undefined,
): { extends: string[]; implements: string[] } {
  const extendsList: string[] = [];
  const implementsList: string[] = [];
  // Python expresses inheritance through base-class arguments in the class
  // header, not a heritage clause, so there is nothing to extract here.
  if (languageId === "python") return { extends: [], implements: [] };

  const clauses: Parser.SyntaxNode[] = [];
  const stack: Parser.SyntaxNode[] = [...node.children];
  while (stack.length) {
    const current = stack.pop()!;
    if (HERITAGE_CLAUSE_TYPES.has(current.type)) clauses.push(current);
    for (const child of current.children) stack.push(child);
  }

  for (const clause of clauses) {
    // Clauses are gathered from the whole subtree, so the walk up from each one
    // to this node discards two things: a clause owned by a class nested inside
    // this one, which is that inner class's superclass and not this one's; and
    // a clause nested inside another clause. The TypeScript grammar is the
    // case that needs the second rule: it puts `extends_clause` and
    // `implements_clause` inside `class_heritage`, so a class with a heritage
    // clause offers two nodes carrying the same text, and only the outer
    // `class_heritage` is read.
    let owner = clause.parent;
    let skip = false;
    while (owner && owner.id !== node.id) {
      if (declarationTypes?.[owner.type] || HERITAGE_CLAUSE_TYPES.has(owner.type)) {
        skip = true;
        break;
      }
      owner = owner.parent;
    }
    if (skip) continue;

    const text = clause.text;
    const kind = HERITAGE_CLAUSE_BY_TYPE[clause.type];

    if (kind === "extends" || kind === "implements") {
      // The grammar already told us which side this is: a Java class's
      // "implements B, C", a Java or TS interface's "extends A, B".
      (kind === "extends" ? extendsList : implementsList).push(...splitTypeNames(text));
      continue;
    }

    // `mixed`: either a clause with an explicit keyword (TS/JS class) or C#'s
    // unlabelled ": A, B" base list.
    if (clause.type === "base_list") {
      const parts = splitTypeNames(text);
      if (parts.length > 0) extendsList.push(parts[0]);
      implementsList.push(...parts.slice(1));
      continue;
    }

    const implIndex = text.search(/\bimplements\b/);
    const head = implIndex >= 0 ? text.slice(0, implIndex) : text;
    const tail = implIndex >= 0 ? text.slice(implIndex + "implements".length) : "";
    extendsList.push(...splitTypeNames(head));
    implementsList.push(...splitTypeNames(tail));
  }

  return { extends: dedupe(extendsList), implements: dedupe(implementsList) };
}

/** Splits a heritage clause on commas into bare type names, sans generics. */
function splitTypeNames(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(",")) {
    let name = raw.replace(/\bextends\b/g, " ").replace(/:/g, " ").trim();
    if (!name) continue;
    // Drop generic arguments: `Repository<Order>` -> `Repository`.
    const angle = name.indexOf("<");
    if (angle > 0) name = name.slice(0, angle);
    // Modifiers and access keywords can precede the type (`public Base`).
    name = name.split(/\s+/).pop() ?? "";
    if (/^[A-Za-z_$][\w$.]*$/.test(name)) out.push(name);
  }
  return out;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

/**
 * Splits an inclusive, zero-based line range into blocks of at most
 * {@link MAX_CHUNK_LINES}, preferring a break on a blank line just before the
 * hard limit so a chunk is not cut mid-statement where a natural seam exists.
 *
 * Extracted so the gap-block chunker and the declaration chunker cannot drift
 * apart: they used to be two copies of the same loop, and only the gap-block
 * one was capped.
 */
function splitLineRange(lines: string[], start: number, end: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let blockStart = start;
  while (blockStart <= end) {
    let blockEnd = Math.min(blockStart + MAX_CHUNK_LINES - 1, end);
    if (blockEnd - blockStart >= MAX_CHUNK_LINES - 1) {
      // Prefer breaking on a blank line just before the hard limit.
      for (let i = blockEnd; i > blockStart + 20 && i > blockEnd - 40; i--) {
        if (lines[i]?.trim() === "") {
          blockEnd = i;
          break;
        }
      }
    }
    ranges.push([blockStart, blockEnd]);
    blockStart = blockEnd + 1;
  }
  return ranges;
}

/** Splits a line range into semantic blocks of at most MAX_CHUNK_LINES. */
function blockChunks(
  lines: string[],
  start: number,
  end: number,
  symbolName: string | null,
  kind: string,
  category: "code" | "test" | "documentation" | "configuration",
): ParsedChunk[] {
  const chunkType: ChunkType = category === "test" ? "test" : category === "documentation" ? "documentation" : category === "configuration" ? "configuration" : "code";
  return splitLineRange(lines, start, end).map(([blockStart, blockEnd]) => ({
    symbolName,
    kind,
    startLine: blockStart + 1,
    endLine: blockEnd + 1,
    content: lines.slice(blockStart, blockEnd + 1).join("\n"),
    chunkType,
  }));
}

/**
 * The chunks covering one declaration's source span, capped at
 * {@link MAX_CHUNK_LINES} each.
 *
 * A declaration was previously chunked whole: `lines.slice(startLine - 1,
 * endLine)`, with no bound. One generated file, minified bundle, data fixture
 * or auto-generated enum then became a single chunk that was embedded whole,
 * stored in Qdrant's payload verbatim and served by `get_file` — past the
 * embedding model's context, past what any retriever can usefully rank, and
 * past what any agent asked for one symbol wants to read. The gap blocks around
 * declarations were capped the whole time, which is what made the uncapped case
 * easy to miss: a 5,000-line file of ordinary functions was capped, and one
 * 5,000-line function was not.
 *
 * Every part carries the declaration's own qualified name, not a suffixed
 * variant. The name is the join key: the pipeline looks the chunk's `symbolName`
 * up in its symbol table to fill `Chunk.symbolId`, and the search layer filters
 * and labels results by it, so a suffixed part would resolve to no symbol and
 * would be filtered out of every structural query. The parts are contiguous
 * (the split only ever cuts between them) and each keeps its own true
 * start/end lines, so `get_file` still reconstructs the declaration exactly.
 */
function declarationChunks(
  lines: string[],
  decl: { startLine: number; endLine: number; qualifiedName: string; kind: string },
  category: "code" | "test" | "documentation" | "configuration",
): ParsedChunk[] {
  const chunkType: ChunkType = category === "test" ? "test" : "code";
  // Clamped: a node that somehow reported an end past the last line would
  // otherwise index off the end of the array and read back as `undefined`
  // lines, or emit a chunk whose line numbers do not match its content.
  const start = Math.max(0, decl.startLine - 1);
  const end = Math.min(lines.length - 1, decl.endLine - 1);
  if (end < start) return [];
  return splitLineRange(lines, start, end).map(([blockStart, blockEnd]) => ({
    symbolName: decl.qualifiedName,
    kind: decl.kind,
    startLine: blockStart + 1,
    endLine: blockEnd + 1,
    content: lines.slice(blockStart, blockEnd + 1).join("\n"),
    chunkType,
  }));
}

/** Block-based fallback used when no AST support exists. */
export function fallbackChunks(content: string, category: "code" | "test" | "documentation" | "configuration"): ParsedChunk[] {
  const lines = content.split("\n");
  if (!content.trim()) return [];
  return blockChunks(lines, 0, lines.length - 1, null, "module", category);
}

/** Documentation sections for markdown, split on headings. */
export function parseMarkdown(path: string, content: string): ParsedFile {
  const symbols: ParsedSymbol[] = [];
  const chunks: ParsedChunk[] = [];
  const lines = content.split("\n");
  let currentHeading: { name: string; line: number } | null = null;
  let sectionStart = 0;

  const flush = (endLine: number) => {
    const body = lines.slice(sectionStart, endLine + 1).join("\n").trim();
    if (!body) return;
    // Capped, like every other chunk producer. A markdown file with one
    // 5,000-line section — an API dump, a generated table, a pasted log —
    // otherwise became a single chunk that was embedded whole, stored in the
    // Qdrant payload verbatim, and served in full by get_file.
    //
    // The section SYMBOL keeps the whole section's span; only the chunk
    // content is split, so the parts together still reassemble the section and
    // a caller reading a range gets the same bytes back.
    const sectionEnd = Math.min(endLine, Math.max(sectionStart, lines.length - 1));
    for (const [partStart, partEnd] of splitLineRange(lines, sectionStart, sectionEnd)) {
      chunks.push({
        symbolName: currentHeading ? `docs:${currentHeading.name}` : null,
        kind: currentHeading ? "section" : "module",
        startLine: partStart + 1,
        endLine: partEnd + 1,
        content: lines.slice(partStart, partEnd + 1).join("\n"),
        chunkType: "documentation",
      });
    }
    if (currentHeading) {
      symbols.push({
        name: currentHeading.name,
        qualifiedName: currentHeading.name,
        kind: "section",
        startLine: currentHeading.line + 1,
        endLine: endLine + 1,
        parentName: null,
        calls: [],
        imports: [],
        extends: [],
        implements: [],
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      flush(i - 1);
      currentHeading = { name: match[2].trim(), line: i };
      sectionStart = i;
    }
  }
  flush(lines.length - 1);
  return { language: "markdown", symbols, chunks, error: null };
}