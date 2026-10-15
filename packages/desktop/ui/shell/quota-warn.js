// Pure quota decisions. State is supplied by the caller and returned unchanged
// until a notice is actually displayed; polling never consumes unseen notices.
export function quotaPreferences(value = {}) {
  const threshold = Number(value.threshold);
  return { on: value.on !== false, threshold: Number.isFinite(threshold) && threshold >= 50 && threshold <= 99 ? Math.round(threshold) : 90 };
}

export const quotaSessionKey = ({ computer, child }) => JSON.stringify([computer, child.target?.source ?? child.agent, child.target?.session ?? child.id]);

/** Match local account IDs, never a display email or a guessed default Claude login. */
export function sessionUsage(session, accounts = []) {
  const source = session.child.target?.source ?? session.child.agent;
  const account = session.child.account?.id;
  if (source === "claude" && !account) return null;
  const matches = accounts.filter((row) => row.harness === source && row.computers?.some((c) => c.name === session.computer && (source !== "claude" || c.account === account)));
  return matches.length === 1 && !matches[0].stale ? matches[0] : null;
}

const windowNames = { five_hour: "5-hour", seven_day: "weekly", "codex:primary": "5-hour", "codex:secondary": "weekly" };
export function quotaWindows(row, now) {
  return (row?.windows ?? []).filter((w) => windowNames[w.id]).map((w) => {
    const reset = w.reset || Date.parse(w.resetsAt) <= now;
    const used = reset ? null : w.exhausted || w.limited ? 100 : Number.isFinite(w.usedPercent) ? w.usedPercent : Number.isFinite(w.leftPercent) ? 100 - w.leftPercent : null;
    return { ...w, label: windowNames[w.id], used };
  });
}

/** Once at the threshold and once at exhaustion, per session/window/reset.
 * First seeing a window already above the threshold counts as its crossing.
 * Small percentage corrections never rearm the same reset period. */
export function quotaWarnings(session, row, { preferences = {}, suppressed = [], seen = [], now = Date.now() } = {}) {
  const prefs = quotaPreferences(preferences);
  const key = quotaSessionKey(session);
  if (!prefs.on || suppressed.includes(key) || !row || row.stale) return [];
  return quotaWindows(row, now).flatMap((w) => {
    if (w.used === null || w.used < prefs.threshold) return [];
    const base = JSON.stringify([key, row.id, w.id, w.resetsAt ?? "unknown"]);
    const stage = w.used >= 100 ? "exhausted" : "near";
    const token = `${base}/${stage}`;
    return seen.includes(token) || (stage === "near" && seen.includes(`${base}/exhausted`)) ? [] : [{ ...w, token, stage }];
  });
}

/** Rank only signed-in move destinations on this computer by their tightest
 * known window. Unknown usage stays behind known room; exhausted stays last. */
export function quotaDestinations(session, choices, accounts, usage, now = Date.now()) {
  const source = session.child.target?.source ?? session.child.agent;
  const current = sessionUsage(session, usage);
  const candidates = choices.filter((c) => c.usable && c.source !== "claude").map((c) => ({ harness: c.source, label: c.label }));
  for (const account of accounts) {
    if (source === "claude" && account.id === session.child.account?.id) continue;
    candidates.push({ harness: "claude", account: account.id, label: `Claude · ${account.label || account.id}` });
  }
  return candidates.map((candidate) => {
    const rows = usage.filter((r) => r.harness === candidate.harness && r.computers?.some((c) => c.name === session.computer && (candidate.harness !== "claude" || c.account === candidate.account)));
    const row = rows.length === 1 && !rows[0].stale ? rows[0] : null;
    const known = (row?.windows ?? []).filter((w) => !w.reset && !(Date.parse(w.resetsAt) <= now)).map((w) => ({ used: w.exhausted || w.limited ? 100 : Number.isFinite(w.usedPercent) ? w.usedPercent : Number.isFinite(w.leftPercent) ? 100 - w.leftPercent : null })).filter((w) => w.used !== null);
    const left = known.length ? Math.max(0, 100 - Math.max(...known.map((w) => w.used))) : null;
    const exhausted = left === 0 || Boolean(row?.exhausted && !(row.windows ?? []).length);
    return { ...candidate, row, left, exhausted, sameAccount: Boolean(row && current && row.id === current.id) };
  }).filter((c) => !c.sameAccount).sort((a, b) => Number(a.exhausted) - Number(b.exhausted) || (b.left ?? -1) - (a.left ?? -1) || a.label.localeCompare(b.label));
}
