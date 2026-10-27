// Continuation destinations expose login labels and quota, never auth material.
import { z } from "zod";
import { dispatchProjectDirectory, PEER_COPILOT_REASON, projectName, type moveToSchema } from "./dispatch.js";
type MoveTo = z.infer<typeof moveToSchema>;
import { chooseAccount } from "./account-choice.js";
import { harnessInventoryWithin } from "./harnesses.js";
import { peerHost, isLocalComputer, type DispatchHost } from "./dispatch-hosts.js";
import { hookPeers, optionalHookPeers } from "./peers.js";
import { BridgeError, type Json } from "./protocol.js";

const account = z.object({ id: z.string().max(64), label: z.string().max(200), usable: z.boolean(), signedIn: z.boolean(), email: z.string().optional(), plan: z.string().optional(), current: z.boolean().default(false),
  fiveHourResetsAt: z.string().optional(), weekResetsAt: z.string().optional(),
  fiveHourLeft: z.number().min(0).max(100).optional(), weekLeft: z.number().min(0).max(100).optional(), resetsAt: z.string().optional() });
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
  const inventory = claude ? discovered.map(row => row.source === "claude" ? { ...row, accounts } : row) : [...discovered, { source: "claude" as const, installed: false, usable: false, accounts }];
  return availability.parse({ hasCheckout: checkout, ...(read.usagePending ? { usagePending: true } : {}), ...(read.usageError ? { usageError: read.usageError } : {}),
    harnesses: inventory.filter(row => row.source !== "phren").map(row => ({
    source: row.source, usable: row.usable, ...(row.accounts ? { accounts: row.accounts.map(login => {
      const room = row.source === "claude" ? rooms.find(item => item.id === login.id) : undefined;
      return { ...room, id: login.id, label: login.label ?? login.id, usable: login.usable && room?.fiveHourLeft !== 0 && room?.weekLeft !== 0, signedIn: login.signedIn, ...(login.email ? { email: login.email } : {}), ...(login.plan ? { plan: login.plan } : {}) };
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

function chosenLogin(accounts: z.infer<typeof account>[]) {
  return chooseAccount(accounts.map(login => ({ account: login.id, usable: login.usable,
    exhausted: login.fiveHourLeft === 0 || login.weekLeft === 0,
    fiveHour: { leftPercent: login.fiveHourLeft }, week: { leftPercent: login.weekLeft },
  }))).choice;
}

export async function checkMovePeer(peer: DispatchHost, project: string, to: MoveTo, conductor = false): Promise<{ account?: string; accountChoice?: string; computerId?: string }> {
  if (to.harness === "copilot") throw new BridgeError(409, PEER_COPILOT_REASON);
  const facts = await peerMoveAvailability(peer, project, conductor);
  if (!facts.hasCheckout) throw new BridgeError(409, `Computer ${peer.name} has no checkout of ${project}.`);
  // Without its room an exhausted login looks usable: wait for the read, which goes on and fills the peer's cache.
  if (to.harness === "claude" && facts.usagePending) throw new BridgeError(409, `Claude usage on ${peer.name} is still being read; try again in a moment.`);
  const harness = facts.harnesses.find(row => row.source === to.harness);
  const choice = to.harness === "claude" && !to.account && harness?.accounts ? chosenLogin(harness.accounts) : undefined;
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
    harnesses: facts.harnesses.map(row => ({
    source: row.source, usable: remote && row.source === "copilot" ? false : row.usable,
    ...(remote && row.source === "copilot" ? { reason: PEER_COPILOT_REASON } : {}),
    ...(row.source === "claude" && row.accounts ? { selectedAccount: chosenLogin(row.accounts)?.account } : {}), ...(row.accounts ? { accounts: row.accounts.map(({ signedIn: _signedIn, ...login }) => ({ ...login, current: !remote && row.source === "claude" && login.id === currentAccount })) } : {}),
  })) });
  const [here, computers] = await Promise.all([localFacts, Promise.all(peers.map(async peer => {
    try { return { name: peer.name, self: false, online: true, ...publicFacts(await peerMoveAvailability(peerHost(peer), name, conductor), true) }; }
    catch { return { name: peer.name, self: false, online: false, hasCheckout: false, harnesses: [] }; }
  }))]);
  return { computers: [{ name: self, self: true, online: true, ...publicFacts(here) }, ...computers],
    localClaudeLogins: here.harnesses.find(row => row.source === "claude")?.accounts?.filter(login => login.signedIn).length ?? 0 };
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
