import type { Node as SyntaxNode } from "web-tree-sitter";

/**
 * Language table for the code index.
 *
 * Every grammar ships as a `.wasm` file in `packages/cli/grammars/`. The
 * queries and node-type maps here are the only language-specific knowledge in
 * the module; `parser.ts` walks whatever they produce, so a language is added
 * by dropping a grammar and a spec next to the others.
 */
export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "struct"
  | "enum"
  | "interface"
  | "type"
  | "variable";

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  endLine: number;
  signature: string;
  doc: string;
  parent: string | null;
  exported: boolean;
}

export interface ParsedReference {
  name: string;
  line: number;
  /** "call" when the identifier is being applied, "reference" otherwise. */
  kind: "call" | "reference";
}

export interface ParseResult {
  language: string;
  symbols: ParsedSymbol[];
  references: ParsedReference[];
}

export interface LanguageSpec {
  /** Canonical language name stored in the index. */
  name: string;
  /** Grammar file under `packages/cli/grammars/`. */
  wasm: string;
  /** Extensions mapped to this language, lower case without the dot. */
  extensions: readonly string[];
  /**
   * Tree-sitter query whose `@name` capture is the symbol's identifier and
   * whose `@definition` capture is the declaration node.
   */
  symbolsQuery: string;
  /** Kind for the `@definition` node's type; the node is passed for cases
   *  where the kind depends on content (Go's shared `type_spec`). */
  kindOf: (def: SyntaxNode) => SymbolKind | undefined;
  /** Optional post-classification (Swift methods, Python methods, arrow
   *  functions assigned to a variable). */
  refine?: (kind: SymbolKind, def: SyntaxNode) => SymbolKind;
  /** Node types treated as identifier references. */
  identifierTypes: readonly string[];
  /** Name of the enclosing declaration, for methods and nested types. */
  containerName?: (node: SyntaxNode) => string | undefined;
  /** True when the language uses a leading string literal as a docstring. */
  docstring?: boolean;
  /** Whether the declaration is exported; defaults to the name convention. */
  exported?: (name: string, def: SyntaxNode) => boolean;
}

function textOf(node: SyntaxNode | null | undefined): string {
  return node ? node.text : "";
}

function childText(node: SyntaxNode, field: string): string {
  return textOf(node.childForFieldName(field));
}

/** Walk ancestors and return the first container's name. */
function makeContainerName(
  containerTypes: ReadonlySet<string>,
  nameOf: (node: SyntaxNode) => string | undefined,
): (node: SyntaxNode) => string | undefined {
  return (node: SyntaxNode) => {
    let current = node.parent;
    while (current) {
      if (containerTypes.has(current.type)) {
        const name = nameOf(current);
        if (name) return name;
      }
      current = current.parent;
    }
    return undefined;
  };
}

function ancestorsInclude(node: SyntaxNode, types: ReadonlySet<string>): boolean {
  let current = node.parent;
  while (current) {
    if (types.has(current.type)) return true;
    current = current.parent;
  }
  return false;
}

const TS_CONTAINERS = new Set(["class_declaration", "abstract_class_declaration", "interface_declaration", "class"]);
const SWIFT_CONTAINERS = new Set(["class_declaration", "protocol_declaration", "extension_declaration"]);
const PY_CONTAINERS = new Set(["class_definition"]);
const RUST_CONTAINERS = new Set(["impl_item", "trait_item", "struct_item", "enum_item", "mod_item", "union_item"]);
const RUBY_CONTAINERS = new Set(["class", "module"]);

// ── TypeScript / JavaScript ──────────────────────────────────────────────────

const TS_SYMBOL_QUERY = `
(function_declaration name: (_) @name) @definition
(generator_function_declaration name: (_) @name) @definition
(method_definition name: (_) @name) @definition
(abstract_method_signature name: (_) @name) @definition
(method_signature name: (_) @name) @definition
(class_declaration name: (_) @name) @definition
(abstract_class_declaration name: (_) @name) @definition
(interface_declaration name: (_) @name) @definition
(enum_declaration name: (_) @name) @definition
(type_alias_declaration name: (_) @name) @definition
(lexical_declaration (variable_declarator name: (_) @name) @definition)
(variable_declaration (variable_declarator name: (_) @name) @definition)
`;

const JS_SYMBOL_QUERY = `
(function_declaration name: (_) @name) @definition
(generator_function_declaration name: (_) @name) @definition
(method_definition name: (_) @name) @definition
(class_declaration name: (_) @name) @definition
(lexical_declaration (variable_declarator name: (_) @name) @definition)
(variable_declaration (variable_declarator name: (_) @name) @definition)
`;

function jsKind(def: SyntaxNode): SymbolKind | undefined {
  switch (def.type) {
    case "function_declaration":
    case "generator_function_declaration":
      return "function";
    case "method_definition":
    case "abstract_method_signature":
    case "method_signature":
      return "method";
    case "class_declaration":
    case "abstract_class_declaration":
      return "class";
    case "interface_declaration":
      return "interface";
    case "enum_declaration":
      return "enum";
    case "type_alias_declaration":
      return "type";
    case "variable_declarator":
      return "variable";
    default:
      return undefined;
  }
}

function jsRefine(kind: SymbolKind, def: SyntaxNode, containerTypes: ReadonlySet<string>): SymbolKind {
  if (kind === "variable") {
    const value = def.childForFieldName("value");
    if (value && (value.type === "arrow_function" || value.type === "function_expression")) return "function";
  }
  if (kind === "method" && !ancestorsInclude(def, containerTypes) && !ancestorsInclude(def, new Set(["interface_body", "object"]))) {
    // A method_definition's parent is a class body; anything else (object
    // literal) is still a method by grammar. Keep it.
    return kind;
  }
  return kind;
}

function jsExported(_name: string, def: SyntaxNode): boolean {
  return ancestorsInclude(def, new Set(["export_statement"]));
}

const TS_CONTAINER_NAME = makeContainerName(TS_CONTAINERS, node => childText(node, "name"));

// ── Swift ────────────────────────────────────────────────────────────────────

const SWIFT_SYMBOL_QUERY = `
(function_declaration name: (simple_identifier) @name) @definition
(protocol_function_declaration name: (simple_identifier) @name) @definition
(class_declaration name: (type_identifier) @name) @definition
(protocol_declaration name: (type_identifier) @name) @definition
(typealias_declaration name: (type_identifier) @name) @definition
(property_declaration name: (pattern bound_identifier: (simple_identifier) @name)) @definition
`;

function swiftKind(def: SyntaxNode): SymbolKind | undefined {
  switch (def.type) {
    case "function_declaration":
      return "function";
    case "protocol_function_declaration":
      return "method";
    case "class_declaration": {
      const head = def.text.trimStart().slice(0, 12);
      if (head.startsWith("struct")) return "struct";
      if (head.startsWith("enum")) return "enum";
      if (head.startsWith("extension")) return undefined;
      return "class";
    }
    case "protocol_declaration":
      return "interface";
    case "typealias_declaration":
      return "type";
    case "property_declaration":
      return "variable";
    default:
      return undefined;
  }
}

function swiftRefine(kind: SymbolKind, def: SyntaxNode): SymbolKind {
  if (kind === "function" && ancestorsInclude(def, new Set(["class_body", "enum_class_body", "protocol_body"]))) return "method";
  return kind;
}

function swiftExported(_name: string, def: SyntaxNode): boolean {
  const head = def.text.trimStart();
  return head.startsWith("public") || head.startsWith("open");
}

const SWIFT_CONTAINER_NAME = makeContainerName(SWIFT_CONTAINERS, node => childText(node, "name"));

// ── Python ───────────────────────────────────────────────────────────────────

const PY_SYMBOL_QUERY = `
(function_definition name: (identifier) @name) @definition
(class_definition name: (identifier) @name) @definition
(expression_statement (assignment left: (identifier) @name) @definition)
`;

function pyKind(def: SyntaxNode): SymbolKind | undefined {
  switch (def.type) {
    case "function_definition":
      return "function";
    case "class_definition":
      return "class";
    case "assignment":
      return "variable";
    default:
      return undefined;
  }
}

function pyRefine(kind: SymbolKind, def: SyntaxNode): SymbolKind {
  if (kind === "function" && ancestorsInclude(def, PY_CONTAINERS)) return "method";
  return kind;
}

function pyExported(name: string): boolean {
  return !name.startsWith("_");
}

const PY_CONTAINER_NAME = makeContainerName(PY_CONTAINERS, node => childText(node, "name"));

// ── Rust ─────────────────────────────────────────────────────────────────────

const RUST_SYMBOL_QUERY = `
(function_item name: (identifier) @name) @definition
(function_signature_item name: (identifier) @name) @definition
(struct_item name: (type_identifier) @name) @definition
(enum_item name: (type_identifier) @name) @definition
(union_item name: (type_identifier) @name) @definition
(trait_item name: (type_identifier) @name) @definition
(type_item name: (type_identifier) @name) @definition
(const_item name: (identifier) @name) @definition
(static_item name: (identifier) @name) @definition
`;

function rustKind(def: SyntaxNode): SymbolKind | undefined {
  switch (def.type) {
    case "function_item":
      return "function";
    case "function_signature_item":
      return "method";
    case "struct_item":
    case "union_item":
      return "struct";
    case "enum_item":
      return "enum";
    case "trait_item":
      return "interface";
    case "type_item":
      return "type";
    case "const_item":
    case "static_item":
      return "variable";
    default:
      return undefined;
  }
}

function rustRefine(kind: SymbolKind, def: SyntaxNode): SymbolKind {
  if (kind === "function" && ancestorsInclude(def, new Set(["impl_item", "trait_item"]))) return "method";
  return kind;
}

function rustExported(_name: string, def: SyntaxNode): boolean {
  return def.namedChildren.some(child => child.type === "visibility_modifier");
}

function rustContainerName(node: SyntaxNode): string | undefined {
  if (node.type !== "impl_item") return childText(node, "name");
  const type = node.childForFieldName("type");
  return type ? type.text : undefined;
}

const RUST_CONTAINER = makeContainerName(RUST_CONTAINERS, rustContainerName);

// ── Go ───────────────────────────────────────────────────────────────────────

const GO_SYMBOL_QUERY = `
(function_declaration name: (identifier) @name) @definition
(method_declaration name: (field_identifier) @name) @definition
(type_spec name: (type_identifier) @name) @definition
(var_spec name: (identifier) @name) @definition
(const_spec name: (identifier) @name) @definition
`;

function goKind(def: SyntaxNode): SymbolKind | undefined {
  switch (def.type) {
    case "function_declaration":
      return "function";
    case "method_declaration":
      return "method";
    case "type_spec": {
      const alias = def.childForFieldName("type");
      if (alias?.type === "struct_type") return "struct";
      if (alias?.type === "interface_type") return "interface";
      return "type";
    }
    case "var_spec":
    case "const_spec":
      return "variable";
    default:
      return undefined;
  }
}

function goExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function goContainerName(node: SyntaxNode): string | undefined {
  if (node.type !== "method_declaration") return undefined;
  const receiver = node.childForFieldName("receiver");
  if (!receiver) return undefined;
  const type = receiver.descendantsOfType("type_identifier")[0];
  return type ? type.text : undefined;
}

// ── Ruby ─────────────────────────────────────────────────────────────────────

const RUBY_SYMBOL_QUERY = `
(method name: (identifier) @name) @definition
(singleton_method name: (identifier) @name) @definition
(class name: (constant) @name) @definition
(module name: (constant) @name) @definition
(assignment left: (identifier) @name) @definition
`;

function rubyKind(def: SyntaxNode): SymbolKind | undefined {
  switch (def.type) {
    case "method":
      return "function";
    case "singleton_method":
      return "method";
    case "class":
    case "module":
      return "class";
    case "assignment":
      return "variable";
    default:
      return undefined;
  }
}

function rubyRefine(kind: SymbolKind, def: SyntaxNode): SymbolKind {
  if (kind === "function" && ancestorsInclude(def, RUBY_CONTAINERS)) return "method";
  return kind;
}

function rubyExported(name: string): boolean {
  return !name.startsWith("_");
}

const RUBY_CONTAINER_NAME = makeContainerName(RUBY_CONTAINERS, node => childText(node, "name"));

// ── Bash ─────────────────────────────────────────────────────────────────────

const BASH_SYMBOL_QUERY = `
(function_definition name: (word) @name) @definition
(variable_assignment name: (variable_name) @name) @definition
`;

function bashKind(def: SyntaxNode): SymbolKind | undefined {
  switch (def.type) {
    case "function_definition":
      return "function";
    case "variable_assignment":
      return "variable";
    default:
      return undefined;
  }
}

function bashExported(name: string): boolean {
  return !name.startsWith("_");
}

// ── Registry ─────────────────────────────────────────────────────────────────

const JS_IDENTIFIERS = ["identifier", "type_identifier", "property_identifier", "shorthand_property_identifier"] as const;

export const LANGUAGES: readonly LanguageSpec[] = [
  {
    name: "typescript",
    wasm: "tree-sitter-typescript.wasm",
    extensions: ["ts", "mts", "cts"],
    symbolsQuery: TS_SYMBOL_QUERY,
    kindOf: jsKind,
    refine: (kind, def) => jsRefine(kind, def, TS_CONTAINERS),
    identifierTypes: JS_IDENTIFIERS,
    containerName: TS_CONTAINER_NAME,
    exported: jsExported,
  },
  {
    name: "tsx",
    wasm: "tree-sitter-tsx.wasm",
    extensions: ["tsx"],
    symbolsQuery: TS_SYMBOL_QUERY,
    kindOf: jsKind,
    refine: (kind, def) => jsRefine(kind, def, TS_CONTAINERS),
    identifierTypes: JS_IDENTIFIERS,
    containerName: TS_CONTAINER_NAME,
    exported: jsExported,
  },
  {
    name: "javascript",
    wasm: "tree-sitter-javascript.wasm",
    extensions: ["js", "mjs", "cjs", "jsx"],
    symbolsQuery: JS_SYMBOL_QUERY,
    kindOf: jsKind,
    refine: (kind, def) => jsRefine(kind, def, new Set(["class_declaration", "class"])),
    identifierTypes: JS_IDENTIFIERS,
    containerName: makeContainerName(new Set(["class_declaration", "class"]), node => childText(node, "name")),
    exported: jsExported,
  },
  {
    name: "swift",
    wasm: "tree-sitter-swift.wasm",
    extensions: ["swift"],
    symbolsQuery: SWIFT_SYMBOL_QUERY,
    kindOf: swiftKind,
    refine: swiftRefine,
    identifierTypes: ["simple_identifier", "type_identifier"],
    containerName: SWIFT_CONTAINER_NAME,
    exported: swiftExported,
  },
  {
    name: "python",
    wasm: "tree-sitter-python.wasm",
    extensions: ["py", "pyi"],
    symbolsQuery: PY_SYMBOL_QUERY,
    kindOf: pyKind,
    refine: pyRefine,
    identifierTypes: ["identifier"],
    containerName: PY_CONTAINER_NAME,
    docstring: true,
    exported: pyExported,
  },
  {
    name: "rust",
    wasm: "tree-sitter-rust.wasm",
    extensions: ["rs"],
    symbolsQuery: RUST_SYMBOL_QUERY,
    kindOf: rustKind,
    refine: rustRefine,
    identifierTypes: ["identifier", "type_identifier", "field_identifier"],
    containerName: RUST_CONTAINER,
    exported: rustExported,
  },
  {
    name: "go",
    wasm: "tree-sitter-go.wasm",
    extensions: ["go"],
    symbolsQuery: GO_SYMBOL_QUERY,
    kindOf: goKind,
    identifierTypes: ["identifier", "type_identifier", "field_identifier"],
    containerName: goContainerName,
    exported: goExported,
  },
  {
    name: "ruby",
    wasm: "tree-sitter-ruby.wasm",
    extensions: ["rb", "rake", "gemspec"],
    symbolsQuery: RUBY_SYMBOL_QUERY,
    kindOf: rubyKind,
    refine: rubyRefine,
    identifierTypes: ["identifier", "constant"],
    containerName: RUBY_CONTAINER_NAME,
    exported: rubyExported,
  },
  {
    name: "bash",
    wasm: "tree-sitter-bash.wasm",
    extensions: ["sh", "bash", "zsh"],
    symbolsQuery: BASH_SYMBOL_QUERY,
    kindOf: bashKind,
    identifierTypes: ["word", "variable_name"],
    exported: bashExported,
  },
];

const BY_EXTENSION = new Map<string, LanguageSpec>();
for (const spec of LANGUAGES) {
  for (const extension of spec.extensions) BY_EXTENSION.set(extension, spec);
}

/** Language for a file path, or undefined for the line-based fallback. */
export function languageForFile(filePath: string): LanguageSpec | undefined {
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return BY_EXTENSION.get(base.slice(dot + 1).toLowerCase());
}

export function languageNames(): string[] {
  return LANGUAGES.map(spec => spec.name);
}
