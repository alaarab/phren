// Account pools and roles applied to an automatic account choice (dispatch placement, Continue in…, the
// accounts a stopped worker may continue on). See docs/accounts.md.
//
// - A pool rule (a project's or a computer's `allowedPools`) refuses an account outside it, chosen or named.
// - `off` is never chosen automatically, and neither is a Console (API-billed) login with no role: API accounts
//   are off for automatic use until the owner gives them a role. Both can still be named by hand.
// - `last-resort` accounts are offered only when no other account (ordinary or `helpers`) fits.
// With no pools, no roles and no Console logins nothing here changes a choice.
import { chooseAccount, type AccountChoice, type AccountRoom } from "./account-choice.js";
import { isAccountRole, isPoolTag, poolAllowed, projectAllowedPools, type AccountRole } from "./account-pools.js";

/** An account room with what the harness listing says about its pool, role and login. */
export interface PolicyRoom extends AccountRoom { pool?: string; role?: AccountRole; console?: boolean }
/** Whose `allowedPools` a choice must keep to: "project client-a", "computer Desk". No `pools`: any pool. */
export interface PoolRule { owner: string; pools?: readonly string[] }

/** A project's rule, from its `phren.project.yaml` in the store. */
export const projectRule = (phrenPath: string, project: string): PoolRule => ({ owner: `project ${project}`, pools: projectAllowedPools(phrenPath, project) });

/** A computer's rule from what its harness listing reports (its Claude entry's `allowedPools`). */
export function computerRule(computer: string, pools: unknown): PoolRule {
  return { owner: `computer ${computer}`, ...(Array.isArray(pools) ? { pools: pools.filter(isPoolTag) } : {}) };
}

/** The pool, role and Console flag a listed account carries, checked, onto its room. */
export function withPolicy<T extends AccountRoom>(room: T, listed: { pool?: unknown; role?: unknown; console?: unknown } | undefined): T & PolicyRoom {
  return { ...room, ...(isPoolTag(listed?.pool) ? { pool: listed.pool } : {}), ...(isAccountRole(listed?.role) ? { role: listed.role } : {}),
    ...(listed?.console === true ? { console: true } : {}) };
}

/** Why `room` may not do this work under `rules` at all, or undefined. Applies to a named account too. */
export function poolRefusal(room: Pick<PolicyRoom, "account" | "pool">, rules: readonly PoolRule[]): string | undefined {
  const rule = rules.find(item => !poolAllowed(item.pools, room.pool));
  if (!rule) return undefined;
  return `${room.pool ? `its pool ${room.pool}` : "it has no pool, and"} is not in ${rule.owner}'s allowed pools (${rule.pools!.join(", ")})`;
}

/** Why `room` is never chosen automatically, or undefined. */
export function notAutomatic(room: Pick<PolicyRoom, "role" | "console">): string | undefined {
  if (room.role === "off") return "role off (chosen only by hand)";
  if (!room.role && room.console) return "an API account with no role (chosen only by hand)";
  return undefined;
}

/** Whether any pool, role or Console login could change a choice among `rooms` under `rules`. */
export function policyApplies(rooms: readonly PolicyRoom[], rules: readonly PoolRule[]): boolean {
  return rules.some(rule => rule.pools) || rooms.some(room => room.role || room.pool || room.console);
}

/**
 * The rooms an automatic choice may pick from, for a caller that ranks them itself (a stopped worker's
 * continuation, account-failover.ts): no refused or non-automatic account, and `last-resort` ones only when no
 * other account is signed in with quota left.
 */
export function automaticRooms<T extends PolicyRoom>(rooms: readonly T[], rules: readonly PoolRule[]): T[] {
  const allowed = rooms.filter(room => !poolRefusal(room, rules) && !notAutomatic(room));
  const open = (room: T) => room.usable !== false && !room.exhausted;
  return allowed.some(room => room.role !== "last-resort" && open(room)) ? allowed.filter(room => room.role !== "last-resort") : allowed;
}

/**
 * `chooseAccount` with pools and roles: rooms a rule refuses or that are not automatic are skipped, with why;
 * the rest are ranked by headroom as before, `last-resort` ones only when no other account has room.
 */
export function choosePolicyAccount(rooms: readonly PolicyRoom[], rules: readonly PoolRule[] = [],
  blocked: (room: AccountRoom) => string | undefined = () => undefined): { choice?: AccountChoice; skipped: string[] } {
  const skipped: string[] = [];
  const allowed = rooms.filter(room => {
    const why = poolRefusal(room, rules) ?? notAutomatic(room);
    if (why) skipped.push(`${room.account}: ${why}`);
    return !why;
  });
  const ruledOut = skipped.length ? `; ruled out ${skipped.join(", ")}` : "";
  const first = chooseAccount(allowed.filter(room => room.role !== "last-resort"), blocked);
  if (first.choice) return { choice: { account: first.choice.account, reason: `${first.choice.reason}${ruledOut}`.slice(0, 400) }, skipped: [...skipped, ...first.skipped] };
  const last = chooseAccount(allowed.filter(room => room.role === "last-resort"), blocked);
  const all = [...skipped, ...first.skipped, ...last.skipped];
  if (!last.choice) return { skipped: all };
  const without = first.skipped.length ? ` (${first.skipped.join(", ")})` : "";
  return { choice: { account: last.choice.account, reason: `last resort, no other account has room${without}; ${last.choice.reason}${ruledOut}`.slice(0, 400) }, skipped: all };
}
