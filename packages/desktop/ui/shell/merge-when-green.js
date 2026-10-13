// Merge when green: a request armed in Changes › PRs is merged by the desktop,
// with the armed method at the armed head, once its checks pass. One
// /v1/git/pulls per armed request every minute, only while something is
// armed, and only while the desktop is open (arming is not saved). Plain
// browser ES module.

import { hookPost } from "../api.js";

export const MERGE_WATCH_MS = 60_000;

const armed = new Map(); // key -> { key, computer, scope, number, method, headSha, repository, ref, title, project }
const listeners = new Set();
let wake = null;

const keyOf = (computer, repository, number) => `${computer}\u0000${repository || ""}\u0000${number}`;
const changed = () => { for (const fn of listeners) fn(); };

/** What to do with an armed request given its latest look: "merge", "wait",
 *  or { stop } with why it is disarmed. */
export function mergeDecision(arm, pull) {
  if (!pull || pull.number !== arm.number) return { stop: "the branch no longer has it open" };
  if (pull.state && pull.state !== "OPEN") return { stop: pull.state === "MERGED" ? "it was merged" : "it was closed" };
  if (arm.headSha && pull.headSha && pull.headSha !== arm.headSha) return { stop: "new commits arrived; arm it again" };
  if (pull.checks === "failing") return { stop: "checks failed" };
  if (pull.draft || pull.mergeState === "DRAFT") return { stop: "it is a draft" };
  if (pull.mergeState === "DIRTY") return { stop: "it has conflicts" };
  if (pull.checks !== "passing") return "wait";
  if (pull.mergeState === "BLOCKED" || pull.mergeState === "UNKNOWN") return "wait";
  return "merge";
}

/** Whether this request is armed. */
export function isArmed(computer, repository, number) {
  return armed.has(keyOf(computer, repository, number));
}

/** Arm a request. `scope` is the /v1/git body that finds its branch
 *  ({ target, worktree? }); `headSha` pins the commit that may be merged. */
export function armMerge({ computer, scope, number, method, headSha, repository, ref = "#", title = "", project = "" }) {
  const key = keyOf(computer, repository, number);
  armed.set(key, { key, computer, scope, number, method, headSha, repository, ref, title, project });
  changed();
  wake?.();
}

export function disarmMerge(computer, repository, number) {
  if (armed.delete(keyOf(computer, repository, number))) changed();
}

/** Call `fn()` whenever the armed set changes. Returns the stop. */
export function onArmedChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Start the watch; `notify(title, body)` is the shell's (absent in a browser). */
export function startMergeWhenGreen({ notify }) {
  let running = false;
  const tell = (arm, what) => notify?.(`${arm.project || "Merge when green"}: ${arm.ref}${arm.number} ${what}`, arm.title);
  async function look(arm) {
    const body = await hookPost(arm.computer, "/v1/git/pulls", arm.scope).catch(() => null);
    if (!body || !armed.has(arm.key)) return; // a failed read waits for the next look
    const decision = mergeDecision(arm, body.current);
    if (decision === "wait") return;
    armed.delete(arm.key);
    changed();
    if (decision !== "merge") { tell(arm, `not merged: ${decision.stop}`); return; }
    const res = await hookPost(arm.computer, "/v1/git/pr/merge", {
      ...arm.scope, number: arm.number, method: arm.method,
      ...(arm.headSha ? { expectedHeadSha: arm.headSha } : {}),
      ...(arm.repository ? { expectedRepository: arm.repository } : {}),
    }).catch((e) => ({ ok: false, message: e?.message }));
    tell(arm, res && res.ok ? "merged" : `not merged: ${(res && res.message) || "the host refused it"}`);
  }
  async function tick() {
    if (running || !armed.size) return;
    running = true;
    try {
      await Promise.all([...armed.values()].map(look));
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => { void tick(); }, MERGE_WATCH_MS);
  wake = () => { void tick(); };
  return { stop() { clearInterval(timer); wake = null; } };
}
