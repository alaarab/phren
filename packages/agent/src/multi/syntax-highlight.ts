/**
 * Regex-based syntax highlighter for terminal code blocks.
 * Zero external dependencies — uses raw ANSI escape codes.
 * Line-by-line, single-pass processing.
 */

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
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

// ── Highlighters ────────────────────────────────────────────────────

type Highlighter = (line: string) => string;

// Helper: replace matches while preserving non-matched segments
function colorize(line: string, rules: [RegExp, string][]): string {
  // We process rules sequentially; each rule operates on uncolored segments only.
  // Segments already colored are wrapped in \x1b and end with RESET.
  let result = line;
  for (const [re, color] of rules) {
    result = result.replace(re, (match) => `${color}${match}${RESET}`);
  }
  return result;
}

// ── TypeScript / JavaScript ─────────────────────────────────────────

const TS_KEYWORDS =
  /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|typeof|instanceof|void|delete|throw|try|catch|finally|import|export|from|default|class|extends|implements|async|await|yield|type|interface|enum|namespace|declare|readonly|abstract|static|get|set|of|in|as|is)\b/g;

const tsHighlight: Highlighter = (line) => {
  // Single-line comment
  const commentIdx = line.indexOf("//");
  if (commentIdx !== -1 && !isInsideString(line, commentIdx)) {
    const code = line.slice(0, commentIdx);
    const comment = line.slice(commentIdx);
    return highlightTSCode(code) + `${GRAY}${comment}${RESET}`;
  }
  // Block comment (whole line)
  if (line.trimStart().startsWith("/*") || line.trimStart().startsWith("*")) {
    return `${GRAY}${line}${RESET}`;
  }
  return highlightTSCode(line);
};

function highlightTSCode(line: string): string {
  return colorize(line, [
    [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, GREEN],   // strings
    [/\b\d+(\.\d+)?\b/g, YELLOW],                                         // numbers
    [TS_KEYWORDS, MAGENTA],                                                // keywords
    [/(?<=[:]\s*)\b[A-Z]\w*/g, CYAN],                                     // types after :
    [/(?<=\bas\s+)\b[A-Z]\w*/g, CYAN],                                    // types after as
  ]);
}

// ── Python ──────────────────────────────────────────────────────────

const PY_KEYWORDS =
  /\b(def|class|if|elif|else|for|while|return|import|from|with|as|try|except|finally|raise|pass|break|continue|yield|lambda|and|or|not|in|is|None|True|False|global|nonlocal|assert|del|async|await)\b/g;

const pyHighlight: Highlighter = (line) => {
  // Comment
  const hashIdx = line.indexOf("#");
  if (hashIdx !== -1 && !isInsideString(line, hashIdx)) {
    const code = line.slice(0, hashIdx);
    const comment = line.slice(hashIdx);
    return highlightPYCode(code) + `${GRAY}${comment}${RESET}`;
  }
  // Decorator
  if (line.trimStart().startsWith("@")) {
    return `${YELLOW}${line}${RESET}`;
  }
  return highlightPYCode(line);
};

function highlightPYCode(line: string): string {
  return colorize(line, [
    [/""".*?"""|'''.*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, GREEN],  // strings
    [/\b\d+(\.\d+)?\b/g, YELLOW],                                         // numbers
    [PY_KEYWORDS, MAGENTA],                                                // keywords
  ]);
}

// ── Bash / Shell ────────────────────────────────────────────────────

const BASH_KEYWORDS =
  /\b(if|then|else|elif|fi|for|do|done|while|until|case|esac|in|function|select|time|coproc|local|export|declare|unset|readonly|return|exit|source|eval)\b/g;

const bashHighlight: Highlighter = (line) => {
  // Comment
  const hashIdx = line.indexOf("#");
  if (hashIdx === 0 || (hashIdx > 0 && line[hashIdx - 1] === " " && !isInsideString(line, hashIdx))) {
    const code = line.slice(0, hashIdx);
    const comment = line.slice(hashIdx);
    return highlightBashCode(code) + `${GRAY}${comment}${RESET}`;
  }
  return highlightBashCode(line);
};

function highlightBashCode(line: string): string {
  return colorize(line, [
    [/"(?:[^"\\]|\\.)*"|'[^']*'/g, GREEN],                // strings
    [/\$\{?\w+\}?/g, CYAN],                               // variables
    [/\b\d+\b/g, YELLOW],                                  // numbers
    [BASH_KEYWORDS, MAGENTA],                              // keywords
    [/(?<=\|\s*)\w+/g, BOLD],                              // commands after pipe
  ]);
}

// ── JSON ────────────────────────────────────────────────────────────

const jsonHighlight: Highlighter = (line) => {
  return colorize(line, [
    [/"[^"]*"\s*(?=:)/g, CYAN],                            // keys
    [/:\s*"[^"]*"/g, GREEN],                               // string values
    [/\b\d+(\.\d+)?([eE][+-]?\d+)?\b/g, YELLOW],          // numbers
    [/\b(true|false|null)\b/g, MAGENTA],                   // literals
  ]);
};

// ── CSS / SCSS ──────────────────────────────────────────────────────

const cssHighlight: Highlighter = (line) => {
  const trimmed = line.trimStart();
  // Comment
  if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("//")) {
    return `${GRAY}${line}${RESET}`;
  }
  // Selector line (no colon, or starts with . # & @ or tag)
  if (/^[.#&@a-zA-Z]/.test(trimmed) && !trimmed.includes(":")) {
    return `${CYAN}${line}${RESET}`;
  }
  // Property: value
  const propMatch = line.match(/^(\s*)([\w-]+)(\s*:\s*)(.+)/);
  if (propMatch) {
    return `${propMatch[1]}${MAGENTA}${propMatch[2]}${RESET}${propMatch[3]}${GREEN}${propMatch[4]}${RESET}`;
  }
  return line;
};

// ── Generic fallback ────────────────────────────────────────────────

const genericHighlight: Highlighter = (line) => {
  return colorize(line, [
    [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, GREEN],      // strings
    [/\/\/.*$|#.*$/g, GRAY],                               // comments
    [/\b\d+(\.\d+)?\b/g, YELLOW],                         // numbers
  ]);
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
export function highlightCode(code: string, language: string): string {
  const lang = EXT_MAP[language.toLowerCase()] ?? language.toLowerCase();
  const hl = HIGHLIGHTERS[lang] ?? genericHighlight;
  return code
    .split("\n")
    .map((line) => hl(line))
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
