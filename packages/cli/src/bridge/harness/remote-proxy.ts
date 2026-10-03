import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicInPrivateDir, bridgeRoot, BridgeError, type Json } from "../protocol.js";
import { lockedState, readPrivateState } from "./private-state.js";
import { privateRunnerDirectory, requestRunnerSocket, runnerEntrySchema } from "./runner-client.js";

const proxyId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const registration = z.object({ id: proxyId, originComputer: z.literal("QL"), label: z.string().min(1).max(100), entry: runnerEntrySchema, token: z.string().regex(/^[a-f0-9]{64}$/), expectedOwnerId: z.string().uuid().optional() }).strict();
type Registration = z.infer<typeof registration>;
const file = () => path.join(bridgeRoot(), "harness", "proxies.json");
const directory = () => path.join(bridgeRoot(), "harness", "proxies");
const socket = (id: string) => path.join(directory(), id + ".sock");
async function rows(): Promise<Registration[]> { const raw = await readPrivateState(file()); return raw ? z.array(registration).max(1).parse(JSON.parse(raw)) : []; }
async function remote(row: Registration, operation: string, input: unknown = {}) {
  await privateRunnerDirectory(directory());
  const info = await lstat(socket(row.id));
  if (!info.isSocket() || info.isSymbolicLink() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw new BridgeError(409, "The remote agent's forwarded socket is not private.");
  return requestRunnerSocket(row.entry, operation, input, socket(row.id), row.token);
}
async function verified(row: Registration) {
  const current = runnerEntrySchema.parse(await remote(row, "info"));
  if (current.ownerId !== row.entry.ownerId || current.session !== row.entry.session || current.nativeSession !== row.entry.nativeSession || current.pid !== row.entry.pid || current.provider !== row.entry.provider) throw new BridgeError(409, "The registered remote agent changed; explicit owner registration is required.");
  return current;
}
const target = (row: Registration) => ({ proxyId: row.id, session: row.entry.session, ownerId: row.entry.ownerId });

/** One agent listing, separate from computers and local pane targets. Never scans or enrolls QL. */
export async function proxyView(viaComputer: string) {
  return { version: 1, scope: "one-agent", proxies: await Promise.all((await rows()).map(async row => {
    const base = { id: row.id, label: row.label, originComputer: row.originComputer, viaComputer, scope: "one-agent", provider: row.entry.provider };
    try { const entry = await verified(row); const chatSupported = entry.capabilities.readThread && entry.capabilities.events;
      return { ...base, state: chatSupported ? "connected" : "terminal-only", chatSupported, ...(chatSupported ? { target: target(row), nativeSession: entry.nativeSession, capabilities: entry.capabilities } : {}) };
    } catch { return { ...base, state: "offline", chatSupported: false }; }
  })) };
}
export async function registerProxy(input: unknown) {
  const row = registration.parse(input);
  if (row.entry.capabilities.startSession || row.entry.capabilities.takeover) throw new BridgeError(400, "A proxy exposes one existing agent; creation and terminal takeover are unavailable.");
  await mkdir(directory(), { recursive: true, mode: 0o700 }); await privateRunnerDirectory(directory());
  // The owner may register before establishing the tunnel; no launch or SSH command runs here.
  return lockedState(file(), async () => {
    const prior = (await rows())[0];
    if (prior && (prior.id !== row.id || row.expectedOwnerId !== prior.entry.ownerId)) throw new BridgeError(409, "Confirm the registered ownerId before replacing this one-agent proxy.");
    await atomicInPrivateDir(file(), [row]);
    return { ok: true, scope: "one-agent", target: target(row), tunnelStarted: false, enrolled: false };
  });
}
export async function proxyOperation(operation: string, input: Json) {
  const requested = z.object({ proxyId, session: z.string().optional(), ownerId: z.string().uuid().optional() }).parse(input.target ?? input);
  const row = (await rows()).find(row => row.id === requested.proxyId);
  if (!row) throw new BridgeError(404, "This one-agent proxy is not registered.");
  const entry = await verified(row);
  if (operation === "session") return { version: 1, provider: entry.provider, target: target(row), nativeSession: entry.nativeSession, capabilities: entry.capabilities, scope: "one-agent" };
  if (requested.session !== entry.session || requested.ownerId !== entry.ownerId) throw new BridgeError(409, "The remote agent target changed.");
  const capability: Record<string, keyof typeof entry.capabilities> = { thread: "readThread", events: "events", interrupt: "interrupt", approval: "approvals", input: "userInput", model: "setModel" };
  if (!["thread", "events", "requests", "delivery", "turn", "interrupt", "approval", "input", "model"].includes(operation)) throw new BridgeError(404, "That remote agent operation is unavailable.");
  if (capability[operation] && !entry.capabilities[capability[operation]]) throw new BridgeError(409, "This remote agent does not support that structured control.");
  const payload: Json = {};
  if (operation === "turn") { payload.text = z.string().min(1).max(32768).parse(input.text); payload.deliveryId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).parse(input.deliveryId); }
  if (operation === "delivery") payload.deliveryId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).parse(input.deliveryId);
  if (operation === "events") payload.after = z.coerce.number().int().nonnegative().parse(input.after ?? 0);
  if (operation === "interrupt") payload.turnId = z.string().min(1).max(200).parse(input.turnId);
  if (operation === "approval" || operation === "input") { payload.requestId = z.string().min(1).max(200).parse(input.requestId); payload.response = input.response; }
  if (operation === "model") payload.model = z.string().min(1).max(200).parse(input.model);
  return remote(row, operation, payload);
}

/** Source plan only. QL initiates the SSH connection; Omarchy forwards one private agent socket. */
export function reverseProxyPlan(input: unknown) {
  const data = z.object({ id: proxyId, omarchySSHHost: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/), omarchySocket: z.string().min(1).max(100).refine(value => path.posix.isAbsolute(value) && !/[\x00-\x20\x7f:]/.test(value)), remotePort: z.number().int().min(1024).max(65535), ownerConfirmed: z.literal(true) }).strict().parse(input);
  if (!data.omarchySocket.endsWith("/harness/proxies/" + data.id + ".sock")) throw new BridgeError(400, "Choose this proxy's private Omarchy socket path.");
  return { performed: false, scope: "one-agent", direction: "QL-to-Omarchy", enrollmentRequired: false, requiresExistingOwnerSSHAccessAndVerifiedOmarchyPin: true,
    file: "ssh", args: ["-N", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-R", `${data.omarchySocket}:127.0.0.1:${data.remotePort}`, "--", data.omarchySSHHost] };
}
