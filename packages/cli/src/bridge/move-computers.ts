// Continuation destinations expose login labels and quota, never auth material.
import { z } from "zod";
import { dispatchProjectDirectory, PEER_COPILOT_REASON, projectName, type moveToSchema } from "./dispatch.js";
type MoveTo = z.infer<typeof moveToSchema>;
import { choosePolicyAccount, computerRule, poolRefusal, projectRule, withPolicy } from "./account-policy.js";
import { accountPolicy } from "./account-pools.js";
import { harnessInventoryWithin } from "./harnesses.js";
import { phrenStoreRoot } from "./transcripts.js";
import { peerHost, isLocalComputer, type DispatchHost } from "./dispatch-hosts.js";
import { hookPeers, optionalHookPeers } from "./peers.js";
import { BridgeError, type Json } from "./protocol.js";

const account = z.object({ id: z.string().max(64), label: z.string().max(200), usable: z.boolean(), signedIn: z.boolean(), email: z.string().optional(), plan: z.string().optional(), current: z.boolean().default(false),
  fiveHourResetsAt: z.string().optional(), weekResetsAt: z.string().optional(),
  fiveHourLeft: z.number().min(0).max(100).optional(), weekLeft: z.number().min(0).max(100).optional(), resetsAt: z.string().optional(),
  // Pools and roles (account-policy.ts): `poolRefused` says why the project's or this computer's pools rule the login out.
  pool: z.string().max(32).optional(), role: z.string().max(16).optional(), console: z.boolean().optional(), poolRefused: z.string().max(300).optional() });
const availability = z.object({ computerId: z.string().uuid().optional(), hasCheckout: z.boolean(), harnesses: z.array(z.object({
  source: z.enum(["claude", "codex", "opencode", "copilot"]), usable: z.boolean(), reason: z.string().optional(), accounts: z.array(account).optional(),
})),
  /** The Claude usage read had not answered in time: accounts carry no room yet. */
  usagePending: z.literal(true).optional(),
  /** The Claude usage read failed: accounts carry no room. */
  usageError: z.string().max(200).optional(),
});
export type MoveAvailability = z.infer<typeof availability>;

/** How long a computer's own Claude usage read may hold its continuation facts. */
export const MOVE_USAGE_TIMEOUT_MS = 5_000;

/** The usage read, or why there is none: a read past `ms` is left running (it still warms the cache). */
async function usageWithin(usage: () => Promise<Json>, ms: number): Promise<{ limits: Json; usagePending?: true; usageError?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">(resolve => { timer = setTimeout(() => resolve("late"), ms); timer.unref?.(); });
  try {
    const limits = await Promise.race([usage(), late]);
    return limits === "late" ? { limits: {}, usagePending: true } : { limits };
  } catch { return { limits: {}, usageError: "Claude usage could not be read on this computer." }; }
  finally { clearTimeout(timer); }
}

export async function localMoveAvailability(project: unknown, usage: () => Promise<Json>, conductor = false, usageTimeoutMs = MOVE_USAGE_TIMEOUT_MS): Promise<MoveAvailability> {
  const name = project === null || project === undefined || project === "" ? undefined : projectName.parse(project);
  const [checkout, found, read] = await Promise.all([
    conductor ? Promise.resolve(true) : name ? dispatchProjectDirectory(name).then(() => true, () => false) : Promise.resolve(false),
    harnessInventoryWithin(2_500),
    usageWithin(usage, usageTimeoutMs),
  ]);
  const { limits } = read;
  const { claudeMoveAccounts } = await import("./hand-off.js");
  const rooms = claudeMoveAccounts(limits);
  const { claudeHomes, claudeAccountRef, claudeAccountEmail, claudeAccountSubscription } = await import("./claude-accounts.js");
  const discovered = found?.harnesses ?? [];
  const claude = discovered.find(row => row.source === "claude");
  const accounts = [...claude?.accounts ?? []];
  for (const home of claudeHomes()) if (!accounts.some(login => login.id === home.id)) {
    const ref = claudeAccountRef(home), email = claudeAccountEmail(home), subscription = claudeAccountSubscription(home);
    accounts.push({ ...ref, usable: false, signedIn: false, ...(email ? { email } : {}), ...(subscription?.plan ? { plan: subscription.plan } : {}) });
  }
  // The project's pools (a conductor move has none of its own) and this computer's.
  const rules = [...(name && !conductor ? [projectRule(phrenStoreRoot(), name)] : []), computerRule("this computer", claude?.allowedPools, claude?.poolsUnreadable === true)];
  const refusal = (login: { id: string; pool?: string }) => poolRefusal({ account: login.id, pool: login.pool }, rules);
  const inventory = claude ? discovered.map(row => row.source === "claude" ? { ...row, accounts } : row) : [...discovered, { source: "claude" as const, installed: false, usable: false, accounts }];
  return availability.parse({ hasCheckout: checkout, ...(read.usagePending ? { usagePending: true } : {}), ...(read.usageError ? { usageError: read.usageError } : {}),
    harnesses: inventory.filter(row => row.source !== "phren").map(row => ({
    source: row.source, usable: row.usable, ...(row.accounts ? { accounts: row.accounts.map(login => {
      const room = row.source === "claude" ? rooms.find(item => item.id === login.id) : undefined;
      const listed = login as { pool?: string; role?: string; console?: boolean };
      const refused = row.source === "claude" ? refusal({ id: login.id, pool: listed.pool }) : undefined;
      return { ...room, id: login.id, label: login.label ?? login.id, usable: login.usable && room?.fiveHourLeft !== 0 && room?.weekLeft !== 0, signedIn: login.signedIn, ...(login.email ? { email: login.email } : {}), ...(login.plan ? { plan: login.plan } : {}),
        ...(listed.pool ? { pool: listed.pool } : {}), ...(listed.role ? { role: listed.role } : {}), ...(listed.console ? { console: true } : {}), ...(refused ? { poolRefused: refused } : {}) };
    }) } : {}),
  })) });
}

/** Exact verified names only; self also accepts the name health displays. */
export async function movePeer(computer: string | undefined, self?: string): Promise<DispatchHost | undefined> {
  if (computer === undefined || computer === self) return undefined;
  const peers = await hookPeers().catch(error => {
    if (error instanceof BridgeError && error.details?.hooksYaml === "missing") return [];
    throw error;
  });
  const peer = peers.find(row => row.name === computer);
  if (peer) return peerHost(peer);
  if (isLocalComputer(computer)) return undefined;
  throw new BridgeError(404, "Unknown computer. Add its verified connection to hooks.yaml.");
}

export async function peerMoveAvailability(peer: DispatchHost, project: string, conductor = false): Promise<MoveAvailability> {
  try { return availability.parse(await peer.request(`/v1/sessions/move/availability?project=${encodeURIComponent(project)}${conductor ? "&conductor=1" : ""}`, undefined, 10_000)); }
  catch { throw new BridgeError(409, `Computer ${peer.name} is offline or cannot report continuation availability.`); }
}

/** The login an unnamed Claude continuation takes there: most room, among those the pools allow and roles let
 * be chosen automatically (`last-resort` only when no other fits). Without pools or roles, the most room as before. */
function chosenLogin(accounts: z.infer<typeof account>[]) {
  const refused = accounts.filter(login => login.poolRefused).map(login => `${login.id}: ${login.poolRefused}`);
  const picked = choosePolicyAccount(accounts.filter(login => !login.poolRefused).map(login => withPolicy({ account: login.id, usable: login.usable,
    exhausted: login.fiveHourLeft === 0 || login.weekLeft === 0,
    fiveHour: { leftPercent: login.fiveHourLeft }, week: { leftPercent: login.weekLeft },
  }, login)));
  return { ...picked, skipped: [...refused, ...picked.skipped] };
}

/** The receiving computer's logins with the project's pools checked here too: a peer on an older Hook (no pools)
 * or with a store that has not synced the project's list can't let a login through that this side refuses. */
function checkedHere(accounts: z.infer<typeof account>[], project: string, conductor: boolean): z.infer<typeof account>[] {
  if (conductor) return accounts;
  const rule = projectRule(phrenStoreRoot(), project);
  return accounts.map(login => {
    const refused = login.poolRefused ?? poolRefusal({ account: login.id, pool: login.pool }, [rule]);
    return refused ? { ...login, poolRefused: refused } : login;
  });
}

export async function checkMovePeer(peer: DispatchHost, project: string, to: MoveTo, conductor = false): Promise<{ account?: string; accountChoice?: string; computerId?: string }> {
  if (to.harness === "copilot") throw new BridgeError(409, PEER_COPILOT_REASON);
  const facts = await peerMoveAvailability(peer, project, conductor);
  if (!facts.hasCheckout) throw new BridgeError(409, `Computer ${peer.name} has no checkout of ${project}.`);
  // Without its room an exhausted login looks usable: wait for the read, which goes on and fills the peer's cache.
  if (to.harness === "claude" && facts.usagePending) throw new BridgeError(409, `Claude usage on ${peer.name} is still being read; try again in a moment.`);
  const found = facts.harnesses.find(row => row.source === to.harness);
  const harness = found?.source === "claude" && found.accounts ? { ...found, accounts: checkedHere(found.accounts, project, conductor) } : found;
  const picked = to.harness === "claude" && !to.account && harness?.accounts ? chosenLogin(harness.accounts) : undefined;
  const choice = picked?.choice;
  // Pools rule a login out even when it is named; with pools or roles in play an unnamed move never falls back to default.
  const named = to.account ? harness?.accounts?.find(row => row.id === to.account) : undefined;
  if (named?.poolRefused) throw new BridgeError(409, `Claude account ${to.account} on ${peer.name} may not do this work: ${named.poolRefused}.`, { code: "account_pool" });
  if (picked && !choice && harness?.accounts?.some(login => login.poolRefused || login.role || login.console || login.pool)) {
    throw new BridgeError(409, `No Claude account on ${peer.name} may continue this${picked.skipped.length ? `: ${picked.skipped.join("; ")}` : ""}.`.slice(0, 500), { code: "account_pool" });
  }
  const login = harness?.accounts?.find(row => row.id === (to.account ?? choice?.account ?? "default"));
  if (!harness?.usable || (harness.accounts && !login?.usable) || login?.fiveHourLeft === 0 || login?.weekLeft === 0) {
    throw new BridgeError(409, `The harness or account is not usable on ${peer.name}.`);
  }
  if (!facts.computerId) throw new BridgeError(409, `Update ${peer.name}'s Hook to verify its continuation identity.`);
  return { ...(facts.computerId ? { computerId: facts.computerId } : {}), ...(choice ? { account: choice.account, accountChoice: choice.reason } : {}) };
}

export async function moveComputers(project: unknown, self: string, local: () => Promise<MoveAvailability>, currentAccount?: string, conductor = false): Promise<Json> {
  const name = project === null || project === undefined || project === "" ? "" : projectName.parse(project);
  // This computer's facts are read beside its peers', not before them: one slow read never holds the rest.
  const localFacts = local();
  localFacts.catch(() => undefined); // Still thrown below; not unhandled while the peers are listed.
  const { peers } = await optionalHookPeers();
  const publicFacts = (facts: MoveAvailability, remote = false) => ({ ...(facts.computerId ? { computerId: facts.computerId } : {}), hasCheckout: facts.hasCheckout,
    ...(facts.usagePending ? { usagePending: true } : {}), ...(facts.usageError ? { usageError: facts.usageError } : {}),
    harnesses: facts.harnesses.map(listed => {
    // A peer's logins as checkMovePeer judges them, so the phone's pick is the one the move makes.
    const row = remote && name && listed.source === "claude" && listed.accounts ? { ...listed, accounts: checkedHere(listed.accounts, name, conductor) } : listed;
    return {
    source: row.source, usable: remote && row.source === "copilot" ? false : row.usable,
    ...(remote && row.source === "copilot" ? { reason: PEER_COPILOT_REASON } : {}),
    ...(row.source === "claude" && row.accounts ? { selectedAccount: chosenLogin(row.accounts).choice?.account } : {}), ...(row.accounts ? { accounts: row.accounts.map(({ signedIn: _signedIn, ...login }) => ({ ...login, current: !remote && row.source === "claude" && login.id === currentAccount })) } : {}),
  }; }) });
  const [here, computers] = await Promise.all([localFacts, Promise.all(peers.map(async peer => {
    try { return { name: peer.name, self: false, online: true, ...publicFacts(await peerMoveAvailability(peerHost(peer), name, conductor), true) }; }
    catch { return { name: peer.name, self: false, online: false, hasCheckout: false, harnesses: [] }; }
  }))]);
  return { computers: [{ name: self, self: true, online: true, ...publicFacts(here) }, ...computers],
    localClaudeLogins: here.harnesses.find(row => row.source === "claude")?.accounts?.filter(login => login.signedIn).length ?? 0 };
}

/**
 * Why this computer's Claude account `account` may not take a session in `cwd` (a same-computer move or
 * account switch), or undefined: the pools of the project whose checkout holds `cwd` and this computer's own.
 * Roles don't apply: the account is named by hand.
 */
export async function localPoolRefusal(cwd: string, account: string): Promise<string | undefined> {
  const { getProjectDirs } = await import("../phren-paths.js");
  const { realpath } = await import("node:fs/promises");
  const path = await import("node:path");
  const source = await realpath(cwd).catch(() => cwd);
  let project: string | undefined, longest = 0;
  for (const directoryName of getProjectDirs(phrenStoreRoot())) {
    const name = path.basename(directoryName);
    const directory = await dispatchProjectDirectory(name).catch(() => undefined);
    if (directory && directory.length > longest && (source === directory || source.startsWith(directory + path.sep))) { project = name; longest = directory.length; }
  }
  // An accounts.yaml that can't be read allows no pool here, as a dispatch to this computer would find.
  let policy: ReturnType<typeof accountPolicy> | undefined;
  try { policy = accountPolicy(); } catch { /* Refused below. */ }
  const rules = [...(project ? [projectRule(phrenStoreRoot(), project)] : []), computerRule("this computer", policy?.allowedPools, !policy)];
  return poolRefusal({ account, pool: policy?.settings[account]?.pool }, rules);
}

/** Re-read enrollment before every request that may transmit a brief. */
export async function currentMovePeer(captured: DispatchHost): Promise<DispatchHost> {
  const current = await movePeer(captured.name).catch(() => undefined);
  if (!current || !current.fingerprint || current.fingerprint !== captured.fingerprint) throw new BridgeError(409, "The destination enrollment was revoked or changed; no brief was sent.");
  return { ...current, request: async (route, data, timeout) => {
    const enrolled = await movePeer(captured.name).catch(() => undefined);
    if (!enrolled || enrolled.fingerprint !== captured.fingerprint) throw new BridgeError(409, "The destination enrollment was revoked or changed; no brief was sent.");
    return enrolled.request(route, data, timeout);
  } };
}
