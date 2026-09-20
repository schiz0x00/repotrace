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
    // Never let one malformed file destroy the index job.
    return {
      language: id,
      symbols: [],
      chunks: fallbackChunks(content, category),
      error: (err as Error).message,
    };
  }

  const { definition: def } = detectLanguage(path);
  const declarations = def.declarations ?? {};

  // 1. Collect declaration nodes (iterative walk; trees can be deep).
  const declNodes: DeclNode[] = [];
  const ancestorDecl = new Map<Parser.SyntaxNode, DeclNode>();
  const TOP_LEVEL_TYPES = new Set(["program", "module", "translation_unit", "source_file", "body"]);
  const stack: Parser.SyntaxNode[] = [tree.rootNode];
  while (stack.length) {
    const node = stack.pop()!;
    if (declarations[node.type]) {
      const kind = declarations[node.type];
      // Constants (const/var/let) only count as symbols at module scope —
      // every local variable would otherwise flood the symbol index.
      const isConstant = kind === "constant";
      if (!isConstant || (node.parent && TOP_LEVEL_TYPES.has(node.parent.type))) {
        const name = extractName(node);
        const parent = nearestAncestor(node, ancestorDecl);
        declNodes.push({
          node,
          kind,
          name,
          qualifiedName: parent ? `${parent.qualifiedName}.${name}` : name,
          parentName: parent ? parent.qualifiedName : null,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
      }
      ancestorDecl.set(node, {
        node,
        kind,
        name: extractName(node),
        qualifiedName: extractName(node),
        parentName: null,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      });
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
      extends: extractHeritage(d.node, def.id),
      implements: [],
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
    chunks.push({
      symbolName: d.qualifiedName,
      kind: d.kind,
      startLine: d.startLine,
      endLine: d.endLine,
      content: lines.slice(d.startLine - 1, d.endLine).join("\n"),
      chunkType: category === "test" ? "test" : "code",
    });
    cursor = d.endLine;
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
  await Promise.all(
    Object.entries(LANGUAGES).map(async ([id, def]) => {
      try {
        const loaded = await def.loadGrammar();
        if (loaded) grammarCache.set(id, loaded as Language);
      } catch {
        // Language stays unavailable; files fall back to block chunking.
      }
    }),
  );
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
  const stack: Parser.SyntaxNode[] = [...node.namedChildren];
  let depth = 0;
  while (stack.length && depth < 6) {
    const current = stack.pop()!;
    if (NAME_NODE_TYPES.has(current.type) && current.text.length < 200) {
      return cleanName(current.text);
    }
    depth += 1;
    for (const c of current.namedChildren.slice(0, 12)) stack.push(c);
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
      const module = importModuleFrom(current.text, path);
      if (module) imports.push(module);
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
      const module = importModuleFrom(current.text, path);
      if (module) imports.push(module);
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

function extractHeritage(node: Parser.SyntaxNode, languageId: string): string[] {
  if (languageId === "python") return [];
  const heritage: string[] = [];
  const stack: Parser.SyntaxNode[] = [...node.children];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.type === "class_heritage" || current.type === "superclass" || current.type === "base_class_clause" || current.type === "extends_clause" || current.type === "class_interface_clause") {
      heritage.push(current.text.replace(/extends|implements|:|,/g, "").trim());
    }
    for (const child of current.children) stack.push(child);
  }
  return heritage;
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
  const chunks: ParsedChunk[] = [];
  const chunkType: ChunkType = category === "test" ? "test" : category === "documentation" ? "documentation" : category === "configuration" ? "configuration" : "code";
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
    chunks.push({
      symbolName,
      kind,
      startLine: blockStart + 1,
      endLine: blockEnd + 1,
      content: lines.slice(blockStart, blockEnd + 1).join("\n"),
      chunkType,
    });
    blockStart = blockEnd + 1;
  }
  return chunks;
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
    chunks.push({
      symbolName: currentHeading ? `docs:${currentHeading.name}` : null,
      kind: currentHeading ? "section" : "module",
      startLine: sectionStart + 1,
      endLine: endLine + 1,
      content: body,
      chunkType: "documentation",
    });
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