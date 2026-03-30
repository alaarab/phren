/**
 * Regex-based syntax highlighter for terminal code blocks.
 * Zero external dependencies — uses raw ANSI escape codes.
 * Line-by-line, single-pass processing.
 */

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const MAGENTA = `${ESC}35m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const GRAY = `${ESC}90m`;

// ── Language detection ──────────────────────────────────────────────

const EXT_MAP: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyw: "python",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  json: "json", jsonc: "json", json5: "json",
  css: "css", scss: "scss", sass: "scss", less: "css",
  // pass-through aliases
  typescript: "typescript", javascript: "javascript",
  python: "python", shell: "bash",
};

export function detectLanguage(filename: string): string {
  const lower = filename.toLowerCase().replace(/^\./, "");
  return EXT_MAP[lower] ?? "generic";
}

// ── Color palette ───────────────────────────────────────────────────

export type SyntaxColors = {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  type: string;
  variable: string;
  operator: string;
  reset: string;
};

// ── Highlighters ────────────────────────────────────────────────────

type Highlighter = (line: string, colors?: SyntaxColors) => string;

// Helper: replace matches while preserving non-matched segments
function colorize(line: string, rules: [RegExp, string][], resetSeq = RESET): string {
  // We process rules sequentially; each rule operates on uncolored segments only.
  // Segments already colored are wrapped in \x1b and end with RESET.
  let result = line;
  for (const [re, color] of rules) {
    result = result.replace(re, (match) => `${color}${match}${resetSeq}`);
  }
  return result;
}

// ── TypeScript / JavaScript ─────────────────────────────────────────

const TS_KEYWORDS =
  /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|typeof|instanceof|void|delete|throw|try|catch|finally|import|export|from|default|class|extends|implements|async|await|yield|type|interface|enum|namespace|declare|readonly|abstract|static|get|set|of|in|as|is)\b/g;

const tsHighlight: Highlighter = (line, colors) => {
  const commentColor = colors?.comment ?? GRAY;
  const rst = colors?.reset ?? RESET;
  // Single-line comment
  const commentIdx = line.indexOf("//");
  if (commentIdx !== -1 && !isInsideString(line, commentIdx)) {
    const code = line.slice(0, commentIdx);
    const comment = line.slice(commentIdx);
    return highlightTSCode(code, colors) + `${commentColor}${comment}${rst}`;
  }
  // Block comment (whole line)
  if (line.trimStart().startsWith("/*") || line.trimStart().startsWith("*")) {
    return `${commentColor}${line}${rst}`;
  }
  return highlightTSCode(line, colors);
};

function highlightTSCode(line: string, colors?: SyntaxColors): string {
  const rst = colors?.reset ?? RESET;
  return colorize(line, [
    [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, colors?.string ?? GREEN],   // strings
    [/\b\d+(\.\d+)?\b/g, colors?.number ?? YELLOW],                                         // numbers
    [TS_KEYWORDS, colors?.keyword ?? MAGENTA],                                               // keywords
    [/(?<=[:]\s*)\b[A-Z]\w*/g, colors?.type ?? CYAN],                                       // types after :
    [/(?<=\bas\s+)\b[A-Z]\w*/g, colors?.type ?? CYAN],                                      // types after as
  ], rst);
}

// ── Python ──────────────────────────────────────────────────────────

const PY_KEYWORDS =
  /\b(def|class|if|elif|else|for|while|return|import|from|with|as|try|except|finally|raise|pass|break|continue|yield|lambda|and|or|not|in|is|None|True|False|global|nonlocal|assert|del|async|await)\b/g;

const pyHighlight: Highlighter = (line, colors) => {
  const commentColor = colors?.comment ?? GRAY;
  const rst = colors?.reset ?? RESET;
  // Comment
  const hashIdx = line.indexOf("#");
  if (hashIdx !== -1 && !isInsideString(line, hashIdx)) {
    const code = line.slice(0, hashIdx);
    const comment = line.slice(hashIdx);
    return highlightPYCode(code, colors) + `${commentColor}${comment}${rst}`;
  }
  // Decorator
  if (line.trimStart().startsWith("@")) {
    return `${colors?.variable ?? YELLOW}${line}${rst}`;
  }
  return highlightPYCode(line, colors);
};

function highlightPYCode(line: string, colors?: SyntaxColors): string {
  const rst = colors?.reset ?? RESET;
  return colorize(line, [
    [/""".*?"""|'''.*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, colors?.string ?? GREEN],  // strings
    [/\b\d+(\.\d+)?\b/g, colors?.number ?? YELLOW],                                         // numbers
    [PY_KEYWORDS, colors?.keyword ?? MAGENTA],                                               // keywords
  ], rst);
}

// ── Bash / Shell ────────────────────────────────────────────────────

const BASH_KEYWORDS =
  /\b(if|then|else|elif|fi|for|do|done|while|until|case|esac|in|function|select|time|coproc|local|export|declare|unset|readonly|return|exit|source|eval)\b/g;

const bashHighlight: Highlighter = (line, colors) => {
  const commentColor = colors?.comment ?? GRAY;
  const rst = colors?.reset ?? RESET;
  // Comment
  const hashIdx = line.indexOf("#");
  if (hashIdx === 0 || (hashIdx > 0 && line[hashIdx - 1] === " " && !isInsideString(line, hashIdx))) {
    const code = line.slice(0, hashIdx);
    const comment = line.slice(hashIdx);
    return highlightBashCode(code, colors) + `${commentColor}${comment}${rst}`;
  }
  return highlightBashCode(line, colors);
};

function highlightBashCode(line: string, colors?: SyntaxColors): string {
  const rst = colors?.reset ?? RESET;
  return colorize(line, [
    [/"(?:[^"\\]|\\.)*"|'[^']*'/g, colors?.string ?? GREEN],   // strings
    [/\$\{?\w+\}?/g, colors?.variable ?? CYAN],                // variables
    [/\b\d+\b/g, colors?.number ?? YELLOW],                    // numbers
    [BASH_KEYWORDS, colors?.keyword ?? MAGENTA],               // keywords
    [/(?<=\|\s*)\w+/g, BOLD],                                  // commands after pipe
  ], rst);
}

// ── JSON ────────────────────────────────────────────────────────────

const jsonHighlight: Highlighter = (line, colors) => {
  const rst = colors?.reset ?? RESET;
  return colorize(line, [
    [/"[^"]*"\s*(?=:)/g, colors?.type ?? CYAN],                            // keys
    [/:\s*"[^"]*"/g, colors?.string ?? GREEN],                             // string values
    [/\b\d+(\.\d+)?([eE][+-]?\d+)?\b/g, colors?.number ?? YELLOW],        // numbers
    [/\b(true|false|null)\b/g, colors?.keyword ?? MAGENTA],                // literals
  ], rst);
};

// ── CSS / SCSS ──────────────────────────────────────────────────────

const cssHighlight: Highlighter = (line, colors) => {
  const commentColor = colors?.comment ?? GRAY;
  const selectorColor = colors?.type ?? CYAN;
  const propColor = colors?.keyword ?? MAGENTA;
  const valColor = colors?.string ?? GREEN;
  const rst = colors?.reset ?? RESET;
  const trimmed = line.trimStart();
  // Comment
  if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("//")) {
    return `${commentColor}${line}${rst}`;
  }
  // Selector line (no colon, or starts with . # & @ or tag)
  if (/^[.#&@a-zA-Z]/.test(trimmed) && !trimmed.includes(":")) {
    return `${selectorColor}${line}${rst}`;
  }
  // Property: value
  const propMatch = line.match(/^(\s*)([\w-]+)(\s*:\s*)(.+)/);
  if (propMatch) {
    return `${propMatch[1]}${propColor}${propMatch[2]}${rst}${propMatch[3]}${valColor}${propMatch[4]}${rst}`;
  }
  return line;
};

// ── Generic fallback ────────────────────────────────────────────────

const genericHighlight: Highlighter = (line, colors) => {
  const rst = colors?.reset ?? RESET;
  return colorize(line, [
    [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, colors?.string ?? GREEN],   // strings
    [/\/\/.*$|#.*$/g, colors?.comment ?? GRAY],                           // comments
    [/\b\d+(\.\d+)?\b/g, colors?.number ?? YELLOW],                      // numbers
  ], rst);
};

// ── Dispatcher ──────────────────────────────────────────────────────

const HIGHLIGHTERS: Record<string, Highlighter> = {
  typescript: tsHighlight,
  javascript: tsHighlight,
  python: pyHighlight,
  bash: bashHighlight,
  json: jsonHighlight,
  css: cssHighlight,
  scss: cssHighlight,
  generic: genericHighlight,
};

/**
 * Highlight a code string for terminal output.
 * Returns the input with ANSI color codes applied.
 */
export function highlightCode(code: string, language: string, colors?: SyntaxColors): string {
  const lang = EXT_MAP[language.toLowerCase()] ?? language.toLowerCase();
  const hl = HIGHLIGHTERS[lang] ?? genericHighlight;
  return code
    .split("\n")
    .map((line) => hl(line, colors))
    .join("\n");
}

// ── Utilities ───────────────────────────────────────────────────────

/** Rough check: is position idx inside a string literal? */
function isInsideString(line: string, idx: number): boolean {
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  for (let i = 0; i < idx; i++) {
    const ch = line[i];
    if (ch === "\\" && (inSingle || inDouble || inTemplate)) {
      i++; // skip escaped char
      continue;
    }
    if (ch === "'" && !inDouble && !inTemplate) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inTemplate) inDouble = !inDouble;
    else if (ch === "`" && !inSingle && !inDouble) inTemplate = !inTemplate;
  }
  return inSingle || inDouble || inTemplate;
}
