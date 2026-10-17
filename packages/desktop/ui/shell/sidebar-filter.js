// The Agents sidebar's filter box: which session rows a typed query keeps. Pure, so the sidebar,
// the unit test and any future caller share one rule.

/** The words of a query, lower-cased; empty for a blank one. */
export function filterWords(query) {
  return String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

/** What a row can be found by: title, project (folder and label), branch, computer name and harness. */
export function filterText(row) {
  const child = row.child ?? {};
  const folder = String(child.cwd ?? "").split("/").filter(Boolean).pop() ?? "";
  return [child.title, folder, child.label, child.branch, row.computer, child.agent, child.target?.source]
    .filter((part) => typeof part === "string" && part).join("\n").toLowerCase();
}

/** Does the row match every word of the query, in any order and case? A blank query matches everything. */
export function matchesSessionFilter(row, query) {
  const words = filterWords(query);
  if (!words.length) return true;
  const text = filterText(row);
  return words.every((word) => text.includes(word));
}

/** The rows a query keeps, in their order; the same array when the query is blank. */
export function filterSessionRows(rows, query) {
  return filterWords(query).length ? rows.filter((row) => matchesSessionFilter(row, query)) : rows;
}
