// Warm the slow sections while the app is idle: once a computer is online,
// mount Projects and Tasks hidden (their mount starts their first reads), so
// the first visit draws from memory instead of waiting on every Hook.
import { store } from "./store.js";
import { sectionHandle } from "./sections.js";

export const WARM_SECTIONS = ["projects", "tasks"];
const SETTLE_MS = 3000;

/** Start warming after the first overview with an online computer; returns a stop function. */
export function startWarm({ sections = WARM_SECTIONS, mount = sectionHandle, settleMs = SETTLE_MS } = {}) {
  const idle = globalThis.requestIdleCallback ?? ((fn) => setTimeout(fn, 1));
  let timer = null;
  let stopped = false;
  const queue = [...sections];
  const next = () => {
    if (stopped || !queue.length) return;
    // One section per idle slot, so warming never stacks into one long task.
    idle(() => { if (stopped) return; mount(queue.shift()); next(); }, { timeout: 5000 });
  };
  const unsubscribe = store.subscribe((merged) => {
    if (timer || !(merged?.computers ?? []).some((c) => c.state === "online")) return;
    // Let the first screen and its own reads settle before starting.
    timer = setTimeout(next, settleMs);
    queueMicrotask(() => unsubscribe?.());
  });
  return () => { stopped = true; clearTimeout(timer); unsubscribe(); };
}
