import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { startingPane } from "../herdr.js";
import { atomicInPrivateDir, bridgeRoot, BridgeError, object, startingTargetSchema, type Json } from "../protocol.js";
import { terminalProvider } from "../terminal.js";
import { noCapabilities } from "./contract.js";
import { lockedState, readPrivateState } from "./private-state.js";

const proxyId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
// A startingToken proves only the current local terminal/process binding. It
// cannot identify the remote Copilot conversation or authenticate QL itself.
const terminalTarget = startingTargetSchema.extend({ source: z.literal("copilot") }).strict();
const attachment = z.object({
  id: proxyId, originComputer: z.literal("QL"), viaPlatform: z.literal("omarchy"),
  provider: z.literal("copilot"), transport: z.literal("existing-reverse-ssh-terminal"),
  label: z.string().min(1).max(100), terminalTarget, terminal: z.string().min(1).max(200),
}).strict();
const registration = attachment.extend({ ownerConfirmed: z.literal(true), expectedOwnerId: z.string().uuid().optional() }).strict();
const stored = attachment.extend({ version: z.literal(2), ownerId: z.string().uuid() }).strict();
type Registration = z.infer<typeof stored>;
const reference = z.object({ proxyId, ownerId: z.string().uuid().optional() }).strict();
// Separate versioned state: the former SDK/ACP/Codex runner registry is never
// converted into a Copilot session, or migrated without an owner action.
const file = () => path.join(bridgeRoot(), "harness", "copilot-proxy-v2.json");
async function rows(): Promise<Registration[]> {
  const raw = await readPrivateState(file());
  return raw ? z.array(stored).max(1).parse(JSON.parse(raw)) : [];
}
async function boundPane(row: Registration) {
  const pane = await startingPane(row.terminalTarget);
  if (pane.agent !== "copilot" || !["string", "number"].includes(typeof pane.terminal_id) || String(pane.terminal_id) !== row.terminal) {
    throw new BridgeError(409, "The attached Copilot terminal changed; owner registration is required.", { code: "proxy-binding-changed" });
  }
  return pane;
}
const unsupported = {
  turn: "No remote Copilot turn transport or acknowledgement is available.",
  thread: "The terminal has no verified remote Copilot transcript identity.",
  events: "The terminal has no structured remote Copilot event stream.",
  delivery: "Terminal input cannot establish a remote Copilot delivery receipt.",
  interrupt: "A remote Copilot turn cannot be identified for interruption.",
  approval: "Remote Copilot permission requests are not bridged.",
  input: "Remote Copilot structured questions are not bridged.",
  model: "Remote Copilot model selection is not bridged.",
  takeover: "This attachment cannot take over or resume a remote native session.",
  start: "This attachment exposes only the existing terminal; it cannot create agents.",
  keys: "Proxy terminal writes are unavailable; local typing is not remote chat acceptance.",
  prompt: "Proxy prompts are unavailable; local typing is not remote chat acceptance.",
} as const;

function description(row: Registration, state: "terminal-only" | "binding-changed" | "unavailable", viaComputer?: string) {
  return {
    version: 2, id: row.id, label: row.label, originComputer: row.originComputer,
    viaPlatform: row.viaPlatform, ...(viaComputer ? { viaComputer } : {}),
    provider: row.provider, transport: row.transport, scope: "one-agent", ownerId: row.ownerId,
    state, session: null, nativeSession: null, target: null, chatTarget: null, chatSupported: false,
    identity: { localPaneVerified: state === "terminal-only", remoteSessionVerified: false, remoteTransportVerified: false, origin: "owner-declared" },
    capabilities: { ...noCapabilities, sendTurn: false, deliveryReceipts: false },
    terminalCapabilities: { readScreen: state === "terminal-only", keys: false, prompt: false },
    terminalTarget: state === "terminal-only" ? row.terminalTarget : null,
    terminal: state === "terminal-only" ? row.terminal : null,
    unsupported,
  };
}
async function view(row: Registration, viaComputer?: string) {
  try { await boundPane(row); return description(row, "terminal-only", viaComputer); }
  catch (error) { return description(row, error instanceof BridgeError && error.status === 409 ? "binding-changed" : "unavailable", viaComputer); }
}

/** One owner-declared QL Copilot terminal, separate from computer enrollment. */
export async function proxyView(viaComputer: string) {
  return { version: 2, scope: "one-agent", proxies: await Promise.all((await rows()).map(row => view(row, viaComputer))) };
}
export async function registerProxy(input: unknown) {
  const { ownerConfirmed: _confirmed, expectedOwnerId, ...data } = registration.parse(input);
  return lockedState(file(), async () => {
    const prior = (await rows())[0];
    if (prior && (prior.id !== data.id || expectedOwnerId !== prior.ownerId)) {
      throw new BridgeError(409, "Confirm the existing attachment ownerId before replacing it.", { code: "proxy-owner-changed" });
    }
    if (!prior && expectedOwnerId) throw new BridgeError(409, "The attachment to replace no longer exists.", { code: "proxy-owner-changed" });
    const row = stored.parse({ ...data, version: 2, ownerId: randomUUID() });
    await boundPane(row); // Never persists an invented or already stale pane identity.
    await atomicInPrivateDir(file(), [row]);
    return { ok: true, attachment: description(row, "terminal-only"), tunnelStarted: false, enrolled: false, sessionCreated: false };
  });
}
export async function removeProxy(input: unknown) {
  const requested = z.object({ proxyId, ownerId: z.string().uuid(), ownerConfirmed: z.literal(true) }).strict().parse(input);
  return lockedState(file(), async () => {
    const prior = (await rows())[0];
    if (!prior || prior.id !== requested.proxyId || prior.ownerId !== requested.ownerId) throw new BridgeError(409, "The attachment owner changed.", { code: "proxy-owner-changed" });
    await atomicInPrivateDir(file(), []);
    return { ok: true, removed: true, tunnelStopped: false, terminalClosed: false, enrolled: false };
  });
}
export async function proxyOperation(operation: string, input: Json) {
  const rawTarget = input.target === undefined ? input : object(input.target);
  if ("session" in rawTarget || "nativeSession" in rawTarget || "startingToken" in rawTarget || "session" in input || "nativeSession" in input) {
    throw new BridgeError(409, "This Copilot attachment has no native session; startingToken is only a terminal guard.", { code: "proxy-no-native-session", provider: "copilot", session: null });
  }
  const requested = reference.parse(input.target === undefined ? { proxyId: input.proxyId, ownerId: input.ownerId } : input.target);
  const row = (await rows()).find(row => row.id === requested.proxyId);
  if (!row) throw new BridgeError(404, "This one-agent Copilot attachment is not registered.", { code: "proxy-not-registered" });
  if (requested.ownerId !== undefined && requested.ownerId !== row.ownerId) throw new BridgeError(409, "The attachment owner changed.", { code: "proxy-owner-changed" });
  if (Object.prototype.hasOwnProperty.call(unsupported, operation)) {
    throw new BridgeError(409, unsupported[operation as keyof typeof unsupported], { code: "proxy-capability-unsupported", provider: "copilot", operation, supported: false, session: null, chatSupported: false });
  }
  if (operation === "session") return view(row);
  if (operation !== "screen") throw new BridgeError(404, "That proxy operation is unavailable.");
  if (requested.ownerId !== row.ownerId) throw new BridgeError(409, "Screen reads require the current attachment ownerId.", { code: "proxy-owner-changed" });
  await boundPane(row);
  const rawScreen = await terminalProvider().readScreen(row.terminalTarget.server, row.terminalTarget.pane, { scope: "pane", source: "visible", lines: 100, stripAnsi: true, timeoutMs: 2_000 });
  await boundPane(row); // Discard a read spanning a terminal/process change.
  if ((await rows())[0]?.ownerId !== row.ownerId) throw new BridgeError(409, "The attachment owner changed during the screen read.", { code: "proxy-owner-changed" });
  const screen = rawScreen.split("\n").slice(-100).join("\n").slice(-65536);
  return { version: 2, proxyId: row.id, ownerId: row.ownerId, provider: "copilot", scope: "terminal-screen", session: null, transcript: false, truncated: screen !== rawScreen, screen };
}

/** Describes an already attached terminal. No runner listener or SSH command is invented. */
export function reverseProxyPlan(input: unknown) {
  const { ownerConfirmed: _confirmed, expectedOwnerId: _prior, ...data } = registration.parse(input);
  return { version: 2, performed: false, scope: "one-agent", provider: "copilot", transport: data.transport,
    direction: "QL-to-Omarchy", enrollmentRequired: false, session: null, chatSupported: false,
    attachment: data, commands: [],
    prerequisites: ["Owner establishes the single reverse-SSH Copilot terminal using existing access and independently verified host pins.", "Owner confirms the current Omarchy Copilot pane, terminal and fresh startingToken before registration.", "Remote conversation identity and structured chat remain unsupported."] };
}
