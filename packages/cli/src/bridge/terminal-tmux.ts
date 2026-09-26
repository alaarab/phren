// tmux as the Hook's terminal provider, for computers without Herdr.
//
// Two tmux servers are Hook servers: the owner's own (the default socket,
// server name "tmux"), where the Hook finds agents the owner started, and a
// hidden one on its own socket (`tmux -L phren`, server name "tmux-phren"),
// where agents started from the phone run. Nobody has to know tmux for the
// second: it starts on the first launch, and `tmux -L phren attach` shows it.
//
// tmux knows processes, not agents. The agent in a pane comes from its
// foreground processes' command lines, and its status from the harness's own
// lifecycle hooks (pane-status.ts). Everything runs through execFile with an
// argument array: text from the phone reaches tmux as an argument or on
// stdin, never through a shell.
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import path from "node:path";
import { BridgeError, objects, serverName, type Json } from "./protocol.js";
import { paneStatus } from "./pane-status.js";
import type { TerminalPane, TerminalProvider } from "./terminal.js";
import { herdrPanes } from "./terminal-herdr.js";

/** The owner's own tmux server (the default socket). */
export const TMUX_DEFAULT = "tmux";
/** The hidden server phone-started agents run in: `tmux -L phren`. */
export const TMUX_HIDDEN = "tmux-phren";

/** The tmux socket name (`-L`) a Hook server name stands for: "tmux" is the
 * default socket and "tmux-<name>" the socket `<name>`. */
export function tmuxSocketName(server: string): string | undefined {
  const match = /^tmux(?:-([A-Za-z0-9_][A-Za-z0-9_.-]{0,63}))?$/.exec(server);
  return match ? match[1] ?? "default" : undefined;
}
/** The Hook server name for a tmux socket name. */
export function tmuxServerName(socket: string): string | undefined {
  const name = socket === "default" ? TMUX_DEFAULT : `tmux-${socket}`;
  return tmuxSocketName(name) === socket && serverName.safeParse(name).success ? name : undefined;
}

/** Runs tmux with `args` (after the socket flags) and answers its stdout. */
export type TmuxRunner = (args: string[], options?: { input?: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<string>;
interface TmuxDeps {
  /** The tmux executable, or undefined when this computer has none. */
  binary: () => string | undefined;
  run: (socket: string, args: string[], options?: { input?: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<string>;
  /** `ps` rows: pid, process group, terminal's foreground group, terminal, command line. */
  processes: () => Promise<string>;
  /** `tmux -V`. */
  version: () => Promise<string>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

let cachedBinary: { at: number; value: string | undefined } | undefined;
/** The tmux on PATH or in the usual install folders; the Hook's service
 * PATH can be shorter than a login shell's. Rechecked every minute. */
export function tmuxBinary(): string | undefined {
  // PHREN_TMUX=off keeps the Hook on Herdr alone.
  if (process.env.PHREN_TMUX === "off") return undefined;
  if (cachedBinary && Date.now() - cachedBinary.at < 60_000) return cachedBinary.value;
  const folders = [...(process.env.PATH ?? "").split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/home/linuxbrew/.linuxbrew/bin"];
  let value: string | undefined;
  for (const folder of folders) {
    if (!folder || !path.isAbsolute(folder)) continue;
    const candidate = path.join(folder, "tmux");
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); value = candidate; break; } } catch { /* next folder */ }
  }
  cachedBinary = { at: Date.now(), value };
  return value;
}

/** The environment tmux and the panes it starts get: the Hook's, without
 * another multiplexer's variables. */
function tmuxEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("HERDR_") && name !== "TMUX" && name !== "TMUX_PANE"));
}

function tmuxError(stderr: string, error: { name: string; code?: string | number | null; killed?: boolean; signal?: string | null }): BridgeError {
  const said = stderr.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 200);
  if (error.name === "AbortError") return new BridgeError(499, "Request cancelled.");
  if (error.killed || error.signal === "SIGTERM") return new BridgeError(504, "tmux did not answer. Refresh before trying again.");
  if (error.code === "ENOENT") return new BridgeError(503, "tmux is not installed on this computer.");
  if (/no server running|error connecting to|No such file or directory/i.test(said)) return new BridgeError(503, "tmux is not running on this computer.", { code: "not_running" });
  return new BridgeError(409, said ? `tmux: ${said}` : "tmux could not perform this action. Refresh the session before trying again.");
}

const defaultDeps: TmuxDeps = {
  binary: tmuxBinary,
  run: (socket, args, options = {}) => new Promise((resolve, reject) => {
    const binary = tmuxBinary();
    if (!binary) { reject(new BridgeError(503, "tmux is not installed on this computer.")); return; }
    const child = execFile(binary, ["-L", socket, ...args], { timeout: options.timeoutMs ?? 5_000, maxBuffer: 4_194_304, env: tmuxEnvironment(), signal: options.signal },
      (error, stdout, stderr) => { if (error) reject(tmuxError(String(stderr), error)); else resolve(String(stdout)); });
    if (options.input !== undefined) child.stdin?.end(options.input); else child.stdin?.end();
  }),
  processes: () => new Promise(resolve => {
    execFile("ps", ["-A", "-o", "pid=,pgid=,tpgid=,tty=,args="], { timeout: 3_000, maxBuffer: 8_388_608, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout) => resolve(error ? "" : String(stdout)));
  }),
  version: () => new Promise(resolve => {
    const binary = tmuxBinary();
    if (!binary) { resolve(""); return; }
    execFile(binary, ["-V"], { timeout: 3_000 }, (error, stdout) => resolve(error ? "" : String(stdout)));
  }),
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new BridgeError(499, "Request cancelled.")); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(new BridgeError(499, "Request cancelled.")); };
    signal?.addEventListener("abort", abort, { once: true });
  }),
};
let deps: TmuxDeps = defaultDeps;
/** For tests: replace how tmux and ps run; the returned function restores them. */
export function setTmuxDeps(replacement: Partial<TmuxDeps>): () => void {
  const previous = deps;
  deps = { ...deps, ...replacement };
  return () => { deps = previous; };
}

function socketOf(server: string): string {
  const socket = tmuxSocketName(serverName.parse(server));
  if (!socket) throw new BridgeError(400, "This is not a tmux server.");
  return socket;
}
const tmux = (server: string, args: string[], options?: { input?: string; timeoutMs?: number; signal?: AbortSignal }) => deps.run(socketOf(server), args, options);

// tmux ids carry sigils the Hook's ids do not allow: session $3, window @5,
// pane %12 become s3, w5 and p12, and back.
const SIGILS = { s: "$", w: "@", p: "%" } as const;
export function fromTmuxId(value: string): string | undefined {
  const match = /^([$@%])(\d{1,9})$/.exec(value);
  return match ? `${match[1] === "$" ? "s" : match[1] === "@" ? "w" : "p"}${match[2]}` : undefined;
}
export function toTmuxId(value: string, kind: keyof typeof SIGILS): string {
  const match = /^([swp])(\d{1,9})$/.exec(value);
  if (!match || match[1] !== kind) throw new BridgeError(409, "This tmux pane changed. Refresh the computer.");
  return SIGILS[kind] + match[2];
}

/** The agent a command line runs, by the harness's executable or package. */
export function agentFromCommand(command: string): string | undefined {
  const words = command.trim().split(/\s+/).filter(Boolean).slice(0, 4);
  const [first, second] = words, base = (word?: string) => word ? path.basename(word) : "";
  // A Node, Bun or Deno launcher runs the harness as its script.
  const program = /^(node|nodejs|bun|deno)$/.test(base(first)) && second ? second : first;
  if (!program) return undefined;
  const name = base(program);
  if (name === "claude" || program.includes("/claude/versions/") || program.includes("@anthropic-ai/claude-code")) return "claude";
  if (name === "codex" || program.includes("@openai/codex")) return "codex";
  if (name === "opencode" || name === ".opencode" || program.includes("opencode-ai")) return "opencode";
  if (name === "copilot" || program.includes("@github/copilot")) return "copilot";
  if (name === "phren-agent") return "phren";
  return undefined;
}

interface Proc { pid: number; pgid: number; tpgid: number; tty: string; args: string }
export function parseProcesses(text: string): Proc[] {
  return text.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), pgid: Number(match[2]), tpgid: Number(match[3]), tty: match[4], args: match[5] }] : [];
  });
}
/** The pane terminal's foreground process group, oldest process first. */
function foreground(processes: Proc[], paneTty: string): Proc[] {
  const tty = paneTty.replace(/^\/dev\//, "");
  return processes.filter(p => (p.tty === tty || `tty${p.tty}` === tty) && p.tpgid > 0 && p.pgid === p.tpgid).sort((a, b) => a.pid - b.pid);
}

const FIELDS = ["session_id", "session_name", "session_attached", "session_activity", "window_id", "window_name", "window_active",
  "pane_id", "pane_pid", "pane_tty", "pane_active", "pane_current_path", "pane_current_command", "@phren_agent", "pane_title"] as const;
type Row = Record<(typeof FIELDS)[number], string>;
const FORMAT = FIELDS.map(field => `#{${field}}`).join("\t");

export function parsePanes(text: string): Row[] {
  return text.split("\n").flatMap(line => {
    const values = line.split("\t");
    if (values.length !== FIELDS.length) return [];
    const row = Object.fromEntries(FIELDS.map((field, index) => [field, values[index]])) as Row;
    return fromTmuxId(row.session_id) && fromTmuxId(row.window_id) && fromTmuxId(row.pane_id) && /^\d+$/.test(row.pane_pid) ? [row] : [];
  });
}

async function listRows(server: string): Promise<Row[]> {
  try { return parsePanes(await tmux(server, ["list-panes", "-a", "-F", FORMAT])); }
  catch (error) {
    // The hidden server starts with the first launch; until then it has no panes.
    if (server === TMUX_HIDDEN && error instanceof BridgeError && error.details?.code === "not_running") return [];
    throw error;
  }
}

const STATUS_RANK = ["blocked", "waiting", "working", "done", "idle"];
/** One tmux server in the shape of the Hook's pane snapshot (the shape
 * Herdr's `session.snapshot` answers): workspaces are tmux sessions, tabs
 * windows, panes panes. */
export async function tmuxSnapshot(server: string): Promise<Json> {
  const rows = await listRows(server);
  const processes = rows.length ? parseProcesses(await deps.processes()) : [];
  const host = hostname(), short = host.split(".")[0];
  const workspaces = new Map<string, Json>(), tabs = new Map<string, Json>();
  const panes: Json[] = [], agents: Json[] = [];
  let focused: Row | undefined;
  for (const row of rows) {
    const workspace = fromTmuxId(row.session_id)!, tab = fromTmuxId(row.window_id)!, pane = fromTmuxId(row.pane_id)!;
    if (!workspaces.has(workspace)) workspaces.set(workspace, { workspace_id: workspace, label: row.session_name });
    const tabKey = `${workspace}\0${tab}`;
    if (!tabs.has(tabKey)) tabs.set(tabKey, { tab_id: tab, workspace_id: workspace, label: row.window_name });
    const running = foreground(processes, row.pane_tty);
    const agent = [row.pane_current_command, ...running.map(p => p.args)].map(agentFromCommand).find(Boolean);
    const terminal = `${pane}:${row.pane_pid}`;
    // Claude and Codex report every turn through their lifecycle hooks; until
    // the first event the status is unknown (a folder-trust screen, say).
    // The other harnesses do not report turns there yet and count as idle.
    const hooked = agent === "claude" || agent === "codex";
    const status = hooked ? await paneStatus(server, pane, terminal) : undefined;
    const name = row["@phren_agent"] || undefined;
    const title = row.pane_title && row.pane_title !== host && row.pane_title !== short ? row.pane_title : undefined;
    panes.push({ pane_id: pane, tab_id: tab, workspace_id: workspace, terminal_id: terminal, cwd: row.pane_current_path || undefined,
      foreground_cwd: row.pane_current_path || undefined, title,
      ...(agent ? { agent, agent_status: status?.status ?? (hooked ? "unknown" : "idle"), ...(status?.seq ? { state_change_seq: status.seq } : {}) } : {}),
      ...(agent && name ? { agent_name: name } : {}) });
    if (agent && name) agents.push({ name, pane_id: pane });
    if (Number(row.session_attached) > 0 && row.window_active === "1" && row.pane_active === "1"
      && (!focused || Number(row.session_activity) > Number(focused.session_activity))) focused = row;
  }
  // A window's status is its most pressing pane's.
  for (const tab of tabs.values()) {
    const statuses = panes.filter(p => p.tab_id === tab.tab_id && p.workspace_id === tab.workspace_id && typeof p.agent_status === "string").map(p => String(p.agent_status));
    const status = STATUS_RANK.find(value => statuses.includes(value)) ?? statuses[0];
    if (status) tab.agent_status = status;
  }
  return { workspaces: [...workspaces.values()], tabs: [...tabs.values()], panes, agents,
    ...(focused ? { focused_workspace_id: fromTmuxId(focused.session_id), focused_tab_id: fromTmuxId(focused.window_id), focused_pane_id: fromTmuxId(focused.pane_id) } : {}) };
}

/** The Hook's key names as tmux key names; undefined for a literal character. */
export function tmuxKey(key: string): string | undefined {
  const named: Record<string, string> = { enter: "Enter", esc: "Escape", escape: "Escape", up: "Up", down: "Down", left: "Left", right: "Right",
    tab: "Tab", space: "Space", backspace: "BSpace", home: "Home", end: "End", pageup: "PPage", pagedown: "NPage" };
  if ([...key].length === 1) return undefined;
  const lower = key.toLowerCase();
  if (named[lower]) return named[lower];
  const modified = /^(alt|ctrl|shift)\+(.+)$/i.exec(key);
  if (modified) {
    const rest = modified[2], inner = [...rest].length === 1 ? rest : tmuxKey(rest);
    if (inner) return `${{ alt: "M-", ctrl: "C-", shift: "S-" }[modified[1].toLowerCase() as "alt" | "ctrl" | "shift"]}${inner}`;
  }
  throw new BridgeError(400, `The key ${key.slice(0, 20)} is not supported in tmux.`);
}

/** send-keys calls for `keys`, in order: named keys together, literal characters with -l. */
export function sendKeysCalls(pane: string, keys: string[]): string[][] {
  const calls: string[][] = [];
  let named: string[] = [], literal = "";
  const flush = () => {
    if (named.length) calls.push(["send-keys", "-t", pane, ...named]);
    if (literal) calls.push(["send-keys", "-t", pane, "-l", "--", literal]);
    named = []; literal = "";
  };
  for (const key of keys) {
    const name = tmuxKey(key);
    if (name === undefined) { if (named.length) flush(); literal += key; }
    else { if (literal) flush(); named.push(name); }
  }
  flush();
  return calls;
}

/** tmux 3.0 and later run a multi-argument command directly, without a shell. */
async function requireDirectExec(): Promise<void> {
  if (!deps.binary()) throw new BridgeError(503, "tmux is not installed on this computer.");
  const match = /(\d+)\.(\d+)/.exec(await deps.version());
  if (!match || Number(match[1]) < 3) throw new BridgeError(409, "Phren needs tmux 3.0 or later to start agents. Update tmux on the computer.");
}

/** The login shell a started agent runs under, and falls back to when it exits. */
function loginShell(): string {
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : (() => { try { return userInfo().shell ?? ""; } catch { return ""; } })();
  // Only a POSIX shell takes the launcher script below.
  return shell && /^(sh|bash|zsh|ksh|dash)$/.test(path.basename(shell)) && existsSync(shell) ? shell : "/bin/sh";
}

/** A session name tmux accepts: no "." or ":" and nothing unprintable. */
function sessionName(label: string | undefined, taken: Set<string>): string {
  const base = (label ?? "phren").replace(/[.:\x00-\x1f\x7f]/g, "_").trim().slice(0, 60) || "phren";
  let name = base;
  for (let n = 2; taken.has(name) && n < 1000; n++) name = `${base}-${n}`;
  return name;
}

async function paneRow(server: string, pane: string): Promise<Row | undefined> {
  return parsePanes(await tmux(server, ["list-panes", "-a", "-F", FORMAT])).find(row => row.pane_id === pane);
}

export const tmuxTerminal: TerminalProvider = {
  kind: "tmux",
  async ping(server) {
    if (!deps.binary()) throw new BridgeError(503, "tmux is not installed on this computer.");
    // The hidden server answers even before it has started: a launch starts it.
    if (server !== TMUX_HIDDEN) await tmux(server, ["list-sessions", "-F", "#{session_id}"], { timeoutMs: 3_000 });
  },
  snapshot: tmuxSnapshot,
  async listPanes(server): Promise<TerminalPane[]> { return herdrPanes(server, await tmuxSnapshot(server)); },
  async processes(server, pane) {
    const row = await paneRow(server, toTmuxId(pane, "p"));
    if (!row) throw new BridgeError(409, "This tmux pane changed. Refresh the computer.");
    return { shellPid: Number(row.pane_pid), foregroundPids: foreground(parseProcesses(await deps.processes()), row.pane_tty).map(p => p.pid) };
  },
  async readScreen(server, pane, read) {
    const lines = Math.max(1, Math.min(10_000, Math.floor(read.lines)));
    const args = ["capture-pane", "-p", "-t", toTmuxId(pane, "p"), ...(read.stripAnsi === false || read.format === "ansi" ? ["-e"] : []),
      ...(read.source === "recent" ? ["-S", `-${lines}`] : [])];
    const text = (await tmux(server, args, { timeoutMs: read.timeoutMs })).replace(/\n$/, "").split("\n");
    // A screen's unused rows come back blank; the readers want its last drawn lines.
    while (text.length && !text.at(-1)!.replace(/\x1b\[[0-9;]*m/g, "").trim()) text.pop();
    return text.slice(-lines).join("\n");
  },
  async sendKeys(server, pane, keys) {
    const target = toTmuxId(pane, "p");
    for (const call of sendKeysCalls(target, keys)) await tmux(server, call);
  },
  async prompt(server, pane, text, signal) {
    const target = toTmuxId(pane, "p"), buffer = `phren-${process.pid}-${Date.now().toString(36)}`;
    // The text reaches tmux on stdin and the pane as one bracketed paste
    // (-p), newlines kept (-r), then Enter submits it.
    await tmux(server, ["load-buffer", "-b", buffer, "-"], { input: text, signal });
    await tmux(server, ["paste-buffer", "-d", "-p", "-r", "-b", buffer, "-t", target], { signal });
    await deps.sleep(150, signal);
    await tmux(server, ["send-keys", "-t", target, "Enter"], { signal });
  },
  async create(server, { workspace, label, cwd }) {
    const directory = cwd && path.isAbsolute(cwd) ? ["-c", cwd] : [];
    const name = label ? ["-n", label.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 100)] : [];
    if (workspace) { await tmux(server, ["new-window", "-d", "-t", `${toTmuxId(workspace, "s")}:`, ...directory, ...name]); return; }
    const taken = new Set((await tmux(server, ["list-sessions", "-F", "#{session_name}"]).catch(() => "")).split("\n").filter(Boolean));
    await tmux(server, ["new-session", "-d", "-s", sessionName(label, taken), "-x", "200", "-y", "50", ...directory, ...name]);
  },
  async startAgent(server, pane, { name, kind, args, timeoutMs }) {
    if (!["claude", "codex", "copilot", "opencode"].includes(kind)) throw new BridgeError(400, "This agent cannot be started in tmux.");
    await requireDirectExec();
    const target = toTmuxId(pane, "p"), row = await paneRow(server, target);
    if (!row) throw new BridgeError(409, "This tmux pane changed. Refresh the computer.");
    // The name marks the pane for the phone (a conductor, a scheduled run).
    await tmux(server, ["set-option", "-p", "-t", target, "@phren_agent", name]).catch(() => undefined);
    // The harness runs under a login shell, so it gets the owner's PATH, and
    // the pane falls back to that shell when it exits. The harness and its
    // arguments are the script's positional parameters, never script text.
    const shell = loginShell();
    await tmux(server, ["respawn-pane", "-k", "-t", target, ...(row.pane_current_path ? ["-c", row.pane_current_path] : []),
      "--", shell, "-l", "-c", 'shell="$1"; shift; "$@"; exec "$shell" -l', "phren", shell, kind, ...args]);
    // Started once the harness is the pane's foreground program.
    const deadline = Date.now() + Math.min(timeoutMs, 30_000);
    for (;;) {
      const snapshot = await tmuxSnapshot(server);
      const current = objects(snapshot.panes).find(p => p.pane_id === pane);
      if (!current) throw new BridgeError(409, `tmux closed the pane before ${kind} started.`);
      if (current.agent === kind) return;
      if (Date.now() >= deadline) throw new BridgeError(504, `${kind} did not start in the tmux pane. Check that it is installed and on the login shell's PATH.`);
      await deps.sleep(250);
    }
  },
  async focusPane(server, pane) {
    const target = toTmuxId(pane, "p");
    await tmux(server, ["select-window", "-t", target]);
    await tmux(server, ["select-pane", "-t", target]);
  },
  async groupAction(server, operation, { workspace, tab }, label) {
    if (tab) {
      const target = toTmuxId(tab, "w");
      if (operation === "focus") await tmux(server, ["select-window", "-t", target]);
      else if (operation === "rename") await tmux(server, ["rename-window", "-t", target, (label ?? "").replace(/[\x00-\x1f\x7f]/g, " ")]);
      else await tmux(server, ["kill-window", "-t", target]);
      return;
    }
    if (!workspace) throw new BridgeError(400, "Choose a tmux session.");
    const target = toTmuxId(workspace, "s");
    // A session has no focus of its own without an attached client.
    if (operation === "focus") return;
    if (operation === "rename") await tmux(server, ["rename-session", "-t", target, sessionName(label, new Set())]);
    else await tmux(server, ["kill-session", "-t", target]);
  },
};

/** The tmux servers the Hook drives, as `/v1/muxes` lists servers: the owner's
 * default server while it runs, and the hidden server whenever tmux is
 * installed (a launch starts it). `kind` stays "herdr", the phone's name for
 * the Hook's session protocol; `terminal` names the multiplexer. */
export async function tmuxServers(): Promise<Json[]> {
  if (!deps.binary()) return [];
  const running = await tmuxTerminal.ping(TMUX_DEFAULT).then(() => true, () => false);
  return [...(running ? [TMUX_DEFAULT] : []), TMUX_HIDDEN].map(name => ({ id: `tmux:${name}`, kind: "herdr", terminal: "tmux", session: name, running: true }));
}

/** The tmux pane this process runs in, from the variables tmux sets in every
 * pane, with its session and window asked of that server. */
export async function tmuxPaneFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<{ server: string; workspace: string; tab: string; pane: string } | undefined> {
  const socket = env.TMUX?.split(",")[0], pane = env.TMUX_PANE;
  if (!socket || !path.isAbsolute(socket) || !pane || !fromTmuxId(pane)) return undefined;
  const server = tmuxServerName(path.basename(socket));
  if (!server) return undefined;
  try {
    const [session, window] = (await deps.run(path.basename(socket), ["display-message", "-p", "-t", pane, "#{session_id}\t#{window_id}"], { timeoutMs: 1_500 })).trim().split("\t");
    const workspace = fromTmuxId(session ?? ""), tab = fromTmuxId(window ?? "");
    return workspace && tab ? { server, workspace, tab, pane: fromTmuxId(pane)! } : undefined;
  } catch { return undefined; }
}

/** The command that attaches the phone's SSH terminal to a tmux server. */
export function tmuxAttach(server: string): { file: string; args: string[] } {
  const binary = deps.binary();
  if (!binary) throw new BridgeError(503, "tmux is not installed on this computer.");
  return { file: binary, args: ["-L", socketOf(server), "attach-session"] };
}

/** For tests: forget the tmux executable lookup. */
export function resetTmuxBinary(): void { cachedBinary = undefined; }

