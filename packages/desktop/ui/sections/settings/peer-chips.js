// Settings › Computers: one compact chip per verified Hook peer, from the computer's own /v1/health/details.

function parts(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `peer` is an older Hook than `own` (both known). */
export function olderThan(peer, own) {
  const a = parts(peer), b = parts(own);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** The chip for one peer: { label, level: ok | warn | fail, title }. `ownVersion` is the computer's own Hook version. */
export function peerChip(peer, ownVersion) {
  const name = typeof peer?.name === "string" && peer.name ? peer.name : "Unnamed";
  if (!peer?.reachable) {
    return { label: `${name} · unreachable`, level: "fail", title: peer?.error ? String(peer.error) : "Unreachable. No error was reported." };
  }
  const outdated = olderThan(peer.version, ownVersion);
  const oneWay = peer.listsBack === false;
  const speed = Number.isFinite(peer.ms) ? `${Math.round(peer.ms)} ms` : "reachable";
  const label = outdated ? `${name} · Hook ${String(peer.version).replace(/^v/, "")} (update available)` : `${name} · ${speed}`;
  const notes = [];
  if (outdated) notes.push(`Hook ${peer.version} is older than this computer's ${ownVersion}.`);
  if (oneWay) notes.push(`${name} does not list this computer back.`);
  return { label, level: outdated || oneWay ? "warn" : "ok", title: notes.join(" ") || `Reachable${Number.isFinite(peer.ms) ? ` in ${Math.round(peer.ms)} ms` : ""}.` };
}

/** Every chip for a health read; empty when no peers are enrolled. */
export function peerChips(health, ownVersion) {
  const info = health?.peers;
  if (!info?.configured) return [];
  return (info.computers ?? []).map((peer) => peerChip(peer, ownVersion));
}
