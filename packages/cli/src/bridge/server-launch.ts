import { markPaneClosed } from "./worker-close.js";
import { mkdir, mkdtemp, readFile, realpath, rmdir } from "node:fs/promises";
import { phrenStoreRoot } from "./transcripts.js";
import path from "node:path";
import { z } from "zod";
import { homeDir } from "../home-paths.js";
import { defaultPhrenPath } from "../phren-paths.js";
import { agentNames, findPane, isConductorName, paneChatState, paneIdentity, servers, snapshot } from "./herdr.js";
import { type AgentStart, agentNotReady, terminalKind, terminalName, terminalProvider } from "./terminal.js";
import { tmuxScroll } from "./terminal-tmux.js";
import { intervalFromEnv } from "./limits.js";
import { createLaunchWorktree, launchWorktreeSchema, type LaunchWorktree } from "./launch-worktree.js";
import { askpassEnv } from "./sudo.js";
import { briefArgs, DISPATCH_ID_ENV, launchBriefSchema, launchesWithBrief, recordBriefArrival, writeLaunchBrief } from "./launch-brief.js";
import { prepareServedLaunch, registerServedPane, sendServedBrief } from "./opencode-panes.js";
import { conductorBrief, ensureConductorBrief } from "./conductor-context.js";
import { groupConductor, type GroupConductor } from "./conductor-group.js";
import { clearConductor, conductorPane, noteConductorSession, readRoleState, recordConductor, runsAgent } from "./conductor-role.js";
import { localNames } from "./computer-names.js";
import { pretrustFolder } from "./folder-trust.js";
import { claudeHome, claudeLaunchEnv, isAccountSlug, DEFAULT_ACCOUNT } from "./claude-accounts.js";
import { pickClaudeAccount } from "./account-choice.js";
import { harnessInventoryWithin, hasUsable, launchCheckOff, type HarnessInventory } from "./harnesses.js";
import { paneAccountKey, recordPaneAccount } from "./pane-accounts.js";
import { optionalHookPeers } from "./peers.js";
import { AppServerRpcError } from "./codex-app-server.js";
import { codexAppServerEnabled, codexServers } from "./codex-servers.js";
import { logger } from "../logger.js";
import { JobRegistry } from "./job-registry.js";
import { atomic, BridgeError, id, type Json, launchEfforts, objects, PERMISSION_MODES, provider } from "./protocol.js";
import { CLAUDE_NAMES, CODEX_MODES, codexModeFlags, copilotModeFlags } from "./settings-switch.js";

/** Starting agents in Herdr from the phone: the launch route's harness
 * arguments, the conductor brief, and workspace, tab and pane actions. */

const launchKinds = ["codex", "claude", "copilot", "opencode", "phren"] as const;
const plainText = (max: number) => z.string().min(1).max(max).refine(t => !/[\x00-\x1f\x7f]/.test(t));

type LaunchEffort = (typeof launchEfforts)[number];

/** How each harness takes a reasoning effort at startup. */
function effortArgs(kind: (typeof launchKinds)[number], effort: LaunchEffort): string[] {
  if (kind === "claude") return ["--effort", effort];
  if (kind === "codex") return ["-c", `model_reasoning_effort=${effort}`];
  if (kind === "opencode") return ["--variant", effort];
  if (kind === "copilot") return ["--reasoning-effort", effort];
  // phren-agent takes low to xhigh, and max as xhigh.
  if (kind === "phren") return ["--reasoning", effort];
  return [];
}

/** phren's own agent runs as `phren agent`: the subcommand and its interactive TUI lead its arguments. */
const PHREN_AGENT_ARGS = ["agent", "-i"];

/**
 * phren agent's quick chat and resume: `mode: "chat"` starts it with no tools
 * and its memory read up front (`--mode chat`); `resumeSession` continues a
 * session's history (`--session <id>`). Resuming a chat in `mode: "agent"`
 * promotes it: the same conversation with tools. An agent session that used
 * tools cannot go back to a chat: its history holds tool calls and results,
 * which a request with no tools may not carry (Anthropic refuses it with a
 * 400), so it is refused here before any pane exists.
 */
export async function phrenLaunchArgs(kind: string, data: Json, store = phrenStoreRoot()): Promise<string[]> {
  const mode = z.enum(["agent", "chat"]).optional().parse(data.mode ?? undefined);
  const resume = data.resumeSession === undefined || data.resumeSession === null ? undefined
    : z.string().uuid("resumeSession must be a phren agent session id.").parse(data.resumeSession);
  if ((mode || resume) && kind !== "phren") throw new BridgeError(400, "mode and resumeSession are for phren agent launches (kind phren).");
  if (mode === "chat" && resume && await sessionUsedTools(resume, store)) {
    throw new BridgeError(400, "This session used tools, so it can't continue as a quick chat. Resume it as an agent (mode agent).", { code: "chat-has-tools" });
  }
  return [...(mode === "chat" ? ["--mode", "chat"] : []), ...(resume ? ["--session", resume] : [])];
}

/** Whether a phren agent session's history, as its model sees it, holds a
 * tool call or result: its event log (`<store>/.sessions`) folded as the
 * agent folds it, so a span a compaction summary replaced counts as that
 * summary. False when there is no readable log; phren agent says so itself. */
export async function sessionUsedTools(session: string, store = phrenStoreRoot()): Promise<boolean> {
  const raw = await readFile(path.join(store, ".sessions", `session-${session}.events.jsonl`), "utf8").catch(() => "");
  const withTools = (message: unknown) => {
    const content = (message as { content?: unknown } | undefined)?.content;
    return Array.isArray(content) && content.some(block => ["tool_use", "tool_result"].includes(String((block as { type?: unknown } | null)?.type)));
  };
  const surface = new Map<number, boolean>();
  for (const line of raw.split("\n")) {
    let event: { seq?: unknown; type?: unknown; data?: { message?: unknown; start?: unknown; end?: unknown } };
    try { event = JSON.parse(line) as typeof event; } catch { continue; }
    if (typeof event.seq !== "number" || !event.data) continue;
    if (["user/message", "assistant/message", "tool/results"].includes(String(event.type))) surface.set(event.seq, withTools(event.data.message));
    else if (event.type === "log/replace" && typeof event.data.start === "number" && typeof event.data.end === "number") {
      for (const seq of [...surface.keys()]) if (seq >= event.data.start && seq <= event.data.end) surface.delete(seq);
      surface.set(event.data.start, withTools(event.data.message));
    }
  }
  return [...surface.values()].some(Boolean);
}

/** A model from phren agent's catalog (`/v1/models?source=phren`) is
 * `<provider>/<model>`. phren agent reads an openai or openai-codex prefix off
 * `--model` itself; the rest name their provider with `--provider`. Any other
 * model (an OpenRouter id typed by hand) passes through as it is. */
export function phrenModelArgs(model: string): string[] {
  const match = /^(anthropic|deepseek|ollama|openrouter|openai-compat)\/(.+)$/.exec(model);
  return match ? ["--provider", match[1], "--model", match[2]] : ["--model", model];
}

async function prepareConductor(kind: (typeof launchKinds)[number], effort: LaunchEffort, model?: string): Promise<string[]> {
  const brief = await conductorBrief();
  const briefFile = await ensureConductorBrief(brief);
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
  if (kind === "phren") return [...PHREN_AGENT_ARGS, ...(model ? phrenModelArgs(model) : []), "--append-system-prompt-file", briefFile, ...effortArgs(kind, effort)];
  throw new BridgeError(400, "The selected harness cannot run as a conductor.");
}

async function targetForPane(server: string, pane: Json): Promise<Json | undefined> {
  if (!provider.safeParse(pane.agent).success || !id.safeParse(pane.workspace_id).success || !id.safeParse(pane.tab_id).success || !id.safeParse(pane.pane_id).success) return undefined;
  const binding = { server, workspace: pane.workspace_id, tab: pane.tab_id, pane: pane.pane_id, source: pane.agent };
  const chat = await paneChatState(server, pane, { tokenWhenIdentified: false }).catch((): Json => ({}));
  if (typeof chat.sessionId === "string") return { ...binding, session: chat.sessionId };
  return chat.starting === true ? { ...binding, starting: true, startingToken: chat.startingToken } : undefined;
}

/** The live conductor on this computer, as a target: the pane the Hook
 * recorded (docs/conductor-sets.md), or before any record, a pane named as a
 * conductor on any server, which is then recorded. `known` reuses a snapshot
 * the caller already took. */
export async function localConductor(known?: { server: string; snapshot: Json }): Promise<{ server: string; target?: Json } | undefined> {
  const state = await readRoleState();
  if (state?.conductor === null) return undefined;
  const live = new Set((await servers()).map(item => String(item.session)));
  if (known) live.add(known.server);
  const names = state?.conductor ? [state.conductor.server].filter(name => live.has(name)) : [...live];
  for (const name of names) {
    const value = known && name === known.server ? known.snapshot : await snapshot(name).catch(() => undefined);
    if (!value) continue;
    const pane = await conductorPane(name, value);
    if (!runsAgent(pane)) continue;
    const target = await targetForPane(name, pane);
    // A restart or a new login in the same pane: the role stays, the session is new.
    if (typeof target?.session === "string") await noteConductorSession(name, String(pane.pane_id), target.session);
    return { server: name, target };
  }
  return undefined;
}

/** Refuses a second conductor in this computer's set: a live one here on
 * another pane, or on any member. Members that could not say come back as `unchecked`. */
async function requireNoConductor(server: string, before: Json, except?: string): Promise<GroupConductor["unchecked"]> {
  const existing = await localConductor({ server, snapshot: before });
  if (existing && !(except && existing.server === server && existing.target?.pane === except)) {
    throw new BridgeError(409, "A conductor is already running on this computer. Stop it first.", { target: existing.target });
  }
  const group = await groupConductor((await optionalHookPeers()).peers, localNames());
  if (group.found) throw new BridgeError(409, `A conductor is already running on ${group.found.computer}, which is in this computer's set. A set of linked computers shares one conductor.`,
    { computer: group.found.computer, target: group.found.target });
  return group.unchecked;
}

/** The phone names the pane's workspace and tab too; the CLI may know only the pane. */
const paneRequest = z.object({ workspaceId: id.optional(), tabId: id.optional(), paneId: id }).strict();

/** "Make conductor": the owner gives an agent already running in a pane on this computer the role. */
export async function makeConductor(server: string, data: Json): Promise<Json> {
  const place = paneRequest.parse(data);
  const before = await snapshot(server);
  const pane = objects(before.panes).find(p => p.pane_id === place.paneId && (place.workspaceId === undefined || p.workspace_id === place.workspaceId)
    && (place.tabId === undefined || p.tab_id === place.tabId));
  if (!pane) throw new BridgeError(409, "The pane changed.");
  if (!runsAgent(pane)) throw new BridgeError(409, "No agent is running in this pane.");
  if (pane.agent === "copilot") throw new BridgeError(400, "Copilot cannot run as a conductor.");
  const unchecked = await requireNoConductor(server, before, place.paneId);
  const target = await targetForPane(server, pane);
  await recordConductor(server, pane, "owner", typeof target?.session === "string" ? target.session : undefined);
  return { ok: true, conductor: { server, ...(target ? { target } : {}) }, ...(unchecked.length ? { unchecked } : {}) };
}

/** "Stop being conductor": the pane keeps its agent and loses the role. With
 * `paneId`, only that pane's role ends. */
export async function stopConductor(data: Json): Promise<Json> {
  const pane = data.paneId === undefined ? undefined : id.parse(data.paneId);
  const state = await readRoleState();
  if (pane !== undefined && state?.conductor === undefined) {
    // Before any record a named pane may still be the conductor; settle that first.
    await localConductor();
  }
  const held = (await readRoleState())?.conductor;
  if (pane !== undefined && held && held.pane !== pane) throw new BridgeError(409, "That pane is not this computer's conductor.");
  const stopped = await clearConductor(pane);
  return { ok: true, stopped: !!stopped };
}

/** How long a pane the Hook just created may take to reach its shell prompt. */
const SHELL_READY_MS = intervalFromEnv("PHREN_SHELL_READY_MS", 15_000);

/** Herdr starts an agent only at an interactive shell prompt and refuses
 * with `agent_pane_busy` ("is not an available shell") before that. A pane
 * created a moment ago is busy only while its login shell starts, which a
 * loaded computer can stretch to seconds (three Devbox dispatches failed
 * this way on 2026-09-27; the same pane took the agent by hand a minute
 * later). Nothing is typed on a refusal, so retry until the shell is up. */
async function startWhenShellReady(server: string, pane: string, agent: AgentStart): Promise<void> {
  const deadline = Date.now() + SHELL_READY_MS;
  for (;;) {
    try { await terminalProvider().startAgent(server, pane, agent); return; } catch (error) {
      const starting = error instanceof BridgeError && error.details?.herdrCode === "agent_pane_busy";
      if (!starting || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

/** The Herdr agent-name slug for a human label: "Conductor smoke 4" becomes "conductor-smoke-4". */
export function herdrAgentName(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 32).replace(/-+$/, "");
  return slug || "agent";
}

type InventoryReader = () => Promise<HarnessInventory>;
let inventoryReader: InventoryReader | undefined;
/** Only for tests: what this computer can launch. Without one, `PHREN_LAUNCH_CHECK=off` skips the early availability check. */
export function setLaunchInventory(reader: InventoryReader | undefined): void { inventoryReader = reader; }

/** Refuses a launch the computer cannot run before any pane exists: the harness is not installed
 * (`harness_unavailable`), or the account is unknown, signed out, or given for a harness without accounts
 * (`account_unavailable`). Only a definite answer refuses; an inventory that cannot be read lets the launch go on. */
async function requireAvailable(kind: string, account: string | undefined): Promise<void> {
  if (!inventoryReader && launchCheckOff()) return;
  // Bounded: a cold sign-in check per home can take seconds, and an unready inventory lets the launch go on.
  const inventory = await (inventoryReader ?? (() => harnessInventoryWithin(2_500)))().catch(() => undefined);
  if (!inventory) return;
  const availability = hasUsable(inventory, kind, account);
  if (!availability.ok) throw new BridgeError(409, availability.reason, { code: availability.code });
}

export interface LaunchOptions {
  canary?: boolean;
  /** `data.cwd` is a folder the Hook resolved itself (a dispatched or
   * scheduled project's source folder), so it may be marked trusted for the
   * harness before the launch. Never set for a folder the phone chose. */
  trustFolder?: boolean;
}

/**
 * "Open on a computer": a new Herdr workspace (or a tab in an existing one)
 * in the project's directory, with the chosen agent started in its pane.
 * Herdr's create calls do not return identifiers, so the new tab is found
 * by diffing snapshots; `agent.start` returns once Herdr has detected the
 * agent and it is ready for input, which can take most of `timeoutMs`.
 * A `launchId` (a UUID the caller keeps for one intended launch) makes it
 * idempotent: the same id again returns the first launch's pane while it is
 * listed, with `reused: true`, instead of starting a second agent.
 */
export async function launchSession(server: string, data: Json, options: LaunchOptions = {}): Promise<Json> {
  const launchId = data.launchId === undefined || data.launchId === null ? undefined
    : z.string().uuid("launchId must be a UUID.").parse(data.launchId);
  if (!launchId) return startSession(server, data, options);
  const now = Date.now();
  for (const [key, entry] of launchesById) if (now - entry.at > LAUNCH_ID_TTL_MS) launchesById.delete(key);
  const key = `${server}\u0000${launchId}`;
  const earlier = launchesById.get(key);
  // Reserve the id before checking the old pane. Two retries after a closed
  // chat must share its replacement, just as they share the initial launch.
  const result = Promise.resolve().then(async () => {
    if (earlier) {
      const previous = await earlier.result;
      if (await stillListed(server, previous)) return { ...previous, reused: true };
    }
    return startSession(server, data, options);
  });
  // An in-flight launch must not expire while another caller is waiting.
  const entry = { at: Infinity, result };
  launchesById.set(key, entry);
  void result.then(() => { entry.at = Date.now(); }, () => {
    if (launchesById.get(key) !== entry) return;
    // A temporary snapshot failure is not evidence that the old pane died.
    if (earlier && Number.isFinite(earlier.at)) launchesById.set(key, earlier);
    else launchesById.delete(key);
  });
  return result;
}

/** Launches by the caller's `launchId`, for `LAUNCH_ID_TTL_MS`: a repeat
 * joins the launch in flight or gets its pane back. In memory only. */
const launchesById = new Map<string, { at: number; result: Promise<Json> }>();
export const LAUNCH_ID_TTL_MS = 10 * 60_000;
/** For tests: forget every remembered launch. */
export function resetLaunchIds(): void { launchesById.clear(); }

async function stillListed(server: string, result: Json): Promise<boolean> {
  const s = await snapshot(server);
  return objects(s.tabs).some(t => t.tab_id === result.tabId && t.workspace_id === result.workspaceId)
    && objects(s.panes).some(p => p.pane_id === result.paneId && p.tab_id === result.tabId && p.workspace_id === result.workspaceId);
}

async function startSession(server: string, data: Json, options: LaunchOptions): Promise<Json> {
  const role = z.enum(["agent", "conductor"]).default("agent").parse(data.role);
  const agentFolder = z.boolean().default(false).parse(data.agentFolder);
  if (agentFolder && (role !== "agent" || data.project !== undefined || (data.cwd !== undefined && data.cwd !== "") || data.worktree != null)) {
    throw new BridgeError(400, "An agent folder is for a projectless agent without cwd or worktree.");
  }
  const projectDirectory = agentFolder ? undefined
    : z.string().min(1).max(4096).refine(t => path.isAbsolute(t) && !/[\x00-\x1f\x7f]/.test(t)).parse(data.cwd);
  const worktreeRequest = data.worktree === undefined || data.worktree === null ? undefined : launchWorktreeSchema.parse(data.worktree);
  if (worktreeRequest && role === "conductor") throw new BridgeError(400, "A conductor works across projects, so it cannot start in a worktree.");
  const label = plainText(200).parse(data.label);
  const kind = z.enum(launchKinds).parse(data.kind);
  const effort = z.enum(launchEfforts).default("medium").parse(data.effort);
  const named = data.account === undefined || data.account === null ? undefined : z.string().refine(isAccountSlug, "Account must be default or a lowercase slug.").parse(data.account);
  const permissionMode = z.enum(PERMISSION_MODES).optional().parse(data.permissionMode ?? undefined);
  if (permissionMode && role === "conductor") throw new BridgeError(400, "A conductor starts with its own permissions; permissionMode is for workers.");
  if (permissionMode && kind === "opencode") throw new BridgeError(400, "OpenCode takes its permissions from its own config; permissionMode is for Claude, Codex and Copilot workers.");
  if (permissionMode && kind === "phren") throw new BridgeError(400, "phren agent takes its permissions from its own settings; permissionMode is for Claude, Codex and Copilot workers.");
  if (role === "conductor" && kind === "copilot") throw new BridgeError(400, "Copilot cannot run as a conductor.");
  if (role === "conductor" && data.mode === "chat") throw new BridgeError(400, "A conductor needs agent mode with tools.");
  const phrenArgs = await phrenLaunchArgs(kind, data);
  // A dispatched worker's or scheduled run's first prompt. It rides on the
  // launch where the harness takes one; elsewhere the caller types it.
  const brief = data.brief === undefined || data.brief === null ? undefined : launchBriefSchema.parse(data.brief);
  if (brief && role === "conductor") throw new BridgeError(400, "A conductor starts with its own brief.");
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
  const modelFlag: Partial<Record<(typeof launchKinds)[number], string>> = { codex: "--model", claude: "--model", opencode: "--model", copilot: "--model", phren: "--model" };
  let workspace = data.workspaceId === undefined ? undefined : id.parse(data.workspaceId);
  // Herdr 0.9.1 refuses a start timeout of 3000 ms or less (invalid_agent_timeout).
  const timeout = Math.min(120_000, Math.max(3_001, data.timeoutMs === undefined ? 45_000 : z.number().int().parse(data.timeoutMs)));
  // Checked before anything is created, so a refusal leaves no pane, worktree or brief file behind.
  // A Claude launch that names no account runs under the signed-in one with the most room left.
  const choice = kind === "claude" && named === undefined ? await pickClaudeAccount(`Launch "${label}"`).catch(() => undefined) : undefined;
  const account = named ?? choice?.account;
  await requireAvailable(kind, account);
  const home = kind === "claude" && account && account !== DEFAULT_ACCOUNT ? claudeHome(account) : undefined;
  if (kind === "claude" && account && account !== DEFAULT_ACCOUNT && !home) throw new BridgeError(409, `No claude account "${account}"`, { code: "account_unavailable" });
  const before = await snapshot(server);
  // Herdr agent names are unique per server; a scheduled run or a second
  // launch with the same label would otherwise collide with the first.
  const taken = agentNames(before);
  let name = wanted;
  for (let n = 2; taken.has(name) && n < 100; n++) name = `${wanted.slice(0, 32 - String(n).length - 1)}-${n}`;
  // One conductor per set of linked computers.
  const unchecked: GroupConductor["unchecked"] = role === "conductor" && !options.canary ? await requireNoConductor(server, before) : [];
  // A worker opened in the conductor's workspace would be listed under the
  // conductor's name; it gets its own workspace instead.
  const conductorHere = role === "agent" && workspace ? await conductorPane(server, before) : undefined;
  if (conductorHere && conductorHere.workspace_id === workspace) workspace = undefined;
  const args = role === "conductor" ? [...await prepareConductor(kind, effort, model), ...(kind === "phren" ? phrenArgs : [])]
    : [...(kind === "phren" ? [...PHREN_AGENT_ARGS, ...phrenArgs] : []), ...(model && kind === "phren" ? phrenModelArgs(model) : model && modelFlag[kind] ? [modelFlag[kind], model] : []), ...(data.effort === undefined ? [] : effortArgs(kind, effort)),
      ...(permissionMode && kind === "claude" ? ["--permission-mode", CLAUDE_NAMES[permissionMode]] : []), ...(permissionMode && kind === "codex" ? codexModeFlags(permissionMode) : []), ...(permissionMode && kind === "copilot" ? copilotModeFlags(permissionMode) : [])];
  // A Codex worker runs on a Phren-owned app-server (codex-servers.ts): the
  // pane joins the thread the Hook started, and the brief is that thread's
  // first turn. The typed arguments below stay the fallback.
  const structured = kind === "codex" && role === "agent" && !options.canary && codexAppServerEnabled();
  // OpenCode serves its own API on a port of its own (opencode-panes.ts): the
  // Hook sends its prompts, answers its asks and interrupts it over HTTP, and
  // the pane stays the owner's view. A brief goes the same way once it
  // answers; its file still marks the dispatch so the arrival is recorded here.
  const served = kind === "opencode" ? await prepareServedLaunch() : undefined;
  if (served) args.push(...served.args);
  const briefFile = brief && (launchesWithBrief(kind) || structured || served) ? await writeLaunchBrief(brief, Date.now(), label) : undefined;
  const briefLaunch = brief && briefFile && launchesWithBrief(kind) ? briefArgs(kind, briefFile) : undefined;
  // sudo -A in the new agent asks the phone for the password (sudo.ts).
  const variables = { ...askpassEnv(), ...(brief ? { [DISPATCH_ID_ENV]: brief.id } : {}), ...served?.env, ...(home ? claudeLaunchEnv(home) : {}) };
  const env = Object.keys(variables).length ? variables : undefined;
  if (workspace && !objects(before.workspaces).some(w => w.workspace_id === workspace)) throw new BridgeError(409, "The workspace changed.");
  const knownWorkspaces = new Set(objects(before.workspaces).map(w => w.workspace_id));
  const knownTabs = new Set(objects(before.tabs).map(t => t.tab_id));
  // Created last, once nothing else can refuse the launch, so a refusal
  // never leaves a worktree or branch behind.
  const worktree: LaunchWorktree | undefined = worktreeRequest ? await createLaunchWorktree(projectDirectory!, worktreeRequest) : undefined;
  // The same root as the conductor, chosen by this computer's PHREN_PATH.
  // mkdtemp keeps simultaneous chats with the same title isolated.
  let scratch: string | undefined;
  if (agentFolder) {
    const store = await realpath(defaultPhrenPath());
    // Runtime folders are excluded from project discovery and store sync.
    const runtime = path.join(store, ".runtime");
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    if (await realpath(runtime) !== runtime) throw new BridgeError(403, "The runtime folder must be inside the Phren directory.");
    const agents = path.join(runtime, "agents");
    await mkdir(agents, { recursive: true, mode: 0o700 });
    // A pre-existing symlink must not redirect the new folder outside the store.
    if (await realpath(agents) !== agents) throw new BridgeError(403, "The agents folder must be inside the Phren directory.");
    scratch = await mkdtemp(path.join(agents, `${new Date().toISOString().slice(0, 10)}-${herdrAgentName(label)}-`));
  }
  const cwd = scratch ?? worktree?.cwd ?? projectDirectory!;
  // Claude's folder-trust screen defaults to "No, exit" and Codex's holds the
  // agent too; a folder the Hook picked or just created is trusted up front.
  if (scratch || worktree || options.trustFolder) await pretrustFolder(kind, cwd, scratch ? "new agent folder" : worktree ? `new worktree for ${worktree.branch}` : "project folder",
    home ? { ...process.env, ...claudeLaunchEnv(home) } : process.env);
  try { await terminalProvider().create(server, { workspace, label, cwd, ...(env ? { env } : {}) }); }
  catch (error) { await worktree?.discard(); if (scratch) await rmdir(scratch).catch(() => undefined); throw error; }
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
  const place = { workspace: created.workspaceId, tab: created.tabId, pane: created.paneId };
  const structuredLaunch = structured ? await codexServers.launch({ server, ...place }, { cwd, ...(model ? { model } : {}),
    ...(data.effort === undefined ? {} : { effort }), env: { ...(terminalProvider().paneEnv?.(server, place) ?? {}), ...(env ?? {}) },
    ...(brief ? { dispatchId: brief.id } : {}), startThread: !!brief, ...(permissionMode ? { remoteArgs: codexModeFlags(permissionMode) } : {}) }).catch(error => {
    logger.warn("launch", `Codex app-server unavailable, typing instead: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }) : undefined;
  const appServer = structuredLaunch?.entry;
  const binding = { server, workspace: created.workspaceId, tab: created.tabId, pane: created.paneId, source: kind };
  // The brief is the thread's first turn, acknowledged with its id before
  // the pane even starts; the pane's TUI shows it running when it joins.
  // Refused outright, nothing was sent and the caller types it; a lost
  // reply may have started it, so it is not offered for typing again.
  let briefTurn: "sent" | "uncertain" | undefined;
  if (appServer?.threadId && brief) {
    try {
      // The thread's first turn carries the mode; the TUI joining it has no flags to set.
      if (permissionMode) codexServers.holdSettings(appServer, { ...CODEX_MODES[permissionMode] });
      await codexServers.prompt(appServer, brief.text);
      briefTurn = "sent";
      await recordBriefArrival(brief.id, "UserPromptSubmit", { ...binding, session: appServer.threadId }).catch(() => undefined);
    } catch (error) { briefTurn = error instanceof AppServerRpcError ? undefined : "uncertain"; }
  }
  const agentArgs = structuredLaunch ? structuredLaunch.args : [...args, ...(briefLaunch ?? [])];
  try {
    await startWhenShellReady(server, created.paneId, { name, kind, args: agentArgs, timeoutMs: timeout, ...(env ? { env } : {}) });
  } catch (error) {
    if (appServer && !agentNotReady(error)) await codexServers.stop(appServer).catch(() => undefined);
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
  // Without a brief the pane's TUI started the thread; the Hook heard it.
  if (appServer && !appServer.threadId) await codexServers.awaitThread(appServer);
  let servedBrief: { session: string; delivered: boolean } | undefined;
  if (served) {
    const variant = role === "conductor" || data.effort !== undefined ? effort : undefined;
    const entry = await registerServedPane(server, created.paneId, cwd, served,
      { defaults: { ...(role === "conductor" ? { agent: "conductor" } : {}), ...(model ? { model } : {}), ...(variant ? { variant } : {}) } }).catch(() => undefined);
    const sent = entry && brief ? await sendServedBrief(entry, brief.text) : undefined;
    if (brief && sent?.sent) {
      // Sent is enough to never type it again; the user turn appearing in
      // the session is the acceptance the dispatch receipt waits for.
      servedBrief = { session: sent.session, delivered: sent.delivered };
      const at = { ...binding, session: sent.session };
      await recordBriefArrival(brief.id, "SessionStart", at).catch(() => {});
      if (sent.delivered) await recordBriefArrival(brief.id, "UserPromptSubmit", at).catch(() => {});
    }
  }
  const after = await snapshot(server);
  const pane = findPane(after, { workspace: created.workspaceId, tab: created.tabId, pane: created.paneId });
  const agentStatus = typeof pane?.agent_status === "string" ? pane.agent_status : undefined;
  if (kind === "claude" && account) recordPaneAccount(paneAccountKey(server, created.paneId), account, typeof pane?.terminal_id === "string" ? pane.terminal_id : undefined);
  const sessionId = appServer?.threadId ?? (pane && pane.agent === kind ? await paneIdentity(server, pane) : undefined) ?? servedBrief?.session;
  // The Hook, not the agent name, holds the role from here on.
  if (role === "conductor" && !options.canary) await recordConductor(server, pane ?? { pane_id: created.paneId, workspace_id: created.workspaceId, tab_id: created.tabId, agent: kind },
    "launch", sessionId);
  const chat = !sessionId && pane && pane.agent === kind ? await paneChatState(server, pane).catch((): Json => ({})) : {};
  const target = sessionId ? { ...binding, session: sessionId }
    : chat.starting === true ? { ...binding, starting: true, startingToken: chat.startingToken } : undefined;
  // Register a dispatched or scheduled worker's job, so the resources report
  // can name its agent and a sweep can end a leftover process group after its
  // pane is gone. The process group is resolved on the next read.
  if (brief && role === "agent") {
    await new JobRegistry().register({ pane: { server, pane: created.paneId, ...(created.workspaceId ? { workspace: created.workspaceId } : {}), agent: kind, label },
      ...(sessionId ? { session: sessionId } : {}), agent: kind, label, command: kind }).catch(() => undefined);
  }
  return { ok: true, ...created, cwd, agent: kind, agentStatus, role, sessionId, target, ...(account ? { account } : {}), ...(choice ? { accountChoice: choice.reason } : {}), ...(permissionMode ? { permissionMode } : {}), ...(unchecked.length ? { unchecked } : {}),
    // The caller types the brief itself unless it went with the launch.
    ...(brief ? { briefLaunched: appServer ? briefTurn !== undefined : !!briefLaunch || !!servedBrief,
      briefState: appServer ? briefTurn ?? "unconfirmed" : served ? (servedBrief?.delivered ? "sent" : "uncertain") : briefLaunch ? "sent" : "unconfirmed" } : {}),
    ...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch } } : {}) };
}
export async function workspaceAction(server: string, operation: string, data: Json): Promise<Json> {
  if (!["focus", "rename", "create", "close", "scroll"].includes(operation)) throw new BridgeError(400, "Unsupported Herdr action.");
  const workspace = typeof data.workspaceId === "string" ? data.workspaceId : undefined;
  const tab = typeof data.tabId === "string" ? data.tabId : undefined;
  const pane = typeof data.paneId === "string" ? data.paneId : undefined;
  if (operation === "scroll") {
    // Every swipe step lands here, so it skips the snapshot: tmux itself
    // refuses a pane that is gone.
    if (terminalKind(server) !== "tmux") throw new BridgeError(400, "Herdr scrolls in the terminal itself.");
    return { ok: true, ...await tmuxScroll(server, pane, z.number().int().min(-200).max(200).parse(data.lines)) };
  }
  const s = await snapshot(server);
  if (workspace && !objects(s.workspaces).some(w => w.workspace_id === workspace)) throw new BridgeError(409, "The workspace changed.");
  if (tab && !objects(s.tabs).some(t => t.tab_id === tab && (!workspace || t.workspace_id === workspace))) throw new BridgeError(409, "The tab changed.");
  if (pane && !objects(s.panes).some(p => p.pane_id === pane && (!tab || p.tab_id === tab) && (!workspace || p.workspace_id === workspace))) throw new BridgeError(409, "The pane changed.");
  const label = data.label === undefined ? undefined : z.string().min(1).max(200).refine(t => !/[\x00-\x1f\x7f]/.test(t)).parse(data.label);
  const cwd = data.cwd === undefined ? undefined : z.string().max(4096).refine(t => path.isAbsolute(t) && !/[\x00-\x1f\x7f]/.test(t)).parse(data.cwd);
  if (operation === "create") await terminalProvider().create(server, { workspace, label, cwd });
  else if (!workspace && !tab && !pane) throw new BridgeError(400, "Choose a Herdr destination.");
  else if (pane && operation === "focus") await terminalProvider().focusPane(server, pane);
  else if (pane && operation === "close") {
    const row = objects(s.panes).find(p => p.pane_id === pane)!;
    await markPaneClosed(server, row);
    await terminalProvider().closePane(server, pane);
  }
  else if (pane) throw new BridgeError(400, "This pane action is not available.");
  else {
    if (operation === "close") for (const row of objects(s.panes).filter(row => (!workspace || row.workspace_id === workspace) && (!tab || row.tab_id === tab))) {
      await markPaneClosed(server, row);
    }
    await terminalProvider().groupAction(server, operation as "focus" | "rename" | "close", { workspace, tab }, label);
  }
  return { ok: true };
}
