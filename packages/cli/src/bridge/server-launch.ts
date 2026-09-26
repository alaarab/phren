import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { homeDir } from "../home-paths.js";
import { agentNames, findPane, isConductorName, paneAgentName, paneChatState, paneIdentity, servers, snapshot } from "./herdr.js";
import { agentNotReady, terminalName, terminalProvider } from "./terminal.js";
import { createLaunchWorktree, launchWorktreeSchema, type LaunchWorktree } from "./launch-worktree.js";
import { groupConductor } from "./conductor-group.js";
import { optionalHookPeers } from "./peers.js";
import { atomic, BridgeError, bridgeRoot, id, type Json, objects, provider } from "./protocol.js";

/** Starting agents in Herdr from the phone: the launch route's harness
 * arguments, the conductor brief, and workspace, tab and pane actions. */

const launchKinds = ["codex", "claude", "copilot", "opencode"] as const;
const plainText = (max: number) => z.string().min(1).max(max).refine(t => !/[\x00-\x1f\x7f]/.test(t));
declare const CONDUCTOR_SKILL_SOURCE: string | undefined;

async function conductorBrief(): Promise<string> {
  let source: string | undefined;
  if (typeof CONDUCTOR_SKILL_SOURCE === "string") source = CONDUCTOR_SKILL_SOURCE;
  else {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const candidate of [
      path.join(here, "..", "starter", "global", "skills", "conductor", "SKILL.md"),
      path.join(here, "..", "..", "starter", "global", "skills", "conductor", "SKILL.md"),
    ]) {
      source = await readFile(candidate, "utf8").catch(() => undefined);
      if (source !== undefined) break;
    }
  }
  if (source === undefined) throw new BridgeError(503, "The shipped conductor brief is unavailable. Reinstall Phren Hook.");
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(source);
  const brief = (match?.[1] ?? source).trim();
  if (!brief) throw new BridgeError(503, "The shipped conductor brief is empty. Reinstall Phren Hook.");
  return brief;
}

const launchEfforts = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type LaunchEffort = (typeof launchEfforts)[number];

/** How each harness takes a reasoning effort at startup. */
function effortArgs(kind: (typeof launchKinds)[number], effort: LaunchEffort): string[] {
  if (kind === "claude") return ["--effort", effort];
  if (kind === "codex") return ["-c", `model_reasoning_effort=${effort}`];
  if (kind === "opencode") return ["--variant", effort];
  return [];
}

async function prepareConductor(kind: (typeof launchKinds)[number], effort: LaunchEffort, model?: string): Promise<string[]> {
  const brief = await conductorBrief();
  const briefDirectory = path.join(bridgeRoot(), "conductor");
  await mkdir(briefDirectory, { recursive: true, mode: 0o700 });
  const briefFile = path.join(briefDirectory, "brief.md");
  if (await readFile(briefFile, "utf8").catch(() => undefined) !== brief + "\n") await atomic(briefFile, brief + "\n");
  // A multi-line argument cannot be typed safely into every shell (Herdr
  // refuses it for zsh); Claude reads the brief from its file instead.
  if (kind === "claude") return [...(model ? ["--model", model] : []), "--append-system-prompt-file", briefFile, "--effort", effort];
  if (kind === "codex") return [...(model ? ["--model", model] : []), "-c", `model_reasoning_effort=${effort}`, "-c", `developer_instructions=${JSON.stringify(brief)}`];
  if (kind === "opencode") {
    const directory = path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir(), ".config"), "opencode", "agents");
    const file = path.join(directory, "conductor.md");
    const definition = `---\ndescription: Coordinate the owner's work across agent sessions.\nmode: primary\n---\n\n${brief}\n`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await readFile(file, "utf8").catch(() => undefined) !== definition) await atomic(file, definition, 0o644);
    return [...(model ? ["--model", model] : []), "--agent", "conductor", "--variant", effort];
  }
  throw new BridgeError(400, "The selected harness cannot run as a conductor.");
}

async function targetForPane(server: string, pane: Json): Promise<Json | undefined> {
  if (!provider.safeParse(pane.agent).success || !id.safeParse(pane.workspace_id).success || !id.safeParse(pane.tab_id).success || !id.safeParse(pane.pane_id).success) return undefined;
  const binding = { server, workspace: pane.workspace_id, tab: pane.tab_id, pane: pane.pane_id, source: pane.agent };
  const session = await paneIdentity(server, pane);
  if (session) return { ...binding, session };
  const chat = await paneChatState(server, pane).catch((): Json => ({}));
  return chat.starting === true ? { ...binding, starting: true, startingToken: chat.startingToken } : undefined;
}

/** The live conductor on this computer, on any Herdr server, as a target.
 * `known` reuses a snapshot the caller already took. */
export async function localConductor(known?: { server: string; snapshot: Json }): Promise<{ server: string; target?: Json } | undefined> {
  const names = [...new Set([...(known ? [known.server] : []), ...(await servers()).map(item => String(item.session))])];
  for (const name of names) {
    const value = known && name === known.server ? known.snapshot : await snapshot(name);
    const existing = objects(value.panes).find(pane => isConductorName(paneAgentName(value, pane))
      && provider.safeParse(pane.agent).success && !["completed", "exited", "failed", "stopped"].includes(String(pane.agent_status)));
    if (existing) return { server: name, target: await targetForPane(name, existing) };
  }
  return undefined;
}

/** The Herdr agent-name slug for a human label: "Conductor smoke 4" becomes "conductor-smoke-4". */
export function herdrAgentName(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 32).replace(/-+$/, "");
  return slug || "agent";
}

/**
 * "Open on a computer": a new Herdr workspace (or a tab in an existing one)
 * in the project's directory, with the chosen agent started in its pane.
 * Herdr's create calls do not return identifiers, so the new tab is found
 * by diffing snapshots; `agent.start` returns once Herdr has detected the
 * agent and it is ready for input, which can take most of `timeoutMs`.
 */
export async function launchSession(server: string, data: Json, options: { canary?: boolean } = {}): Promise<Json> {
  const role = z.enum(["agent", "conductor"]).default("agent").parse(data.role);
  const projectDirectory = z.string().min(1).max(4096).refine(t => path.isAbsolute(t) && !/[\x00-\x1f\x7f]/.test(t)).parse(data.cwd);
  const worktreeRequest = data.worktree === undefined || data.worktree === null ? undefined : launchWorktreeSchema.parse(data.worktree);
  if (worktreeRequest && role === "conductor") throw new BridgeError(400, "A conductor works across projects, so it cannot start in a worktree.");
  const label = plainText(200).parse(data.label);
  const kind = z.enum(launchKinds).parse(data.kind);
  const effort = z.enum(launchEfforts).default("medium").parse(data.effort);
  if (role === "conductor" && kind === "copilot") throw new BridgeError(400, "Copilot cannot run as a conductor.");
  // Herdr's agent name is a slug (lowercase, digits, - or _, 1 to 32 chars);
  // the label a person typed is not, so derive one from it.
  const baseName = herdrAgentName(data.name === undefined ? label : plainText(200).parse(data.name));
  // "Conductor" stays "conductor", never "conductor-conductor".
  // The canary's conductor is not the store's conductor: it keeps its own
  // name, so the phone never pins it and a real conductor is never refused.
  // A worker never takes a conductor's name, whatever its label says:
  // "Conductor voice fluency" would otherwise read as role=conductor.
  const wanted = options.canary ? "phren-canary" : role === "conductor" ? (isConductorName(baseName) ? baseName : herdrAgentName(`conductor-${baseName}`))
    : isConductorName(baseName) ? herdrAgentName(`worker-${baseName}`) : baseName;
  const model = typeof data.model === "string" && data.model.trim() ? plainText(200).parse(data.model.trim()) : undefined;
  const modelFlag: Partial<Record<(typeof launchKinds)[number], string>> = { codex: "--model", claude: "--model", opencode: "--model" };
  let workspace = data.workspaceId === undefined ? undefined : id.parse(data.workspaceId);
  // Herdr 0.9.1 refuses a start timeout of 3000 ms or less (invalid_agent_timeout).
  const timeout = Math.min(120_000, Math.max(3_001, data.timeoutMs === undefined ? 45_000 : z.number().int().parse(data.timeoutMs)));
  const before = await snapshot(server);
  // Herdr agent names are unique per server; a scheduled run or a second
  // launch with the same label would otherwise collide with the first.
  const taken = agentNames(before);
  let name = wanted;
  for (let n = 2; taken.has(name) && n < 100; n++) name = `${wanted.slice(0, 32 - String(n).length - 1)}-${n}`;
  // One conductor per connected group: this computer and every linked peer.
  let unchecked: { computer: string; error: string }[] = [];
  if (role === "conductor" && !options.canary) {
    const existing = await localConductor({ server, snapshot: before });
    if (existing) throw new BridgeError(409, "A conductor is already running on this computer.", { target: existing.target });
    const group = await groupConductor((await optionalHookPeers()).peers);
    if (group.found) throw new BridgeError(409, `A conductor is already running on ${group.found.computer}, which is linked with this computer. A connected group shares one conductor.`,
      { computer: group.found.computer, target: group.found.target });
    unchecked = group.unchecked;
  }
  // A worker opened in the conductor's workspace would be listed under the
  // conductor's name; it gets its own workspace instead.
  if (role === "agent" && workspace && objects(before.panes).some(pane => pane.workspace_id === workspace && isConductorName(paneAgentName(before, pane)))) workspace = undefined;
  const args = role === "conductor" ? await prepareConductor(kind, effort, model)
    : [...(model && modelFlag[kind] ? [modelFlag[kind], model] : []), ...(data.effort === undefined ? [] : effortArgs(kind, effort))];
  if (workspace && !objects(before.workspaces).some(w => w.workspace_id === workspace)) throw new BridgeError(409, "The workspace changed.");
  const knownWorkspaces = new Set(objects(before.workspaces).map(w => w.workspace_id));
  const knownTabs = new Set(objects(before.tabs).map(t => t.tab_id));
  // Created last, once nothing else can refuse the launch, so a refusal
  // never leaves a worktree or branch behind.
  const worktree: LaunchWorktree | undefined = worktreeRequest ? await createLaunchWorktree(projectDirectory, worktreeRequest) : undefined;
  const cwd = worktree?.cwd ?? projectDirectory;
  try { await terminalProvider().create(server, { workspace, label, cwd }); }
  catch (error) { await worktree?.discard(); throw error; }
  let created: { workspaceId: string; tabId: string; paneId: string } | undefined;
  for (let attempt = 0; attempt < 25 && !created; attempt++) {
    const s = await snapshot(server);
    const fresh = objects(s.tabs).filter(t => !knownTabs.has(t.tab_id)
      && (workspace ? t.workspace_id === workspace : !knownWorkspaces.has(t.workspace_id)));
    const tab = fresh.find(t => t.label === label)
      ?? fresh.find(t => objects(s.workspaces).some(w => w.workspace_id === t.workspace_id && w.label === label))
      ?? fresh[0];
    const pane = tab && objects(s.panes).find(p => p.tab_id === tab.tab_id && p.workspace_id === tab.workspace_id && !p.agent);
    if (tab && pane && id.safeParse(tab.workspace_id).success && id.safeParse(tab.tab_id).success && id.safeParse(pane.pane_id).success) {
      created = { workspaceId: String(tab.workspace_id), tabId: String(tab.tab_id), paneId: String(pane.pane_id) };
    } else await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!created) throw new BridgeError(409, `${terminalName(server)} created "${label}" but its pane did not appear. Check ${terminalName(server)} on the computer.`);
  try {
    await terminalProvider().startAgent(server, created.paneId, { name, kind, args, timeoutMs: timeout });
  } catch (error) {
    // A first-run screen (Claude's folder trust, a login notice) holds the
    // agent at startup. It did start: hand the pane back so the owner answers
    // that screen from the chat instead of stranding the workspace.
    const blocked = agentNotReady(error);
    if (!blocked) {
    const host = terminalName(server);
    const reason = error instanceof BridgeError && error.status === 504 ? "it did not become ready in time"
      : error instanceof BridgeError && error.message.startsWith(`${host}: `) ? error.message.slice(host.length + 2) : `${host} reported an error`;
    throw new BridgeError(409, `${host} couldn't start ${kind} in the new "${label}" pane (${reason}). The workspace was created and is still open on the computer — open it from ${host === "Herdr" ? "Herdr workspaces" : "its tmux session"}.`);
    }
  }
  const after = await snapshot(server);
  const pane = findPane(after, { workspace: created.workspaceId, tab: created.tabId, pane: created.paneId });
  const agentStatus = typeof pane?.agent_status === "string" ? pane.agent_status : undefined;
  const sessionId = pane && pane.agent === kind ? await paneIdentity(server, pane) : undefined;
  const chat = !sessionId && pane && pane.agent === kind ? await paneChatState(server, pane).catch((): Json => ({})) : {};
  const binding = { server, workspace: created.workspaceId, tab: created.tabId, pane: created.paneId, source: kind };
  const target = sessionId ? { ...binding, session: sessionId }
    : chat.starting === true ? { ...binding, starting: true, startingToken: chat.startingToken } : undefined;
  return { ok: true, ...created, agent: kind, agentStatus, role, sessionId, target, ...(unchecked.length ? { unchecked } : {}),
    ...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch } } : {}) };
}
export async function workspaceAction(server: string, operation: string, data: Json): Promise<Json> {
  if (!["focus", "rename", "create", "close"].includes(operation)) throw new BridgeError(400, "Unsupported Herdr action.");
  const s = await snapshot(server);
  const workspace = typeof data.workspaceId === "string" ? data.workspaceId : undefined;
  const tab = typeof data.tabId === "string" ? data.tabId : undefined;
  const pane = typeof data.paneId === "string" ? data.paneId : undefined;
  if (workspace && !objects(s.workspaces).some(w => w.workspace_id === workspace)) throw new BridgeError(409, "The workspace changed.");
  if (tab && !objects(s.tabs).some(t => t.tab_id === tab && (!workspace || t.workspace_id === workspace))) throw new BridgeError(409, "The tab changed.");
  if (pane && !objects(s.panes).some(p => p.pane_id === pane && (!tab || p.tab_id === tab) && (!workspace || p.workspace_id === workspace))) throw new BridgeError(409, "The pane changed.");
  const label = data.label === undefined ? undefined : z.string().min(1).max(200).refine(t => !/[\x00-\x1f\x7f]/.test(t)).parse(data.label);
  const cwd = data.cwd === undefined ? undefined : z.string().max(4096).refine(t => path.isAbsolute(t) && !/[\x00-\x1f\x7f]/.test(t)).parse(data.cwd);
  if (operation === "create") await terminalProvider().create(server, { workspace, label, cwd });
  else if (!workspace && !tab && !pane) throw new BridgeError(400, "Choose a Herdr destination.");
  else if (pane && operation === "focus") await terminalProvider().focusPane(server, pane);
  else if (pane) throw new BridgeError(400, "This pane action is not available.");
  else await terminalProvider().groupAction(server, operation as "focus" | "rename" | "close", { workspace, tab }, label);
  return { ok: true };
}
