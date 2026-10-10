// Shared contract for the Phren desktop phase 0 spike.
// Design: docs/desktop/DESIGN.md (PR #367). Every module in src/ implements
// exactly the exports declared for it here and imports types only from here.
// Do not change this file; ask the orchestrator.

import type { Duplex } from "node:stream";

/** One computer this desktop can reach. `local` means this machine: talk to
 * its Hook over the Unix socket, never over SSH. */
export interface Computer {
  /** Stable display name: hooks.yaml `name`, or "This computer" for local. */
  name: string;
  local: boolean;
  /** SSH fields, absent when local. */
  address?: string;
  username?: string;
  port?: number;
  /** Pinned host key, "ssh-ed25519 AAAA…" (hooks.yaml `hostKey`). */
  hostKey?: string;
  /** Default Herdr or tmux server name on that computer (hooks.yaml `server`, default "default"). */
  server: string;
  /** Private key ssh uses for this computer: `<bridge>/id_ed25519_desktop` for
   * computers in desktop.yaml, `<bridge>/id_ed25519_dispatch` for the hooks.yaml
   * fallback. Absent when local. */
  keyFile?: string;
}

/** A Hook pane target, exactly the Hook's `targetSchema` (protocol.ts). */
export interface Target {
  server: string;
  workspace: string;
  tab: string;
  pane: string;
  source: "codex" | "claude" | "copilot" | "phren" | "opencode";
  session: string;
}

/** One session row from a Hook overview: `groups[].children[]` of
 * `GET /v1/workspaces` or a `{type:"overview"}` frame of `WS /v1/overview`. */
export interface OverviewChild {
  id: string;
  label: string;
  title?: string;
  agent?: string;
  /** "working" | "idle" | "blocked" | "waiting" | "done" | "unknown" */
  agentStatus?: string;
  cwd?: string;
  lastChangedAt?: string;
  branch?: string;
  model?: string;
  approvalPending?: boolean;
  target?: Target;
  [key: string]: unknown;
}
export interface OverviewGroup { id: string; label: string; children: OverviewChild[] }
export interface HookOverview {
  kind?: string;
  groups: OverviewGroup[];
  mux?: { id: string; kind: string; session: string };
  phren?: { computer?: { id: string; name: string }; version?: string; capabilities?: Record<string, unknown> };
  [key: string]: unknown;
}

/** Per-computer connection state, the phone's vocabulary. */
export type ComputerState = "connecting" | "online" | "offline" | "verify";
export interface ComputerOverview {
  computer: string;            // Computer.name
  state: ComputerState;
  /** Hook error `code` or a short message when offline. */
  error?: string;
  /** Last overview received; kept (stale) while offline. */
  overview?: HookOverview;
  updatedAt?: string;          // ISO time of the last overview frame
}

/** The merged view the UI renders. */
export interface MergedOverview { computers: ComputerOverview[] }

// ---------------------------------------------------------------- hosts.ts
/** Return the local computer first, then each linked computer from
 * `<bridge>/desktop.yaml` (keyFile = the desktop key). When desktop.yaml does
 * not exist, fall back to `<bridge>/hooks.yaml` with the dispatch key (phase 0
 * spike). Neither file: local only. */
export type LoadComputers = () => Promise<Computer[]>;
/** OpenSSH argv (without the leading "ssh") to run `remoteCommand` on `c`:
 * ControlMaster=auto, ControlPersist=60, ControlPath in a short private dir
 * (`/tmp/phren-desktop-<uid>/<keyHash8>-<slot>-%C`; macOS caps socket paths at
 * 104 bytes), a temp known_hosts file holding only c.hostKey,
 * StrictHostKeyChecking=yes, HostKeyAlgorithms=ssh-ed25519,
 * IdentityFile=c.keyFile, IdentitiesOnly=yes, BatchMode=yes,
 * ForwardAgent=no, ClearAllForwardings=yes, ConnectTimeout=10,
 * ServerAliveInterval=15, ServerAliveCountMax=3, -p port, user@address.
 * `tty` adds "-tt"; `slot` picks one of the pool's master sockets (default 0). */
export type SshArgs = (c: Computer, remoteCommand: string, opts?: { tty?: boolean; slot?: number }) => string[];

// ---------------------------------------------------------------- hook-client.ts
/** Open a raw byte pipe to computer c's Hook: local = net.connect(hook.sock);
 * remote = spawn("ssh", sshArgs(c, "phren-hook v1 pipe")) with stdio as a Duplex.
 * One pipe carries exactly one HTTP request or one WebSocket. */
export type OpenHookPipe = (c: Computer) => Promise<Duplex>;
export interface HookResponse { status: number; headers: Record<string, string>; body: Buffer }
/** One HTTP/1.1 request over a fresh pipe: Host: phren.local, Connection: close,
 * Content-Type application/json when body is set. 60 s timeout. */
export type HookRequest = (c: Computer, method: string, path: string, body?: unknown) => Promise<HookResponse>;
/** A `ws` WebSocket client over a fresh pipe (use the `createConnection` option
 * to return the pipe; url `ws://phren.local<path>`, perMessageDeflate:false). */
export type HookWebSocket = (c: Computer, path: string) => Promise<import("ws").WebSocket>;

// ---------------------------------------------------------------- overview.ts
/** Holds one `WS /v1/overview` per computer, reconnecting with jittered backoff
 * (1 s doubling to 60 s), and merges them. Emits "change" with MergedOverview. */
export interface OverviewHub {
  start(): void;
  stop(): void;
  current(): MergedOverview;
  /** Reconcile to a new computer list: drop supervisors for removed computers,
   * add new ones, and restart any whose SSH identity changed (so a computer in
   * the "verify" state retries after a relink). */
  setComputers(computers: Computer[]): void;
  on(event: "change", listener: (merged: MergedOverview) => void): void;
}
export type CreateOverviewHub = (computers: Computer[], ws: HookWebSocket) => OverviewHub;

// ---------------------------------------------------------------- pty-bridge.ts
/** A live terminal. Mirrors node-pty's IPty surface the server needs. */
export interface TerminalSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}
/** Attach a terminal to multiplexer `server` on computer c.
 * Remote: node-pty spawn "ssh" with sshArgs(c, `phren-hook v1 terminal ${server}`, {tty:true}).
 * Local: herdr → `herdr session attach <server>`; a server named `tmux` → `tmux attach`;
 * `tmux-<name>` → `tmux -L <name> attach`. TERM=xterm-256color. */
export type AttachTerminal = (c: Computer, server: string, cols: number, rows: number, pane?: string) => TerminalSession;

// ---------------------------------------------------------------- server.ts
/** HTTP + WS server bound to 127.0.0.1:<port> (0 = any free port). Every request
 * needs the token: `?token=` on the first page load (then an HttpOnly cookie
 * `phren_desktop`), or the cookie. Routes:
 *   GET  /                      → ui/index.html (static files from ../ui and
 *                                  /vendor/xterm/* from node_modules/@xterm/*)
 *   GET  /api/computers         → Computer[] without hostKey
 *   GET  /api/overview          → MergedOverview
 *   WS   /api/overview          → pushes {type:"overview", merged} on every change
 *   ANY  /hosts/<name>/v1/...   → proxied with hookRequest (method, path+query, JSON body)
 *   WS   /hosts/<name>/v1/...   → proxied with hookWebSocket, frames passed both ways
 *   WS   /pty?computer=&server=&cols=&rows= → attachTerminal; client→server text
 *        frames are input except JSON {"type":"resize","cols","rows"}; server→client
 *        frames are terminal output text. */
export interface DesktopServerOptions {
  port: number;
  token: string;
  computers: Computer[];
  hub: OverviewHub;
  hookRequest: HookRequest;
  hookWebSocket: HookWebSocket;
  attachTerminal: AttachTerminal;
}
export type StartServer = (o: DesktopServerOptions) => Promise<{ url: string; close(): Promise<void> }>;

// ---------------------------------------------------------------- keys.ts
/** The desktop's own identity: `<bridge>/id_ed25519_desktop`, comment
 * `phren-desktop:<this computer>`, enrolled on each computer like a peer and
 * revocable on its own. desktop.yaml has the hooks.yaml schema:
 * `{version: 1, computers: [{name, address, username, port, hostKey, server}]}`, mode 0600. */
export interface LinkOptions {
  /** What this desktop calls the computer (default: the ssh host argument). Must match /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/. */
  name?: string;
  /** Multiplexer server to attach by default (default "default"). */
  server?: string;
}
/** Create the key if missing (ssh-keygen -t ed25519 -N ""), return the public
 * key and the restricted authorized_keys line:
 * `restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch" ssh-ed25519 AAAA… phren-desktop:<this computer>`. */
export type EnrollDesktop = () => Promise<{ publicKey: string; line: string; comment: string }>;
/** Link one computer over the owner's own ssh login to `host` (an ssh config
 * alias or user@host): resolve address, user and port with `ssh -G`; over
 * `ssh -o BatchMode=yes host` install the line in ~/.ssh/authorized_keys
 * (idempotent) and read sshd's ssh_host_ed25519_key.pub (/etc/ssh, /usr/etc/ssh, …); refuse when the
 * Hook is not installed there; write the computer to desktop.yaml; then
 * verify with GET /v1/health over the new key. Returns the linked Computer. */
export type LinkComputer = (host: string, options?: LinkOptions) => Promise<Computer>;
/** Remove this desktop's line from that computer's authorized_keys over the
 * owner's ssh login, drop it from desktop.yaml, delete its pinned known_hosts.
 * `{remote: false}` when the computer could not be reached (local entry still removed). */
export type RevokeComputer = (name: string) => Promise<{ remote: boolean }>;
