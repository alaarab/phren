import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { intervalFromEnv } from "./limits.js";
import {
  freePort, listPaneServers, newPassword, type OpenCodePermission, type OpenCodeQuestion, openPaneClient, type PaneClient,
  type PaneServerEntry, PromptNotSent, type PromptOptions, readPaneServer, registerPaneServer, removePaneServer,
} from "./opencode-pane-server.js";
import { bridgeRoot } from "./protocol.js";
import { terminalProvider } from "./terminal.js";

/**
 * OpenCode panes the Hook starts serve their own HTTP API: the TUI runs as
 * `OPENCODE_SERVER_PASSWORD=<pw> opencode --port <port>`, and the Hook drives
 * the session the TUI shows over that API instead of typing into it. The pane
 * stays the owner's live view. A registry entry per pane
 * (`<bridge>/opencode-panes/`, 0600 files in a 0700 folder) holds the port,
 * password, process id and directory; a pane with no entry (one the owner
 * started by hand) keeps the typed path.
 */

const exec = promisify(execFile);

/** Set in a served pane's environment: the port its TUI listens on. The
 * OpenCode plugin leaves permission asks to the Hook's HTTP client when its
 * own process was started with this port. */
export const PANE_PORT_ENV = "PHREN_OPENCODE_PORT";
const PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD";
/** How long a served TUI may take to answer its first request after Herdr
 * reports the agent ready. */
const READY_MS = 20_000;
/** The terminal reports the agent started once its process runs, so a
 * process carrying the port shows up at once; with none (a wrapper that
 * dropped the flag), the pane keeps the typed path without a long wait. */
const PID_MS = intervalFromEnv("PHREN_OPENCODE_PID_MS", 2_000);
const BRIEF_CONFIRM_MS = 10_000;

export function paneServersDir(): string { return path.join(bridgeRoot(), "opencode-panes"); }

/** The live server entry for a pane, if the Hook started its OpenCode. */
export function servedPane(server: string, pane: string): PaneServerEntry | undefined {
  return readPaneServer(paneServersDir(), server, pane);
}

export function servedPanes(): PaneServerEntry[] { return listPaneServers(paneServersDir()); }

export function forgetServedPane(server: string, pane: string): void { removePaneServer(paneServersDir(), server, pane); }

let clientFactory: (entry: PaneServerEntry) => PaneClient = entry => openPaneClient(entry);
export function paneClient(entry: PaneServerEntry): PaneClient { return clientFactory(entry); }
/** For tests: build clients against a fake server; returns the restore. */
export function setPaneClientFactory(factory: (entry: PaneServerEntry) => PaneClient): () => void {
  const previous = clientFactory;
  clientFactory = factory;
  return () => { clientFactory = previous; };
}

export interface ServedLaunch { port: number; password: string; args: string[]; env: Record<string, string> }

/** The port, password, extra arguments and pane variables for one launch. */
export async function prepareServedLaunch(): Promise<ServedLaunch> {
  const port = await freePort(), password = newPassword();
  return { port, password, args: ["--port", String(port)], env: { [PASSWORD_ENV]: password, [PANE_PORT_ENV]: String(port) } };
}

/** `--port N` or `--port=N` in a command line. */
export function listensOn(command: string, port: number): boolean {
  return new RegExp(`(?:^|\\s)--port(?:\\s+|=)${port}(?:\\s|$)`).test(command) && /opencode/.test(command);
}

async function processTable(): Promise<Array<{ pid: number; command: string }>> {
  const { stdout } = await exec("ps", ["-Aww", "-o", "pid=,command="], { timeout: 3_000, maxBuffer: 8_388_608 });
  return String(stdout).split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });
}

/** The OpenCode process serving `port` in the pane: a foreground process of
 * the pane whose command line carries that port, else any process that does
 * (a launcher shim can hold the pane's foreground). The newest wins, which is
 * the real binary under a shim. */
export async function servingPid(server: string, pane: string, port: number, table = processTable): Promise<number | undefined> {
  const foreground = await terminalProvider().processes(server, pane).then(value => value.foregroundPids, () => [] as number[]);
  const rows = (await table().catch(() => [])).filter(row => row.pid > 0 && listensOn(row.command, port));
  const own = rows.filter(row => foreground.includes(row.pid));
  const pool = own.length ? own : rows;
  return pool.length ? Math.max(...pool.map(row => row.pid)) : undefined;
}

/**
 * Registers a pane whose OpenCode the Hook just started with `launch`, once
 * its server answers. Undefined when it never did: the pane then keeps the
 * typed path, exactly like one started by hand.
 */
export async function registerServedPane(server: string, pane: string, directory: string, launch: ServedLaunch,
  options: { readyMs?: number; defaults?: PaneServerEntry["defaults"]; table?: () => Promise<Array<{ pid: number; command: string }>> } = {}): Promise<PaneServerEntry | undefined> {
  const started = Date.now(), deadline = started + (options.readyMs ?? READY_MS);
  let pid: number | undefined;
  for (;;) {
    pid ??= await servingPid(server, pane, launch.port, options.table).catch(() => undefined);
    if (!pid && Date.now() - started >= Math.min(PID_MS, options.readyMs ?? PID_MS)) return undefined;
    const entry: PaneServerEntry | undefined = pid ? { server, pane, port: launch.port, password: launch.password, pid, directory,
      createdAt: new Date().toISOString(), ...(options.defaults && Object.keys(options.defaults).length ? { defaults: options.defaults } : {}) } : undefined;
    if (entry && await paneClient(entry).ready()) {
      registerPaneServer(paneServersDir(), entry);
      return entry;
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/** The session the Hook last created and showed in each served pane, by
 * pane and process. */
const shownSessions = new Map<string, string>();

export type ServedPrompt =
  | { sent: false; reason: string }
  | { sent: true; delivered: boolean; session: string };

/** Whether the pane draws the start of `text`: a sent prompt's user turn. */
async function paneShows(server: string, pane: string, text: string): Promise<boolean> {
  const needle = (text.trim().split("\n")[0] ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
  if (!needle) return true;
  const screen = await terminalProvider().readScreen(server, pane, { scope: "pane", source: "visible", lines: 200, stripAnsi: true }).catch(() => "");
  return screen.replace(/\s+/g, " ").includes(needle);
}

/** How long to keep moving a just-started TUI onto a new session. */
const SHOW_MS = 10_000;

/**
 * Moves the TUI onto `session`, whose first turn is `text`. A TUI that has
 * only just started answers HTTP before it listens for its own navigation
 * events and drops the first request (seen live on 1.18.31), so the request
 * is repeated until the pane draws that turn. False when it never did: the
 * conversation is still real, only not on screen.
 */
export async function showSession(entry: PaneServerEntry, client: PaneClient, session: string, text: string,
  options: { timeoutMs?: number; intervalMs?: number; shows?: (text: string) => Promise<boolean> } = {}): Promise<boolean> {
  const shows = options.shows ?? (value => paneShows(entry.server, entry.pane, value));
  const deadline = Date.now() + (options.timeoutMs ?? SHOW_MS);
  for (;;) {
    await client.selectSession(session).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, options.intervalMs ?? 500));
    if (await shows(text)) return true;
    if (Date.now() >= deadline) return false;
  }
}

/**
 * Sends `text` into the session a served TUI shows. `session` is the
 * conversation the phone means and must be a root session of this server; with
 * none (a TUI still on its home screen) a new session is created, and once the
 * prompt is in, the TUI is moved onto it so the owner sees it there.
 * `sent: false` means nothing reached OpenCode, so the caller may type it.
 */
export async function sendServedPrompt(entry: PaneServerEntry, session: string | undefined, text: string,
  options: PromptOptions = {}): Promise<ServedPrompt> {
  const client = paneClient(entry);
  const shownKey = `${paneKey(entry)}\u0000${entry.pid}`;
  // A pane whose conversation the terminal cannot name yet (no Herdr
  // integration, no plugin record) keeps the session the Hook last showed
  // there, rather than starting a new one for every message.
  const shown = session ? undefined : shownSessions.get(shownKey);
  let id = session ?? shown;
  try {
    if (id) {
      const known = await client.session(id);
      if (!known || known.parentID) {
        if (!shown) return { sent: false, reason: "This conversation is not a root session of the pane's OpenCode." };
        shownSessions.delete(shownKey);
        id = (await client.createSession()).id;
      }
    } else id = (await client.createSession()).id;
  } catch (error) { return { sent: false, reason: (error as Error).message }; }
  const fresh = !session && id !== shown;
  if (!session) {
    shownSessions.set(shownKey, id);
    while (shownSessions.size > 64) shownSessions.delete(shownSessions.keys().next().value!);
  }
  // A continuing conversation keeps the agent and model of its last turn;
  // a new one takes what the TUI was started with.
  const defaults = entry.defaults ?? {};
  const settings: PromptOptions = !fresh ? { inherit: true, ...options }
    : { ...(defaults.agent ? { agent: defaults.agent } : {}), ...(defaults.model ? { model: defaults.model } : {}),
      ...(defaults.variant ? { variant: defaults.variant } : {}), ...options };
  let delivered: boolean;
  try { delivered = (await client.prompt(id, text, settings)).delivered; } catch (error) {
    if (error instanceof PromptNotSent) return { sent: false, reason: error.message };
    delivered = false;
  }
  if (fresh) await showSession(entry, client, id, text).catch(() => false);
  return { sent: true, delivered, session: id };
}

/** A launch brief sent over HTTP: into a new session the TUI shows. */
export async function sendServedBrief(entry: PaneServerEntry, text: string, options: PromptOptions = {}): Promise<ServedPrompt> {
  return sendServedPrompt(entry, undefined, text, { timeoutMs: BRIEF_CONFIRM_MS, ...options });
}

/** The root of a (possibly subagent) session: the conversation the pane shows. */
export async function rootSession(client: PaneClient, session: string): Promise<string> {
  let current = session;
  for (let depth = 0; depth < 8; depth++) {
    const info = await client.session(current).catch(() => undefined);
    if (!info?.parentID) return current;
    current = info.parentID;
  }
  return current;
}

export interface PaneAsks { permissions: OpenCodePermission[]; questions: OpenCodeQuestion[] }

/** Where the watcher reports what each served pane is asking. `asks` is the
 * whole current set for that pane; `gone` means the pane's entry is gone. */
export interface PaneAskSink {
  asks(entry: PaneServerEntry, client: PaneClient, asks: PaneAsks): Promise<void>;
  gone(key: string): void;
}

const ASK_EVENTS = new Set(["permission.asked", "permission.replied", "permission.updated", "question.asked", "question.replied", "question.rejected"]);
const MAX_BACKOFF_MS = 30_000;
export const paneKey = (entry: { server: string; pane: string }) => `${entry.server}\u0000${entry.pane}`;

/**
 * One event subscription per served pane. On every (re)connect and on each
 * permission or question event it lists the pane's pending asks and hands the
 * whole set to the sink, so an ask answered in the TUI disappears too. A
 * dropped stream reconnects with backoff; `tick` stops panes whose entry is
 * gone (the process exited) and starts new ones.
 */
export class PaneServerWatcher {
  private live = new Map<string, { entry: PaneServerEntry; abort: AbortController; refresh?: () => Promise<void> }>();
  private closed = false;
  constructor(private sink: PaneAskSink, private list: () => PaneServerEntry[] = servedPanes, private minBackoffMs = 1_000) {}
  tick(): void {
    if (this.closed) return;
    const current = new Map(this.list().map(entry => [paneKey(entry), entry]));
    for (const [key, running] of this.live) {
      const entry = current.get(key);
      // A live pane is listed again each tick, so an ask it still has keeps
      // its card however long it waits with no event.
      if (entry && entry.pid === running.entry.pid && entry.port === running.entry.port) { void running.refresh?.().catch(() => {}); continue; }
      running.abort.abort(); this.live.delete(key); this.sink.gone(key);
    }
    for (const [key, entry] of current) {
      if (this.live.has(key)) continue;
      const abort = new AbortController();
      this.live.set(key, { entry, abort });
      void this.follow(entry, abort.signal);
    }
  }
  watching(): string[] { return [...this.live.keys()]; }
  close(): void {
    this.closed = true;
    for (const running of this.live.values()) running.abort.abort();
    this.live.clear();
  }
  private async follow(entry: PaneServerEntry, signal: AbortSignal): Promise<void> {
    const client = paneClient(entry);
    let backoff = this.minBackoffMs;
    let refreshing: Promise<void> | undefined, again = false;
    const refresh = (): Promise<void> => {
      if (refreshing) { again = true; return refreshing; }
      refreshing = (async () => {
        do {
          again = false;
          const [permissions, questions] = await Promise.all([client.permissions(), client.questions()]);
          if (!signal.aborted) await this.sink.asks(entry, client, { permissions, questions });
        } while (again && !signal.aborted);
      })().finally(() => { refreshing = undefined; });
      return refreshing;
    };
    const running = this.live.get(paneKey(entry));
    if (running?.entry === entry) running.refresh = refresh;
    while (!signal.aborted) {
      try {
        // The list is read once the stream is open (its first event), so an
        // ask raised in between is never missed.
        let first = true;
        for await (const event of client.events(signal)) {
          if (signal.aborted) break;
          if (first) backoff = this.minBackoffMs;
          if (first || ASK_EVENTS.has(event.type)) await refresh().catch(() => {});
          first = false;
        }
      } catch { /* the stream dropped or the server is not answering yet */ }
      if (signal.aborted) break;
      await new Promise(resolve => { const timer = setTimeout(resolve, backoff); timer.unref?.(); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(undefined); }, { once: true }); });
      backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
    }
  }
}
