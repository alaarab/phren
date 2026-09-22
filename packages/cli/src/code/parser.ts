import * as path from "node:path";
import { Language, Parser, Query, type Node as SyntaxNode } from "web-tree-sitter";
import { ROOT } from "../package-metadata.js";
import { logger } from "../logger.js";
import { errorMessage } from "../utils.js";
import {
  languageForFile,
  type LanguageSpec,
  type ParseResult,
  type ParsedReference,
  type ParsedSymbol,
  type SymbolKind,
} from "./languages.js";

/**
 * Tree-sitter front end for the code index.
 *
 * `web-tree-sitter` is initialised once per process and every grammar is
 * loaded from `packages/cli/grammars/` on first use. Files whose language has
 * no grammar (or whose grammar fails to load) go through a line-based
 * fallback so every indexed file still has an outline.
 */

let initPromise: Promise<void> | undefined;

function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

const languageCache = new Map<string, Promise<Language>>();
const queryCache = new Map<string, Query | null>();

export function grammarPath(spec: LanguageSpec): string {
  return path.join(ROOT, "grammars", spec.wasm);
}

async function loadLanguage(spec: LanguageSpec): Promise<Language> {
  let pending = languageCache.get(spec.name);
  if (!pending) {
    pending = Language.load(grammarPath(spec));
    languageCache.set(spec.name, pending);
  }
  return pending;
}

function compileQuery(spec: LanguageSpec, language: Language): Query | null {
  if (queryCache.has(spec.name)) return queryCache.get(spec.name) ?? null;
  let query: Query | null = null;
  try {
    query = new Query(language, spec.symbolsQuery);
  } catch (err: unknown) {
    logger.debug("code", `symbol query failed for ${spec.name}: ${errorMessage(err)}`);
    query = null;
  }
  queryCache.set(spec.name, query);
  return query;
}

// ── Doc comments ─────────────────────────────────────────────────────────────

const WRAPPER_TYPES = new Set(["export_statement", "decorated_definition", "attribute_item", "annotation"]);

function cleanComment(raw: string): string {
  return raw
    .split("\n")
    .map(line =>
      line
        .replace(/^\s*\/\*\*?/, "")
        .replace(/\*\/\s*$/, "")
        .replace(/^\s*\/\/[!/]?/, "")
        .replace(/^\s*\*/, "")
        .replace(/^\s*#!?/, ""))
    .join("\n")
    .trim();
}

function leadingDoc(def: SyntaxNode, source: string): string {
  let node = def;
  while (node.parent && WRAPPER_TYPES.has(node.parent.type)) node = node.parent;

  const parts: string[] = [];
  let current: SyntaxNode | null = node;
  while (current) {
    const previous: SyntaxNode | null = current.previousNamedSibling;
    if (!previous || !previous.type.includes("comment")) break;
    const gap = source.slice(previous.endIndex, current.startIndex);
    if (/\n\s*\n/.test(gap)) break;
    parts.unshift(previous.text);
    current = previous;
  }
  return cleanComment(parts.join("\n")).slice(0, 2000);
}

function docstringDoc(def: SyntaxNode): string {
  const body = def.childForFieldName("body");
  if (!body) return "";
  const first = body.namedChild(0);
  if (!first || first.type !== "expression_statement") return "";
  const string = first.namedChild(0);
  if (!string || string.type !== "string") return "";
  const content = string.namedChildren.find(child => child.type === "string_content");
  return (content ?? string).text.replace(/^["']|["']$/g, "").trim();
}

function symbolDoc(def: SyntaxNode, source: string, spec: LanguageSpec): string {
  if (spec.docstring && (def.type === "function_definition" || def.type === "class_definition")) {
    const doc = docstringDoc(def);
    if (doc) return doc;
  }
  return leadingDoc(def, source);
}

// ── Signatures ───────────────────────────────────────────────────────────────

function firstLine(raw: string): string {
  const index = raw.indexOf("\n");
  return index === -1 ? raw : raw.slice(0, index);
}

function signatureOf(def: SyntaxNode, source: string): string {
  const body = def.childForFieldName("body") ?? def.childForFieldName("block");
  let raw = body ? source.slice(def.startIndex, body.startIndex) : firstLine(source.slice(def.startIndex, def.endIndex));
  if (!body) raw = firstLine(raw);
  const brace = raw.indexOf("{");
  if (brace >= 0) raw = raw.slice(0, brace);
  return raw.replace(/\s+/g, " ").trim().slice(0, 300);
}

// ── Parse ────────────────────────────────────────────────────────────────────

function isCall(node: SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  return /call|command|invocation|send/.test(parent.type);
}

function collectReferences(root: SyntaxNode, spec: LanguageSpec, nameIndexes: Set<number>): ParsedReference[] {
  const references: ParsedReference[] = [];
  for (const node of root.descendantsOfType([...spec.identifierTypes])) {
    if (nameIndexes.has(node.startIndex)) continue;
    const name = node.text;
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    references.push({ name, line: node.startPosition.row + 1, kind: isCall(node) ? "call" : "reference" });
  }
  return references;
}

function buildSymbol(spec: LanguageSpec, def: SyntaxNode, name: SyntaxNode, source: string): ParsedSymbol | undefined {
  const rawName = name.text.trim();
  if (!rawName) return undefined;
  let kind: SymbolKind | undefined = spec.kindOf(def);
  if (!kind) return undefined;
  if (spec.refine) kind = spec.refine(kind, def);
  const parent = spec.containerName?.(def) ?? null;
  const exported = spec.exported ? spec.exported(rawName, def) : true;
  return {
    name: rawName,
    kind,
    line: def.startPosition.row + 1,
    endLine: Math.max(def.startPosition.row + 1, def.endPosition.row + 1),
    signature: signatureOf(def, source),
    doc: symbolDoc(def, source, spec),
    parent: parent && parent !== rawName ? parent : null,
    exported,
  };
}

async function parseWithGrammar(spec: LanguageSpec, source: string): Promise<ParseResult | undefined> {
  try {
    await ensureInit();
    const language = await loadLanguage(spec);
    const query = compileQuery(spec, language);
    if (!query) return undefined;
    const parser = new Parser();
    try {
    parser.setLanguage(language);
    const tree = parser.parse(source);
    if (!tree) return undefined;

    try {
    const symbols: ParsedSymbol[] = [];
    const nameIndexes = new Set<number>();
    for (const match of query.matches(tree.rootNode)) {
      let def: SyntaxNode | undefined;
      let name: SyntaxNode | undefined;
      for (const capture of match.captures) {
        if (capture.name === "definition") def = capture.node;
        else if (capture.name === "name") name = capture.node;
      }
      if (!def || !name) continue;
      nameIndexes.add(name.startIndex);
      const symbol = buildSymbol(spec, def, name, source);
      if (symbol) symbols.push(symbol);
    }

    const references = collectReferences(tree.rootNode, spec, nameIndexes);
    return { language: spec.name, symbols, references };
    } finally { tree.delete(); }
    } finally { parser.delete(); }
  } catch (err: unknown) {
    logger.debug("code", `parse failed for ${spec.name}: ${errorMessage(err)}`);
    return undefined;
  }
}

// ── Line-based fallback ──────────────────────────────────────────────────────

const FALLBACK_PATTERNS: ReadonlyArray<readonly [RegExp, SymbolKind]> = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, "function"],
  [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
  [/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, "interface"],
  [/^\s*(?:export\s+)?(?:type|trait)\s+([A-Za-z_$][\w$]*)/, "type"],
  [/^\s*(?:export\s+)?struct\s+([A-Za-z_$][\w$]*)/, "struct"],
  [/^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, "enum"],
  [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_$][\w$]*)/, "function"],
  [/^\s*def\s+([A-Za-z_$][\w$]*)/, "function"],
  [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/, "function"],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, "variable"],
];

export function fallbackParse(source: string): ParseResult {
  const symbols: ParsedSymbol[] = [];
  const references: ParsedReference[] = [];
  const lines = source.split("\n");
  let pendingDoc: string[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) {
      pendingDoc.push(trimmed.replace(/^(#|\/\/)\s?/, ""));
      return;
    }
    if (!trimmed) {
      pendingDoc = [];
      return;
    }
    for (const [pattern, kind] of FALLBACK_PATTERNS) {
      const match = line.match(pattern);
      if (!match) continue;
      symbols.push({
        name: match[1],
        kind,
        line: index + 1,
        endLine: index + 1,
        signature: trimmed.replace(/\s+/g, " ").slice(0, 300),
        doc: pendingDoc.join("\n").trim(),
        parent: null,
        exported: !match[1].startsWith("_"),
      });
      break;
    }
    pendingDoc = [];
    for (const reference of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      references.push({ name: reference[1], line: index + 1, kind: "call" });
    }
  });

  return { language: "unknown", symbols, references };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** Parse a file's source into symbols and references. */
export async function parseFile(filePath: string, source: string): Promise<ParseResult> {
  const spec = languageForFile(filePath);
  if (spec) {
    const result = await parseWithGrammar(spec, source);
    if (result) return result;
  }
  return fallbackParse(source);
}

/** Parse source for an explicit language name (test and tool helper). */
export async function parseLanguage(language: string, source: string): Promise<ParseResult> {
  const spec = LANG_SPECS.get(language);
  if (spec) {
    const result = await parseWithGrammar(spec, source);
    if (result) return result;
  }
  return fallbackParse(source);
}

import { LANGUAGES } from "./languages.js";
const LANG_SPECS = new Map(LANGUAGES.map(spec => [spec.name, spec]));
