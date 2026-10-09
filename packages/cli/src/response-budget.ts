/**
 * Size budgets for tool output.
 *
 * Claude Code rejects an MCP tool result over about 25k tokens, and the call
 * then fails outright. Store text is long-lined (task Context fields and
 * consolidated reference lines run to several KB), so line-based snippets and
 * per-item limits alone do not bound a response. These budgets are in
 * characters of the serialized result; JSON-escaped markdown is roughly 3–4
 * characters per token.
 */

/** Most characters one search result's snippet may use. */
export const SNIPPET_MAX_CHARS = 1200;
/** Characters shared by all snippets in one search response (each also appears in `data`). */
export const SNIPPETS_TOTAL_CHARS = 6000;
/** Floor for a snippet when many results split the total. */
export const SNIPPET_MIN_CHARS = 240;
/** Per-field cap for text shown in list views (task context, truths). */
export const LIST_TEXT_MAX_CHARS = 300;
/** Most characters of a project's summary.md shown by get_project_summary. */
export const SUMMARY_MAX_CHARS = 6000;
/** Most truths listed by get_project_summary. */
export const SUMMARY_MAX_TRUTHS = 20;
/** Target ceiling for a list response before it shrinks its page size. */
export const LIST_RESPONSE_MAX_CHARS = 40_000;
/** Page size for full-document reads (get_memory_detail). */
export const DETAIL_PAGE_CHARS = 16_000;
/** Hard ceiling for any MCP response; past this the payload is replaced, not sent. */
export const MCP_RESPONSE_MAX_CHARS = 60_000;

/** Per-result snippet budget when `count` results share one response. */
export function snippetBudget(count: number): number {
  if (count <= 0) return SNIPPET_MAX_CHARS;
  return Math.max(SNIPPET_MIN_CHARS, Math.min(SNIPPET_MAX_CHARS, Math.floor(SNIPPETS_TOTAL_CHARS / count)));
}

/** Cut `text` to at most `max` characters, ending with an ellipsis when cut. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…".slice(0, max);
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Cut `text` to at most `max` characters, keeping the end (for append-only notes). */
export function clipTail(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…".slice(0, max);
  return `…${text.slice(text.length - (max - 1)).trimStart()}`;
}

/**
 * Cut `text` to at most `max` characters, keeping a window around the first
 * occurrence of any term (lowercase). Falls back to the start when no term hits.
 */
export function focusText(text: string, terms: string[], max: number): string {
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  let hit = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (hit === -1 || idx < hit)) hit = idx;
  }
  if (hit <= 0) return clipText(text, max);
  // Leave a third of the window as lead-in before the match.
  const room = max - 2;
  let start = Math.max(0, hit - Math.floor(room / 3));
  const end = Math.min(text.length, start + room);
  start = Math.max(0, end - room);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * Build a list payload, halving its page size until the serialized result fits
 * `maxChars` (or the size reaches 1). `build` receives the size to use.
 */
export function shrinkToBudget<T>(initialSize: number, build: (size: number) => T, maxChars = LIST_RESPONSE_MAX_CHARS): { payload: T; size: number } {
  let size = initialSize;
  let payload = build(size);
  while (size > 1 && JSON.stringify(payload, null, 2).length > maxChars) {
    size = Math.max(1, Math.floor(size / 2));
    payload = build(size);
  }
  return { payload, size };
}
