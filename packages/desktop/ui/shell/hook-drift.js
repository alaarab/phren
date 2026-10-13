// Hook drift: which computers run an older Phren Hook than the newest one this
// desktop sees, and the command that updates one. Versions come from each
// computer's overview (`phren.version`), so this costs no Hook calls.

/** Numeric compare of dotted versions ("0.3.45" > "0.3.9"); a pre-release suffix is ignored. */
export function compareVersions(a, b) {
  const parts = (v) => String(v ?? "").split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The Hook version a merged computer reports, when its overview carries one. */
export function hookVersion(computer) {
  const v = computer?.overview?.phren?.version;
  return typeof v === "string" && /^\d+\.\d+\.\d+/.test(v) ? v : null;
}

/** `{ newest, behind }`: the newest Hook version among online computers, and
 * each online computer (by name) that runs an older one, with its version. */
export function hookDrift(computers) {
  const online = (computers ?? []).filter((c) => c.state === "online" && hookVersion(c));
  let newest = null;
  for (const c of online) if (!newest || compareVersions(hookVersion(c), newest) > 0) newest = hookVersion(c);
  const behind = new Map();
  for (const c of online) if (compareVersions(hookVersion(c), newest) < 0) behind.set(c.computer, hookVersion(c));
  return { newest, behind };
}

/** What to run on a computer to bring its Hook to `version`. */
export function updateCommand(version) {
  return `npx --yes @phren/cli@${version} bridge update`;
}
