import { sessions } from "./store.js";
import { quotaPreferences, sessionUsage } from "./quota-warn.js";
import { compareUsage, exhausted, limitingWindow, resetLabel, usedPercent, windowNames } from "./usage-windows.js";

/** Home is a live inventory, independent of dismissed or disabled notifications. */
export function runningLow(overview, usage, preferences = {}, now = Date.now()) {
  const { threshold } = quotaPreferences(preferences);
  return sessions(overview).flatMap((session) => {
    const account = sessionUsage(session, usage?.accounts ?? []);
    // Explicit exhaustion wins even when another window reports 100% with exhausted: false.
    const window = limitingWindow({ windows: [...(account?.windows ?? [])].sort(compareUsage) }, now);
    if (!window || (!exhausted(window) && usedPercent(window) < threshold)) return [];
    const value = exhausted(window) ? "Exhausted" : `${Math.round(usedPercent(window))}% of ${windowNames[window.id] || window.name || "limit"}`;
    return [{ ...session, account, window, text: `${value} · ${resetLabel(window, now)}` }];
  }).sort((a, b) => compareUsage(a.window, b.window));
}
