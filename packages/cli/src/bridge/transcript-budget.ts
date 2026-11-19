import type { Json } from "./protocol.js";

/**
 * Bytes of rows one transcript page carries (an opening backlog, a reconnect,
 * a live append, an older page), so its frame stays under 256 KB. A phone
 * reaches the Hook through Tailscale, often over a relay, and megabyte frames
 * knocked its tunnel out.
 */
export const PAGE_BYTES = 196_608;
/**
 * A reconnect or live delta up to this size is sent whole and in order, one
 * page per read. A larger one is replaced by its newest page.
 */
export const DELTA_BYTES = 4 * PAGE_BYTES;

const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** The start and end of `text`, never cut inside a surrogate pair. */
function shorten(text: string, keep: number): string {
  let head = Math.ceil(keep * 2 / 3), tail = text.length - (keep - head);
  const before = text.charCodeAt(head - 1), after = text.charCodeAt(tail);
  if (before >= 0xd800 && before <= 0xdbff) head--;
  if (after >= 0xdc00 && after <= 0xdfff) tail++;
  return `${text.slice(0, head)}\n… (${tail - head} characters left out)\n${text.slice(tail)}`;
}

function clamp(value: unknown, cap: number, parse = true): unknown {
  if (typeof value === "string") {
    if (value.length <= cap) return value;
    // Tool arguments and outputs are often JSON kept as text: shorten the
    // strings inside so the text still parses.
    if (parse && /^\s*[{[]/.test(value)) {
      try { return JSON.stringify(clamp(JSON.parse(value), cap)); } catch { /* Plain text after all. */ }
    }
    return shorten(value, cap);
  }
  if (Array.isArray(value)) return value.map(item => clamp(item, cap, parse));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clamp(item, cap, parse)]));
  return value;
}

/** `value` with the middle of every list longer than `keep` left out. */
function thin(value: unknown, keep: number): unknown {
  if (Array.isArray(value)) {
    const items = value.length > keep ? [...value.slice(0, Math.ceil(keep / 2)), ...value.slice(value.length - Math.floor(keep / 2))] : value;
    return items.map(item => thin(item, keep));
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, thin(item, keep)]));
  return value;
}

/**
 * One transcript line's rows, with their long strings shortened until the
 * line fits a page: a tool output or a written file of several megabytes
 * shows its start and end rather than filling a frame or being left out.
 * The caller leaves out a line whose `size` is still over `limit`.
 */
export function clampRows(rows: Json[], limit = PAGE_BYTES): { rows: Json[]; size: number } {
  let size = byteSize(rows);
  if (size <= limit) return { rows, size };
  let clamped = rows;
  for (let cap = 131_072; cap >= 256 && size > limit; cap /= 2) {
    clamped = clamp(rows, cap) as Json[];
    size = byteSize(clamped);
  }
  // JSON text that is large without one long string (thousands of items) is cut as text.
  if (size > limit) { clamped = clamp(rows, 4_096, false) as Json[]; size = byteSize(clamped); }
  // Thousands of short items: keep the start and end of each long list.
  // Items are left out without a marker, so every list keeps its item type.
  const cut = clamped;
  for (let keep = 256; keep >= 2 && size > limit; keep /= 2) {
    clamped = cut.map(row => thin(row, keep) as Json);
    size = byteSize(clamped);
  }
  return { rows: clamped, size };
}
