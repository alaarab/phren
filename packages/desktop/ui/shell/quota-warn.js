import { activeWindow, exhausted, leftPercent, limitingWindow, resetLabel, usedPercent, windowNames } from "./usage-windows.js";
// Pure quota decisions. State is supplied by the caller and returned unchanged
// until a notice is actually displayed; polling never consumes unseen notices.
export function quotaPreferences(value = {}) {
  const threshold = Number(value.threshold);
  return { on: value.on !== false, backOn: value.backOn !== false, threshold: Number.isFinite(threshold) && threshold >= 50 && threshold <= 99 ? Math.round(threshold) : 90 };
}

export const quotaSessionKey = ({ computer, child }) => JSON.stringify([computer, child.target?.source ?? child.agent, child.target?.session ?? child.id]);

/** Match local IDs, or the sole unaccounted Claude row on this computer. */
function usageRow(computer, source, account, accounts) {
  let matches = accounts.filter((row) => row.harness === source && row.computers?.some((c) => c.name === computer));
  if (source === "claude") {
    if (account != null) matches = matches.filter((row) => row.computers.some((c) => c.name === computer && c.account === account));
    else if (matches.length !== 1 || !matches[0].computers.some((c) => c.name === computer && c.account == null)) return null;
  }
  return matches.length === 1 && !matches[0].stale ? matches[0] : null;
}

export function sessionUsage(session, accounts = []) {
  return usageRow(session.computer, session.child.target?.source ?? session.child.agent, session.child.account?.id, accounts);
}

/** Once at the threshold and once at exhaustion, per session/window/reset.
 * First seeing a window already above the threshold counts as its crossing.
 * Small percentage corrections never rearm the same reset period. */
export function quotaWarnings(session, row, { preferences = {}, suppressed = [], seen = [], now = Date.now() } = {}) {
  const prefs = quotaPreferences(preferences);
  const key = quotaSessionKey(session);
  if (!prefs.on || suppressed.includes(key) || !row || row.stale) return [];
  return (row.windows ?? []).filter((w) => windowNames[w.id] && activeWindow(w, now)).map((w) => ({ ...w, label: windowNames[w.id], used: exhausted(w) ? 100 : usedPercent(w) })).flatMap((w) => {
    if (w.used === null || w.used < prefs.threshold) return [];
    const base = JSON.stringify([key, row.id, w.id, w.resetsAt ?? "unknown"]);
    const stage = exhausted(w) ? "exhausted" : "near";
    const token = `${base}/${stage}`;
    return seen.includes(token) || (stage === "near" && seen.includes(`${base}/exhausted`)) ? [] : [{ ...w, token, stage }];
  }).sort((a, b) => Number(b.stage === "exhausted") - Number(a.stage === "exhausted") || b.used - a.used);
}

/** Rank only signed-in move destinations on this computer by their tightest
 * known window. Unknown usage stays behind known room; exhausted stays last. */
export function quotaDestinations(session, choices, accounts, usage, now = Date.now()) {
  const source = session.child.target?.source ?? session.child.agent;
  const current = sessionUsage(session, usage);
  const candidates = choices.filter((c) => c.usable && c.source !== "claude").map((c) => ({ harness: c.source, label: c.label }));
  for (const account of accounts) {
    if (source === "claude" && account.id === session.child.account?.id) continue;
    candidates.push({ harness: "claude", account: account.id, accountLabel: account.label || account.id, label: `Claude · ${account.label || account.id}` });
  }
  return candidates.map((candidate) => {
    // A sole inventory login can be the unaccounted current row; never map
    // that row onto one of several named destinations.
    const account = source === "claude" && session.child.account?.id == null && current && accounts.length === 1 ? undefined : candidate.account;
    const row = usageRow(session.computer, candidate.harness, account, usage);
    const limiting = limitingWindow(row, now);
    const left = leftPercent(limiting);
    const out = exhausted(row && { ...row, windows: row.windows?.filter((w) => activeWindow(w, now)) });
    return { ...candidate, row, limiting, left, exhausted: out, sameAccount: Boolean(row && current && row.id === current.id) };
  }).filter((c) => !c.sameAccount).sort((a, b) => Number(a.exhausted) - Number(b.exhausted) || (b.left ?? -1) - (a.left ?? -1) || a.label.localeCompare(b.label));
}

/** The same status fields that renderInteractions uses for inline cards. */
export function quotaInteractionPending(status) {
  return !status || Boolean(status.pendingApproval || status.passwordPrompt
    || status.pendingQuestions?.some((prompt) => prompt.questions?.length)
    || status.terminalPrompt?.questions?.length);
}

/** Each destination explains the window that constrains its remaining room. */
export function quotaDestinationText(destination, now = Date.now()) {
  const { limiting, left, exhausted, row } = destination;
  const window = limiting ? windowNames[limiting.id] || limiting.name || "limit" : "";
  const room = exhausted ? "Exhausted" : left === null ? "Usage unknown" : `${Math.round(left)}% left`;
  const parts = [`${destination.label} · ${room}${window ? ` of ${window}` : ""}`];
  const reset = resetLabel(limiting, now);
  parts.push((!(Date.parse(limiting?.resetsAt) > now) && exhausted && row?.availableIn) ? `back in ${row.availableIn}` : reset);
  return parts.join(" · ");
}
