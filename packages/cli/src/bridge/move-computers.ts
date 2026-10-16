// Continuation destinations expose login labels and quota, never auth material.
import { z } from "zod";
import { dispatchProjectDirectory, PEER_COPILOT_REASON, projectName, type moveToSchema } from "./dispatch.js";
type MoveTo = z.infer<typeof moveToSchema>;
import { chooseAccount } from "./account-choice.js";
import { harnessInventoryWithin } from "./harnesses.js";
import { peerHost, isLocalComputer, type DispatchHost } from "./dispatch-hosts.js";
import { hookPeers, optionalHookPeers } from "./peers.js";
import { BridgeError, type Json } from "./protocol.js";

const account = z.object({ id: z.string().max(64), label: z.string().max(200), usable: z.boolean(), signedIn: z.boolean(),
  fiveHourLeft: z.number().min(0).max(100).optional(), weekLeft: z.number().min(0).max(100).optional(), resetsAt: z.string().optional() });
const availability = z.object({ hasCheckout: z.boolean(), harnesses: z.array(z.object({
  source: z.enum(["claude", "codex", "opencode", "copilot"]), usable: z.boolean(), reason: z.string().optional(), accounts: z.array(account).optional(),
})) });
export type MoveAvailability = z.infer<typeof availability>;

export async function localMoveAvailability(project: unknown, usage: () => Promise<Json>): Promise<MoveAvailability> {
  const name = projectName.parse(project);
  const [checkout, found, limits] = await Promise.all([
    dispatchProjectDirectory(name).then(() => true, () => false),
    harnessInventoryWithin(2_500),
    usage().catch(() => ({})),
  ]);
  const { claudeMoveAccounts } = await import("./hand-off.js");
  const rooms = claudeMoveAccounts(limits);
  return availability.parse({ hasCheckout: checkout, harnesses: found?.harnesses.filter(row => row.source !== "phren").map(row => ({
    source: row.source, usable: row.usable, ...(row.accounts ? { accounts: row.accounts.map(login => {
      const room = row.source === "claude" ? rooms.find(item => item.id === login.id) : undefined;
      return { ...room, id: login.id, label: login.label ?? login.id, usable: login.usable, signedIn: login.signedIn };
    }) } : {}),
  })) ?? [] });
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

export async function peerMoveAvailability(peer: DispatchHost, project: string): Promise<MoveAvailability> {
  try { return availability.parse(await peer.request(`/v1/sessions/move/availability?project=${encodeURIComponent(project)}`, undefined, 10_000)); }
  catch { throw new BridgeError(409, `Computer ${peer.name} is offline or cannot report continuation availability.`); }
}

function chosenLogin(accounts: z.infer<typeof account>[]) {
  return chooseAccount(accounts.map(login => ({ account: login.id, usable: login.usable,
    exhausted: login.fiveHourLeft === 0 || login.weekLeft === 0,
    fiveHour: { leftPercent: login.fiveHourLeft }, week: { leftPercent: login.weekLeft },
  }))).choice;
}

export async function checkMovePeer(peer: DispatchHost, project: string, to: MoveTo): Promise<{ account?: string; accountChoice?: string }> {
  if (to.harness === "copilot") throw new BridgeError(409, PEER_COPILOT_REASON);
  const facts = await peerMoveAvailability(peer, project);
  if (!facts.hasCheckout) throw new BridgeError(409, `Computer ${peer.name} has no checkout of ${project}.`);
  const harness = facts.harnesses.find(row => row.source === to.harness);
  const choice = to.harness === "claude" && !to.account && harness?.accounts ? chosenLogin(harness.accounts) : undefined;
  const login = harness?.accounts?.find(row => row.id === (to.account ?? choice?.account ?? "default"));
  if (!harness?.usable || (harness.accounts && !login?.usable) || login?.fiveHourLeft === 0 || login?.weekLeft === 0) {
    throw new BridgeError(409, `The harness or account is not usable on ${peer.name}.`);
  }
  return choice ? { account: choice.account, accountChoice: choice.reason } : {};
}

export async function moveComputers(project: unknown, self: string, local: () => Promise<MoveAvailability>): Promise<Json> {
  projectName.parse(project);
  const { peers } = await optionalHookPeers();
  const here = await local();
  const publicFacts = (facts: MoveAvailability, remote = false) => ({ hasCheckout: facts.hasCheckout, harnesses: facts.harnesses.map(row => ({
    source: row.source, usable: remote && row.source === "copilot" ? false : row.usable,
    ...(remote && row.source === "copilot" ? { reason: PEER_COPILOT_REASON } : {}),
    ...(row.source === "claude" && row.accounts ? { selectedAccount: chosenLogin(row.accounts)?.account } : {}), ...(row.accounts ? { accounts: row.accounts.filter(login => login.usable).map(({ usable: _usable, signedIn: _signedIn, ...login }) => login) } : {}),
  })) });
  const computers = await Promise.all(peers.map(async peer => {
    try { return { name: peer.name, self: false, online: true, ...publicFacts(await peerMoveAvailability(peerHost(peer), String(project)), true) }; }
    catch { return { name: peer.name, self: false, online: false, hasCheckout: false, harnesses: [] }; }
  }));
  return { computers: [{ name: self, self: true, online: true, ...publicFacts(here) }, ...computers],
    localClaudeLogins: here.harnesses.find(row => row.source === "claude")?.accounts?.filter(login => login.signedIn).length ?? 0 };
}
