import type { ModelEntry, ReasoningLevel } from "./model-picker.js";

/** Provider-qualified rows keep identical model IDs on different connectors
 * distinct. Filtering and viewport placement are shared by both pickers. */
export function pickerRows(models: ModelEntry[], query: string): number[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return models.flatMap((model, index) => {
    const text = `${model.provider} ${model.id} ${model.label}`.toLowerCase();
    return terms.every(term => text.includes(term)) ? [index] : [];
  });
}
export function movePicker(rows: number[], cursor: number, delta: number): number {
  if (!rows.length) return cursor;
  const at = rows.indexOf(cursor);
  return rows[(Math.max(0, at) + delta % rows.length + rows.length) % rows.length];
}
export function pickerWindow(rows: number[], cursor: number, size: number): number[] {
  const count = Math.max(1, size);
  const start = Math.max(0, Math.min(Math.max(0, rows.indexOf(cursor)) - Math.floor(count / 2), rows.length - count));
  return rows.slice(start, start + count);
}

/** Move within this model's supported scale, never another provider's scale. */
export function moveReasoning(range: ReasoningLevel[], current: ReasoningLevel, delta: number): ReasoningLevel {
  if (!range.length) return current;
  const index = range.indexOf(current);
  const next = index < 0 ? (delta > 0 ? 0 : range.length - 1) : Math.max(0, Math.min(range.length - 1, index + delta));
  return range[next];
}
