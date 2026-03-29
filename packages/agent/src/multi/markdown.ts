/**
 * Simple markdown-to-ANSI renderer for terminal output.
 * Regex-based, no AST parser. Handles the common subset of markdown
 * that LLMs produce: headers, bold, inline code, code blocks, bullet lists.
 */

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

const MAX_WIDTH = 80;

/** Render basic markdown to ANSI-colored terminal text. */
export function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLang = "";

  for (const line of lines) {
    // Code block fences
    if (line.trimStart().startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = line.trimStart().slice(3).trim();
        const label = codeLang ? ` ${codeLang}` : "";
        out.push(`${DIM}  ┌──${label}${"─".repeat(Math.max(0, MAX_WIDTH - 6 - label.length))}${RESET}`);
      } else {
        inCodeBlock = false;
        codeLang = "";
        out.push(`${DIM}  └${"─".repeat(MAX_WIDTH - 3)}${RESET}`);
      }
      continue;
    }

    if (inCodeBlock) {
      out.push(`${DIM}  │ ${line.slice(0, MAX_WIDTH - 4)}${RESET}`);
      continue;
    }

    // Headers
    const h3 = line.match(/^###\s+(.+)/);
    if (h3) { out.push(`${MAGENTA}${BOLD}   ${h3[1]}${RESET}`); continue; }

    const h2 = line.match(/^##\s+(.+)/);
    if (h2) { out.push(`${GREEN}${BOLD}  ${h2[1]}${RESET}`); continue; }

    const h1 = line.match(/^#\s+(.+)/);
    if (h1) { out.push(`${YELLOW}${BOLD}${h1[1]}${RESET}`); continue; }

    // Bullet lists (-, *, +)
    const bullet = line.match(/^(\s*)[*+-]\s+(.+)/);
    if (bullet) {
      const indent = bullet[1];
      const content = renderInline(bullet[2]);
      out.push(`${indent}  ${DIM}${BOLD}·${RESET} ${content}`);
      continue;
    }

    // Numbered lists
    const numbered = line.match(/^(\s*)\d+[.)]\s+(.+)/);
    if (numbered) {
      const indent = numbered[1];
      const num = line.match(/^(\s*)(\d+[.)])/);
      const content = renderInline(numbered[2]);
      out.push(`${indent}  ${DIM}${num![2]}${RESET} ${content}`);
      continue;
    }

    // Regular line — apply inline formatting
    out.push(renderInline(line));
  }

  return out.join("\n");
}

/** Apply inline formatting: bold, italic, inline code. */
function renderInline(text: string): string {
  let result = text;

  // Inline code (must go first to avoid bold/italic inside code)
  result = result.replace(/`([^`]+)`/g, `${CYAN}${INVERSE} $1 ${RESET}`);

  // Bold+italic (***text*** or ___text___)
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, `${BOLD}${ITALIC}$1${RESET}`);
  result = result.replace(/___(.+?)___/g, `${BOLD}${ITALIC}$1${RESET}`);

  // Bold (**text** or __text__)
  result = result.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);
  result = result.replace(/__(.+?)__/g, `${BOLD}$1${RESET}`);

  // Italic (*text* or _text_ — careful not to match mid-word underscores)
  result = result.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, `${ITALIC}$1${RESET}`);
  result = result.replace(/(?<!\w)_([^_]+)_(?!\w)/g, `${ITALIC}$1${RESET}`);

  return result;
}
