// Small text helpers shared across the UI.

/** "1 file", "3 files": a count with its noun, plural unless the count is one. */
export function countOf(n, noun, plural = `${noun}s`) {
  return `${n} ${n === 1 ? noun : plural}`;
}
