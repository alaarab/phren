/**
 * Simple markdown-to-ANSI renderer for terminal output.
 * Regex-based, no AST parser. Handles the common subset of markdown
 * that LLMs produce: headers, bold, inline code, code blocks, bullet lists.
 */

import { highlightCode, detectLanguage } from "./syntax-highlight.js";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;
const CYAN = `${ESC}36m`;
const YELLOW = `${ESC}33m`;
const GREEN = `${ESC}32m`;
const MAGENTA = `${ESC}35m`;
const INVERSE = `${ESC}7m`;

const MAX_WIDTH = Math.min(process.stdout.columns || 80, 120);

export type MarkdownColors = {
  heading: string;
  bold: string;
  italic: string;
  code: string;
  codeBlockBorder: string;
  codeBlockLabel: string;
  bullet: string;
  link: string;
  reset: string;
};

/** Render basic markdown to ANSI-colored terminal text. */
export function renderMarkdown(text: string, colors?: MarkdownColors): string {
  const h    = colors?.heading        ?? BOLD + YELLOW;
  const bd   = colors?.bold           ?? BOLD;
  const it   = colors?.italic         ?? ITALIC;
  const cd   = colors?.code           ?? CYAN + INVERSE;
  const cbb  = colors?.codeBlockBorder ?? DIM;
  const lnk  = colors?.link           ?? `${ESC}4m${CYAN}`;
  const rst  = colors?.reset          ?? RESET;

  const lines = text.split("\n");
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLang = "";
  let codeBuffer: string[] = [];

  for (const line of lines) {
    // Code block fences
    if (line.trimStart().startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = line.trimStart().slice(3).trim();
        codeBuffer = [];
        const label = codeLang ? ` ${codeLang}` : "";
        out.push(`${cbb}  ┌──${label}${"─".repeat(Math.max(0, MAX_WIDTH - 6 - label.length))}${rst}`);
      } else {
        // Flush code buffer through syntax highlighter
        const lang = codeLang ? detectLanguage(codeLang) : "generic";
        const syntaxColors = colors ? {
          keyword: colors.code,
          string: colors.code,
          number: colors.code,
          comment: colors.codeBlockBorder,
          type: colors.code,
          variable: colors.code,
          operator: colors.code,
          reset: colors.reset,
        } : undefined;
        const highlighted = highlightCode(codeBuffer.join("\n"), lang, syntaxColors);
        for (const hl of highlighted.split("\n")) {
          out.push(`${cbb}  │ ${rst}${hl}`);
        }
        inCodeBlock = false;
        codeLang = "";
        codeBuffer = [];
        out.push(`${cbb}  └${"─".repeat(MAX_WIDTH - 3)}${rst}`);
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line.slice(0, MAX_WIDTH - 4));
      continue;
    }

    // Headers
    const h3 = line.match(/^###\s+(.+)/);
    if (h3) { out.push(`${h}   ${h3[1]}${rst}`); continue; }

    const h2 = line.match(/^##\s+(.+)/);
    if (h2) { out.push(`${h}  ${h2[1]}${rst}`); continue; }

    const h1 = line.match(/^#\s+(.+)/);
    if (h1) { out.push(`${h}${h1[1]}${rst}`); continue; }

    // Bullet lists (-, *, +)
    const bullet = line.match(/^(\s*)[*+-]\s+(.+)/);
    if (bullet) {
      const indent = bullet[1];
      const content = renderInline(bullet[2], bd, it, cd, rst, lnk);
      const blt = colors?.bullet ?? DIM + BOLD;
      out.push(`${indent}  ${blt}·${rst} ${content}`);
      continue;
    }

    // Numbered lists
    const numbered = line.match(/^(\s*)\d+[.)]\s+(.+)/);
    if (numbered) {
      const indent = numbered[1];
      const num = line.match(/^(\s*)(\d+[.)])/);
      const content = renderInline(numbered[2], bd, it, cd, rst, lnk);
      out.push(`${indent}  ${DIM}${num![2]}${rst} ${content}`);
      continue;
    }

    // Regular line — apply inline formatting
    out.push(renderInline(line, bd, it, cd, rst, lnk));
  }

  return out.join("\n");
}

/** Wrap text in an OSC 8 hyperlink escape sequence. */
function osc8Link(url: string, text: string, linkStyle: string, reset: string): string {
  return `\x1b]8;;${url}\x07${linkStyle}${text}${reset}\x1b]8;;\x07`;
}

/** Apply inline formatting: bold, italic, inline code, links. */
function renderInline(
  text: string,
  bold = BOLD,
  italic = ITALIC,
  code = CYAN + INVERSE,
  reset = RESET,
  link = `${ESC}4m${CYAN}`,
): string {
  let result = text;

  // Inline code (must go first to avoid bold/italic inside code)
  result = result.replace(/`([^`]+)`/g, `${code} $1 ${reset}`);

  // Markdown links [text](url) — render as OSC 8 hyperlinks
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) => {
    return osc8Link(url, linkText, link, reset);
  });

  // Bold+italic (***text*** or ___text___)
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, `${bold}${italic}$1${reset}`);
  result = result.replace(/___(.+?)___/g, `${bold}${italic}$1${reset}`);

  // Bold (**text** or __text__)
  result = result.replace(/\*\*(.+?)\*\*/g, `${bold}$1${reset}`);
  result = result.replace(/__(.+?)__/g, `${bold}$1${reset}`);

  // Italic (*text* or _text_ — careful not to match mid-word underscores)
  result = result.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, `${italic}$1${reset}`);
  result = result.replace(/(?<!\w)_([^_]+)_(?!\w)/g, `${italic}$1${reset}`);

  return result;
}
