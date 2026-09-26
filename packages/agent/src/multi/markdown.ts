/**
 * Simple markdown-to-ANSI renderer for terminal output.
 * Regex-based, no AST parser. Handles the common subset of markdown
 * that LLMs produce: headers, bold, inline code, code blocks, bullet lists.
 */

import { highlightCode, detectLanguage } from "./syntax-highlight.js";
import type { SyntaxColors } from "./syntax-highlight.js";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;
const STRIKE = `${ESC}9m`;
const CYAN = `${ESC}36m`;
const YELLOW = `${ESC}33m`;
const _GREEN = `${ESC}32m`;
const _MAGENTA = `${ESC}35m`;
const INVERSE = `${ESC}7m`;

const MAX_WIDTH_CAP = 120;

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
  syntax?: SyntaxColors;
};

/** Render basic markdown to ANSI-colored terminal text. */
export function renderMarkdown(text: string, colors?: MarkdownColors, width?: number): string {
  const h    = colors?.heading        ?? BOLD + YELLOW;
  const bd   = colors?.bold           ?? BOLD;
  const it   = colors?.italic         ?? ITALIC;
  const cd   = colors?.code           ?? CYAN + INVERSE;
  const cbb  = colors?.codeBlockBorder ?? DIM;
  const cbl  = colors?.codeBlockLabel  ?? DIM + YELLOW;
  const lnk  = colors?.link           ?? `${ESC}4m${CYAN}`;
  const rst  = colors?.reset          ?? RESET;

  const maxWidth = width ?? Math.min(process.stdout.columns || 80, MAX_WIDTH_CAP);

  const syn = colors?.syntax;
  const syntaxColors: SyntaxColors | undefined = syn ? {
    keyword: syn.keyword ?? cd,
    string: syn.string ?? cd,
    number: syn.number ?? cd,
    comment: syn.comment ?? cbb,
    type: syn.type ?? cd,
    variable: syn.variable ?? cd,
    operator: syn.operator ?? cd,
    function: syn.function ?? cd,
    punctuation: syn.punctuation ?? cd,
    reset: syn.reset ?? rst,
  } : undefined;

  const lines = text.split("\n");
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLang = "";
  let codeBuffer: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block fences
    if (line.trimStart().startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = line.trimStart().slice(3).trim();
        codeBuffer = [];
        const label = codeLang ? ` ${codeLang}` : "";
        const fill = Math.max(0, maxWidth - 5 - label.length);
        out.push(`${cbb}  ┌──${rst}${cbl}${label}${rst}${cbb}${"─".repeat(fill)}${rst}`);
      } else {
        // Flush code buffer through syntax highlighter
        const lang = codeLang ? detectLanguage(codeLang) : "generic";
        const highlighted = highlightCode(codeBuffer.join("\n"), lang, syntaxColors);
        for (const hl of highlighted.split("\n")) {
          out.push(`${cbb}  │ ${rst}${hl}`);
        }
        inCodeBlock = false;
        codeLang = "";
        codeBuffer = [];
        out.push(`${cbb}  └${"─".repeat(Math.max(0, maxWidth - 3))}${rst}`);
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line.slice(0, Math.max(0, maxWidth - 4)));
      continue;
    }

    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(`${cbb}${"─".repeat(maxWidth)}${rst}`);
      continue;
    }

    // Headers
    const h3 = line.match(/^###\s+(.+)/);
    if (h3) { out.push(`${h}   ${h3[1]}${rst}`); continue; }

    const h2 = line.match(/^##\s+(.+)/);
    if (h2) { out.push(`${h}  ${h2[1]}${rst}`); continue; }

    const h1 = line.match(/^#\s+(.+)/);
    if (h1) { out.push(`${h}${h1[1]}${rst}`); continue; }

    const quote = line.match(/^(\s*)>\s?(.*)$/);
    if (quote) {
      const content = renderInline(quote[2], bd, it, cd, rst, lnk);
      out.push(`${quote[1]}${cbb}│ ${rst}${DIM}${content}${rst}`);
      continue;
    }

    if (i + 1 < lines.length && isTableRow(line) && isSeparatorRow(lines[i + 1])) {
      const table = renderTable(lines, i, { bd, it, cd, rst, lnk, cbb });
      out.push(...table.rendered);
      i = table.next - 1;
      continue;
    }

    const task = line.match(/^(\s*)[*+-]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      const depth = indentDepth(task[1]);
      const blt = colors?.bullet ?? DIM + BOLD;
      const box = task[2].toLowerCase() === "x" ? "☑" : "☐";
      const content = renderInline(task[3], bd, it, cd, rst, lnk);
      out.push(`${"  ".repeat(depth + 1)}${blt}${box}${rst} ${content}`);
      continue;
    }

    // Bullet lists (-, *, +)
    const bullet = line.match(/^(\s*)[*+-]\s+(.+)/);
    if (bullet) {
      const depth = indentDepth(bullet[1]);
      const marks = ["·", "◦", "▪", "‣"];
      const mark = marks[depth % marks.length];
      const blt = colors?.bullet ?? DIM + BOLD;
      const content = renderInline(bullet[2], bd, it, cd, rst, lnk);
      out.push(`${"  ".repeat(depth + 1)}${blt}${mark}${rst} ${content}`);
      continue;
    }

    // Numbered lists
    const numbered = line.match(/^(\s*)(\d+[.)])\s+(.+)/);
    if (numbered) {
      const depth = indentDepth(numbered[1]);
      const content = renderInline(numbered[3], bd, it, cd, rst, lnk);
      out.push(`${"  ".repeat(depth + 1)}${DIM}${numbered[2]}${rst} ${content}`);
      continue;
    }

    // Regular line — apply inline formatting
    out.push(renderInline(line, bd, it, cd, rst, lnk));
  }

  return out.join("\n");
}

function indentDepth(indent: string): number {
  return Math.floor(indent.replace(/\t/g, "  ").length / 2);
}

function isTableRow(line: string): boolean {
  return line.includes("|");
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(line: string): boolean {
  if (!line.includes("|") || !line.includes("-")) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

type TableCtx = {
  bd: string;
  it: string;
  cd: string;
  rst: string;
  lnk: string;
  cbb: string;
};

function renderTable(
  lines: string[],
  start: number,
  ctx: TableCtx,
): { rendered: string[]; next: number } {
  const { bd, it, cd, rst, lnk, cbb } = ctx;
  try {
    const header = splitTableRow(lines[start]);
    const aligns = splitTableRow(lines[start + 1]).map((cell) => {
      const left = cell.startsWith(":");
      const right = cell.endsWith(":");
      return left && right ? "center" : right ? "right" : "left";
    });

    const rows: string[][] = [];
    let j = start + 2;
    while (j < lines.length && isTableRow(lines[j]) && !isSeparatorRow(lines[j])) {
      const cells = splitTableRow(lines[j]);
      rows.push(header.map((_, c) => cells[c] ?? ""));
      j++;
    }

    const cols = header.length;
    const widths = header.map((cell, c) =>
      Math.max(cell.length, ...rows.map((row) => row[c]?.length ?? 0)),
    );

    const pad = (text: string, width: number, align: string): string => {
      const padding = Math.max(0, width - text.length);
      if (align === "right") return " ".repeat(padding) + text;
      if (align === "center") {
        const left = Math.floor(padding / 2);
        return " ".repeat(left) + text + " ".repeat(padding - left);
      }
      return text + " ".repeat(padding);
    };

    const renderRow = (cells: string[], isHeader: boolean): string => {
      const parts = cells.slice(0, cols).map((cell, c) => {
        const aligned = pad(cell, widths[c], aligns[c] ?? "left");
        return isHeader ? `${bd}${aligned}${rst}` : renderInline(aligned, bd, it, cd, rst, lnk);
      });
      return `${cbb}│${rst} ${parts.join(` ${cbb}│${rst} `)} ${cbb}│${rst}`;
    };

    const separator = `${cbb}├${widths.map((w) => "─".repeat(w + 2)).join("┼")}┤${rst}`;
    const rendered = [renderRow(header, true), separator, ...rows.map((row) => renderRow(row, false))];
    return { rendered, next: j };
  } catch {
    return { rendered: [renderInline(lines[start], bd, it, cd, rst, lnk)], next: start + 1 };
  }
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
  result = result.replace(/`([^`]+)`/g, `${code}$1${reset}`);

  // Markdown links [text](url) — render as OSC 8 hyperlinks
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) => {
    return osc8Link(url, linkText, link, reset);
  });

  result = result.replace(/~~(.+?)~~/g, `${STRIKE}$1${reset}`);

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
