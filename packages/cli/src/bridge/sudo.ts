import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readlinkSync } from "node:fs";
import { open, readdir, readFile, readlink, unlink } from "node:fs/promises";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { userInfo } from "node:os";
import { atomic, bridgeRoot, object, type Json } from "./protocol.js";
import { localSocket } from "./agent-hook-stores.js";
import { intervalFromEnv } from "./limits.js";
import { terminalPaneFromEnv } from "./terminal.js";
import { briefId } from "./launch-brief.js";

/**
 * sudo with no terminal, answered from the phone.
 *
 * `sudo -A` runs `SUDO_ASKPASS` (`<bridge>/askpass`, a two-line script the
 * Hook installs) with its prompt as the argument and reads the password from
 * its stdout. The script runs the bundle's `askpass`, which asks the Hook over
 * agent.sock and holds the connection. The password must reach sudo and no
 * one else, so before asking the phone the Hook checks the whole chain
 * (`verifyAsker`): the asker is this Hook's node running its bundle with no
 * flags, its parent is the installed script, that script's parent is a sudo
 * running as root (euid 0, which no process of the owner's can fake), and the
 * asker's stdout is a pipe no other process of the owner's reads. The
 * connection is bound to that process too: on macOS its other end must be
 * held by the asker alone; on Linux the Hook writes the password straight into
 * the asker's stdout (`/proc/<pid>/fd/1`), so a connection that names another
 * process's pid gets nothing. It reads
 * that sudo's command line itself and pushes the request to the phone; `GET /v1/sudo` and the overview socket's `sudo` frame
 * list it. `POST /v1/sudo/answer` writes the password into the held
 * connection and forgets the request: the password is never logged, stored,
 * or kept past that write. Deny, a timeout, no reachable phone, or the asker
 * going away ends the request, and askpass exits non-zero, so sudo fails.
 */

export const SUDO_HOLD_MS = intervalFromEnv("PHREN_SUDO_TIMEOUT_MS", 120_000, 1_000, 600_000);
/** Held askpass requests at once; more are refused. */
export const MAX_SUDO_PENDING = 8;
/** How long after a password is handed over the Hook waits to see whether
 * sudo asks again, before calling it accepted. */
export const SUDO_OUTCOME_MS = intervalFromEnv("PHREN_SUDO_OUTCOME_MS", 6_000, 100, 30_000);
/** sudo's default `passwd_tries`: after the last one it gives up instead of asking again. */
const SUDO_TRIES = 3;
export type SudoOutcome = "accepted" | "rejected" | "unknown";
export const ASKPASS_FILE = "askpass";
export const askpassPath = () => path.join(bridgeRoot(), ASKPASS_FILE);
export const askpassInstalled = () => existsSync(askpassPath());
/** SUDO_ASKPASS for a launch, when this computer's Hook installed its helper. */
export const askpassEnv = (): Record<string, string> => askpassInstalled() ? { SUDO_ASKPASS: askpassPath() } : {};

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** sudo runs SUDO_ASKPASS with no arguments of its own, so the helper is a
 * script: the node that installed the Hook, the current bundle, `askpass`.
 * It stays node's parent (no exec) so the Hook can see it in the chain, and
 * drops what would load other code into node. */
export function askpassScript(node: string, bundle: string): string {
  return `#!/bin/sh\n# Installed by Phren Hook: sudo -A asks the phone for the password.\n`
    + `unset NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH\n${quote(node)} ${quote(bundle)} askpass "$@"\n`;
}
export async function installAskpass(node: string, bundle: string): Promise<void> {
  await atomic(askpassPath(), askpassScript(node, bundle), 0o700);
}
export async function removeAskpass(): Promise<void> { await unlink(askpassPath()).catch(() => {}); }

export interface SudoSession { source?: string; label?: string; server?: string; workspace?: string; tab?: string; pane?: string }
/** What the phone sees. Never carries a password. */
export interface SudoRequestView {
  /** `account` is whose password sudo asks for (the invoking user); `user` is who the command runs as. */
  id: string; computer: string; command: string; account?: string; user?: string; cwd?: string; session?: SudoSession;
  askedAt: string; expiresAt: string;
}
/** What askpass gets: the password to print, word that the Hook wrote it into
 * askpass's stdout itself (Linux), or why not. */
export type SudoReply = { password: string } | { delivered: true } | { error: string; status: number };

/** sudo's options that take a value, short and long. */
const VALUE_FLAGS = new Set(["-u", "-g", "-p", "-C", "-D", "-h", "-r", "-t", "-T", "-U", "-c", "-R",
  "--user", "--group", "--prompt", "--close-from", "--chdir", "--host", "--role", "--type", "--command-timeout", "--other-user", "--login-class", "--chroot"]);
const SHORT_VALUE = new Set([..."ugpCDhrtTUcR"]);

/** The command a sudo process will run, without sudo's own options, and the
 * user it runs as. Falls back to the whole line when there is no command
 * (`sudo -v`, `sudo -s`). */
export function sudoCommand(argv: string[]): { command: string; user?: string } {
  let user: string | undefined, index = 1;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--") { index++; break; }
    if (!arg.startsWith("-") || arg === "-") break;
    if (arg.startsWith("--")) {
      const [name, inline] = arg.split("=", 2);
      const value = inline ?? (VALUE_FLAGS.has(name) ? argv[++index] : undefined);
      if (name === "--user" && value) user = value;
      index++; continue;
    }
    // Clustered short flags: -Au root, -uroot, -nA.
    for (let at = 1; at < arg.length; at++) {
      const flag = arg[at];
      if (!SHORT_VALUE.has(flag)) continue;
      const value = at + 1 < arg.length ? arg.slice(at + 1) : argv[++index];
      if (flag === "u" && value) user = value;
      break;
    }
    index++;
  }
  const rest = argv.slice(index).join(" ").trim();
  const command = (rest || argv.join(" ")).slice(0, 2_000);
  return { command, ...(user ? { user: user.slice(0, 64) } : {}) };
}

export interface ProcessRecord {
  ppid: number;
  /** Effective user id. */
  euid: number;
  /** Executable name (`comm`). */
  name: string;
  /** Arguments, split on NULs on Linux and on spaces on macOS. */
  argv: string[];
  /** The whole command line as ps prints it. */
  line: string;
  /** Environment names, where the platform shows them (Linux). */
  env?: string[];
  /** When it started (procfs start ticks on Linux, `ps -o lstart` elsewhere), to distinguish a recycled pid. */
  started?: string;
}
const exec = promisify(execFile);
/** One process's parent, effective uid, name and arguments. */
export async function readProcess(pid: number): Promise<ProcessRecord | undefined> {
  if (!Number.isInteger(pid) || pid <= 1) return undefined;
  try {
    if (process.platform === "linux") {
      const base = `/proc/${pid}`;
      const [status, stat, cmdline, env] = await Promise.all([
        readFile(`${base}/status`, "utf8"),
        readFile(`${base}/stat`, "utf8"),
        readFile(`${base}/cmdline`, "utf8"),
        readFile(`${base}/environ`, "utf8").catch(() => undefined),
      ]);
      const ppid = /^PPid:\s+(\d+)$/m.exec(status)?.[1];
      const euid = /^Uid:\s+\d+\s+(\d+)/m.exec(status)?.[1];
      const name = /^Name:\s+(.+)$/m.exec(status)?.[1];
      // Field 22 is the process's start tick. The comm field can contain
      // spaces or parentheses, so split only after its closing parenthesis.
      const start = (value: string) => value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
      const started = start(stat);
      if (!ppid || !euid || !name || !started || !/^\d+$/.test(started)) return undefined;
      // Refuse a recycled pid rather than combining two process records.
      if (start(await readFile(`${base}/stat`, "utf8")) !== started) return undefined;
      const argv = cmdline.split("\0").filter(Boolean);
      return { ppid: Number(ppid), euid: Number(euid), name: path.basename(name), argv, line: argv.join(" "), started,
        ...(env === undefined ? {} : { env: env.split("\0").filter(Boolean).map(item => item.split("=", 1)[0]) }) };
    }
    const { stdout } = await exec("ps", ["-ww", "-o", "ppid=", "-o", "uid=", "-o", "comm=", "-p", String(pid)], { timeout: 3_000, maxBuffer: 65_536 });
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(stdout.trim().split("\n")[0] ?? "");
    if (!match) return undefined;
    const args = await exec("ps", ["-ww", "-o", "args=", "-p", String(pid)], { timeout: 3_000, maxBuffer: 65_536 });
    const line = args.stdout.trim();
    const started = (await exec("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 3_000, maxBuffer: 4_096 }).catch(() => ({ stdout: "" }))).stdout.trim();
    const argv = line.split(/\s+/).filter(Boolean);
    return { ppid: Number(match[1]), euid: Number(match[2]), name: path.basename(match[3]), argv, line, ...(started ? { started } : {}) };
  } catch { return undefined; }
}

/** Whether `pid`'s stdout is a pipe that no process of the owner's other than
 * `allowed` holds. sudo, running as root, is never visible here. */
export async function stdoutReaders(pid: number, allowed: number[]): Promise<"sudo" | "other" | "unknown"> {
  try {
    if (process.platform === "linux") {
      const target = await readlink(`/proc/${pid}/fd/1`);
      if (!/^pipe:\[\d+\]$/.test(target)) return "other";
      const holders = (await readdir("/proc")).map(Number)
        .filter(holder => Number.isInteger(holder) && holder !== pid && !allowed.includes(holder));
      let next = 0, other = false;
      // Busy machines can have thousands of descriptors. Bound the process
      // concurrency while checking every visible descriptor of each holder.
      await Promise.all(Array.from({ length: Math.min(16, holders.length) }, async () => {
        while (!other && next < holders.length) {
          const holder = holders[next++];
          const fds = await readdir(`/proc/${holder}/fd`).catch(() => [] as string[]);
          // procfs links are kernel metadata, without disk I/O. Reading a
          // holder's links directly avoids thousands of thread-pool jobs;
          // the directory awaits above still yield between holders.
          for (const fd of fds) {
            try {
              if (readlinkSync(`/proc/${holder}/fd/${fd}`) === target) { other = true; break; }
            } catch { /* The descriptor closed or its process exited. */ }
          }
        }
      }));
      return other ? "other" : "sudo";
    }
    // macOS: each pipe end has its own address, and `n->` names the other end.
    const own = await exec("lsof", ["-nP", "-a", "-p", String(pid), "-d", "1", "-F", "tdn"], { timeout: 5_000, maxBuffer: 65_536 });
    const type = /^t(.+)$/m.exec(own.stdout)?.[1], peer = /^n->(0x[0-9a-f]+)$/m.exec(own.stdout)?.[1];
    if (type !== "PIPE" || !peer) return "other";
    const all = await exec("lsof", ["-nP", "-u", String(process.getuid?.() ?? ""), "-F", "pd"], { timeout: 10_000, maxBuffer: 64 * 1_048_576 }).catch(error => error as { stdout?: string });
    let holder = 0;
    for (const row of String(all.stdout ?? "").split("\n")) {
      if (row.startsWith("p")) holder = Number(row.slice(1));
      else if (row === `d${peer}` && holder !== pid && !allowed.includes(holder)) return "other";
    }
    return all.stdout ? "sudo" : "unknown";
  } catch { return "unknown"; }
}

/** macOS: whether the other end of the Hook's connection `hookFd` is held by
 * `pid` and no other process of the owner's. */
export async function connectionHolders(pid: number, hookFd: number | undefined): Promise<"asker" | "other" | "unknown"> {
  if (hookFd === undefined) return "unknown";
  try {
    const own = await exec("lsof", ["-nP", "-a", "-p", String(process.pid), "-d", String(hookFd), "-F", "d"], { timeout: 5_000, maxBuffer: 65_536 });
    const end = /^d(0x[0-9a-f]+)$/m.exec(own.stdout)?.[1];
    if (!end) return "unknown";
    const all = await exec("lsof", ["-nP", "-a", "-U", "-u", String(process.getuid?.() ?? ""), "-F", "pn"], { timeout: 10_000, maxBuffer: 64 * 1_048_576 }).catch(error => error as { stdout?: string });
    const holders = new Set<number>();
    let holder = 0;
    for (const row of String(all.stdout ?? "").split("\n")) {
      if (row.startsWith("p")) holder = Number(row.slice(1));
      else if (row === `n->${end}`) holders.add(holder);
    }
    return holders.size === 1 && holders.has(pid) ? "asker" : holders.size ? "other" : "unknown";
  } catch { return "unknown"; }
}

/** Linux: a process's start time, to tell it from a later one with its pid. */
export async function processStart(pid: number): Promise<string | undefined> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
  return stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

/** Linux: the password written into the asker's stdout, the pipe verified to
 * reach sudo alone, if the asker is still the process that was verified. */
async function writeToAsker(pid: number, start: string, password: string): Promise<SudoReply> {
  if (await processStart(pid) !== start) return { status: 410, error: "askpass went away." };
  try {
    const out = await open(`/proc/${pid}/fd/1`, "w");
    try { await out.write(`${password}\n`); } finally { await out.close(); }
    return { delivered: true };
  } catch { return { status: 410, error: "askpass went away." }; }
}

export interface AskerCheck { processes: (pid: number) => Promise<ProcessRecord | undefined>; stdout: (pid: number, allowed: number[]) => Promise<"sudo" | "other" | "unknown">;
  /** Whether the connection that asked belongs to the asker alone. */
  connection: (pid: number) => Promise<"asker" | "other" | "unknown">;
  /** This Hook's node and the bundle paths askpass may run from. */
  node: string; bundles: string[]; script: string; unprivilegedSudo?: boolean }

/** What would run other code in the shell script (which drops the rest) or in node. */
const PRELOADS = ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES"], NODE_LOADERS = [...PRELOADS, "NODE_OPTIONS"];
/** The chain from askpass up to sudo, or why it is refused. */
export async function verifyAsker(pid: number, check: AskerCheck): Promise<{ sudo: ProcessRecord; sudoPid: number } | { refused: string }> {
  const asker = await check.processes(pid);
  if (!asker) return { refused: "phren askpass only answers sudo -A." };
  const script = await check.processes(asker.ppid);
  const sudo = script ? await check.processes(script.ppid) : undefined;
  if (!script || !sudo || sudo.name !== "sudo" || (sudo.euid !== 0 && !check.unprivilegedSudo)) return { refused: "phren askpass only answers sudo -A." };
  // node <bundle> askpass [prompt]: no flags that could load other code.
  const runs = check.bundles.some(bundle => asker.line === `${check.node} ${bundle} askpass` || asker.line.startsWith(`${check.node} ${bundle} askpass `));
  const scripted = script.line === `/bin/sh ${check.script}` || script.line.startsWith(`/bin/sh ${check.script} `);
  if (!runs || !scripted) return { refused: `Only ${check.script} may ask for sudo's password.` };
  if (asker.env?.some(name => NODE_LOADERS.includes(name)) || script.env?.some(name => PRELOADS.includes(name))) {
    return { refused: "askpass refused an environment that loads other code." };
  }
  const readers = await check.stdout(pid, [asker.ppid, script.ppid]);
  if (readers !== "sudo") return { refused: readers === "other" ? "askpass's output must go to sudo alone." : "Phren Hook could not check where askpass's output goes." };
  const connection = await check.connection(pid);
  if (connection !== "asker") return { refused: connection === "other" ? "Only askpass itself may ask for its password." : "Phren Hook could not check who asked." };
  return { sudo, sudoPid: script.ppid };
}

interface Pending { view: SudoRequestView; respond: (reply: SudoReply | Promise<SudoReply>) => void; deliver: Verified["deliver"]; timer: NodeJS.Timeout;
  /** The sudo process (pid and start time) and which of its password tries this is. */
  sudo: { key: string; pid: number; started?: string; attempt: number } }
/** One sudo process's password tries, so a second ask from it shows the last password was wrong. */
interface SudoTries { attempts: number; waiting?: (outcome: SudoOutcome) => void }

export interface SudoBrokerOptions {
  computer: () => string;
  push?: { readonly available: boolean; notifySudo(value: SudoRequestView): Promise<boolean> };
  /** Label and agent for the pane that asked, when the Hook can place it. */
  describe?: (place: { server: string; workspace: string; tab: string; pane: string }) => Promise<Pick<SudoSession, "source" | "label"> | undefined>;
  label?: (dispatchId: string) => Promise<string | undefined>;
  /** Reads a process, to see whether sudo is still running; tests replace it. */
  processes?: (pid: number) => Promise<ProcessRecord | undefined>;
  /** The askpass chain check and how the password then reaches it; tests replace it. */
  verify?: (pid: number, hookFd: number | undefined) => Promise<Verified | { refused: string }>;
  holdMs?: number;
  outcomeMs?: number;
  /** Whose password sudo asks for; this Hook's user. */
  account?: string;
  now?: () => number;
}

const placeName = /^[A-Za-z0-9_.:%@-]{1,128}$/;
function placeFrom(value: unknown) {
  const item = object(value);
  const fields = ["server", "workspace", "tab", "pane"] as const;
  if (!fields.every(key => typeof item[key] === "string" && placeName.test(item[key] as string))) return undefined;
  return Object.fromEntries(fields.map(key => [key, item[key] as string])) as { server: string; workspace: string; tab: string; pane: string };
}

export interface Verified { sudo: ProcessRecord; sudoPid: number; deliver: (password: string) => Promise<SudoReply> }
/** The chain check against this Hook's own node, bundle and script. */
async function defaultVerify(pid: number, hookFd: number | undefined): Promise<Verified | { refused: string }> {
  const linux = process.platform === "linux";
  const running = process.argv[1] ? [path.resolve(process.argv[1])] : [];
  const start = linux ? await processStart(pid) : undefined;
  const result = await verifyAsker(pid, { processes: readProcess, stdout: stdoutReaders, node: process.execPath, script: askpassPath(),
    bundles: [...new Set([path.join(bridgeRoot(), "current/bridge-hook.mjs"), ...running])],
    // On Linux the password goes to the asker's stdout, not this connection.
    connection: linux ? async () => start ? "asker" : "unknown" : asker => connectionHolders(asker, hookFd),
    // The real-Hook tests stand a copy of bash named sudo in for sudo, which cannot run as root.
    unprivilegedSudo: process.env.NODE_ENV === "test" && process.env.PHREN_SUDO_TEST_PARENT === "1" });
  if ("refused" in result) return result;
  return { sudo: result.sudo, sudoPid: result.sudoPid, deliver: linux ? password => writeToAsker(pid, start!, password) : async password => ({ password }) };
}

export class SudoBroker {
  private pending = new Map<string, Pending>();
  private events = new EventEmitter();
  private watchers = 0;
  private tries = new Map<string, SudoTries>();
  constructor(private options: SudoBrokerOptions) { this.events.setMaxListeners(64); }
  private get now() { return this.options.now ?? Date.now; }

  list(): SudoRequestView[] { return [...this.pending.values()].map(entry => entry.view); }
  /** Overview sockets that asked for sudo frames. Each counts as a phone
   * that can answer while it is open. */
  subscribe(listener: (requests: SudoRequestView[]) => void): () => void {
    this.watchers++;
    const handler = () => listener(this.list());
    this.events.on("change", handler);
    let open = true;
    return () => { if (!open) return; open = false; this.watchers--; this.events.off("change", handler); };
  }
  private changed() { this.events.emit("change"); }

  /** An askpass call: checks the caller, builds the request, holds it until
   * an answer, a timeout, or `cancel` (the caller went away). */
  async ask(body: Json, respond: (reply: SudoReply) => void, hookFd?: number): Promise<{ cancel: () => void }> {
    const none = { cancel: () => {} };
    const verified = await (this.options.verify ?? defaultVerify)(Number(body.pid), hookFd);
    if ("refused" in verified) { respond({ status: 400, error: verified.refused }); return none; }
    const sudo = verified.sudo, pushable = this.options.push?.available === true;
    // A second ask from the same sudo means it refused the last password,
    // whether or not this ask can reach the phone.
    const key = `${verified.sudoPid}\n${sudo.started ?? ""}`;
    const tries = this.tries.get(key) ?? { attempts: 0 };
    tries.waiting?.("rejected"); tries.waiting = undefined;
    tries.attempts++;
    this.tries.delete(key); this.tries.set(key, tries);
    while (this.tries.size > 64) this.tries.delete(this.tries.keys().next().value!);
    if (this.pending.size >= MAX_SUDO_PENDING) { respond({ status: 429, error: "Too many sudo requests are waiting for the phone." }); return none; }
    if (this.watchers === 0 && !pushable) {
      respond({ status: 503, error: "No phone can answer sudo right now. Open Phren on your phone, or set up approval push (phren bridge doctor)." });
      return none;
    }
    const place = placeFrom(body.place);
    const dispatch = briefId.safeParse(body.dispatchId).success ? String(body.dispatchId) : undefined;
    const described = place && this.options.describe ? await this.options.describe(place).catch(() => undefined) : undefined;
    const dispatchLabel = dispatch && this.options.label ? await this.options.label(dispatch).catch(() => undefined) : undefined;
    const label = dispatchLabel ?? described?.label;
    const session: SudoSession | undefined = place || described || label
      ? { ...(described?.source ? { source: described.source } : {}), ...(label ? { label: label.slice(0, 120) } : {}), ...place } : undefined;
    const cwd = typeof body.cwd === "string" && path.isAbsolute(body.cwd) && body.cwd.length <= 1_024 ? body.cwd : undefined;
    const at = this.now(), hold = this.options.holdMs ?? SUDO_HOLD_MS;
    const account = this.options.account ?? userName();
    const view: SudoRequestView = { id: randomUUID(), computer: this.options.computer(), ...sudoCommand(sudo.argv), ...(account ? { account } : {}),
      ...(cwd ? { cwd } : {}), ...(session ? { session } : {}),
      askedAt: new Date(at).toISOString(), expiresAt: new Date(at + hold).toISOString() };
    const finish = (reply: SudoReply | Promise<SudoReply>) => {
      const entry = this.pending.get(view.id);
      if (!entry) return;
      clearTimeout(entry.timer); this.pending.delete(view.id); this.changed();
      void Promise.resolve(reply).catch(() => ({ status: 410, error: "askpass went away." })).then(respond);
    };
    const timer = setTimeout(() => finish({ status: 408, error: "No answer from the phone in time." }), hold);
    this.pending.set(view.id, { view, respond: finish, deliver: verified.deliver, timer,
      sudo: { key, pid: verified.sudoPid, ...(sudo.started ? { started: sudo.started } : {}), attempt: tries.attempts } });
    this.changed();
    if (pushable) {
      void this.options.push!.notifySudo(view).catch(() => false).then(delivered => {
        if (!delivered && this.watchers === 0) finish({ status: 503, error: "The phone could not be reached for sudo." });
      });
    }
    return { cancel: () => { const entry = this.pending.get(view.id); if (!entry) return; clearTimeout(entry.timer); this.pending.delete(view.id); this.changed(); } };
  }

  /** The phone's answer. Single use: the request is gone once answered.
   * `outcome` resolves to whether sudo took the password: rejected when the
   * same sudo asks again, accepted when it has not within `outcomeMs` (or
   * is still running then), unknown when it gave up or the Hook cannot tell. */
  answer(id: string, answer: { password: string } | { deny: true }): false | { outcome: Promise<SudoOutcome | undefined> } {
    const entry = this.pending.get(id);
    if (!entry) return false;
    if (!("password" in answer)) { entry.respond({ status: 403, error: "Denied on the phone." }); return { outcome: Promise.resolve(undefined) }; }
    const delivered = entry.deliver(answer.password);
    entry.respond(delivered);
    return { outcome: delivered.then(reply => "status" in reply ? "unknown" as const : this.watchOutcome(entry.sudo), () => "unknown" as const) };
  }

  private watchOutcome(sudo: Pending["sudo"]): Promise<SudoOutcome> {
    const tries = this.tries.get(sudo.key);
    if (!tries) return Promise.resolve("unknown");
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (tries.waiting !== settle) return;
        tries.waiting = undefined;
        void (this.options.processes ?? readProcess)(sudo.pid).then(now => {
          const running = now !== undefined && (sudo.started ? now.started === sudo.started : now.name === "sudo");
          resolve(running || sudo.attempt < SUDO_TRIES ? "accepted" : "unknown");
        }, () => resolve("unknown"));
      }, this.options.outcomeMs ?? SUDO_OUTCOME_MS);
      const settle = (outcome: SudoOutcome) => { clearTimeout(timer); resolve(outcome); };
      tries.waiting = settle;
    });
  }

  close() {
    for (const entry of [...this.pending.values()]) entry.respond({ status: 503, error: "Phren Hook stopped." });
  }

  /** The agent.sock `/sudo` route. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let size = 0; const chunks: Buffer[] = [];
    for await (const bytes of req) { size += bytes.length; if (size > 16_384) throw new Error("Oversized sudo request"); chunks.push(bytes); }
    const body = object(JSON.parse(Buffer.concat(chunks).toString()));
    let done = false, gone = false, held: { cancel: () => void } | undefined;
    res.on("close", () => { gone = true; if (!done) { done = true; held?.cancel(); } });
    held = await this.ask(body, reply => {
      if (done) return; done = true;
      if ("status" in reply) { res.statusCode = reply.status; res.end(JSON.stringify({ error: reply.error })); }
      else { res.statusCode = 200; res.end(JSON.stringify(reply)); }
    }, (req.socket as unknown as { _handle?: { fd?: number } })._handle?.fd);
    // The asker left while the request was being built.
    if (gone) held.cancel();
  }
}

function userName(): string | undefined { try { return userInfo().username || undefined; } catch { return undefined; } }

/** A password as sudo reads it from askpass: one line, nothing it would cut. */
export function sudoAnswer(data: Json): { id: string; answer: { password: string } | { deny: true }; outcome: boolean } {
  const id = typeof data.id === "string" && /^[0-9a-f-]{36}$/i.test(data.id) ? data.id : undefined;
  if (!id) throw new SudoAnswerError();
  if (data.deny !== undefined) {
    if (data.deny === true && data.password === undefined && data.outcome === undefined) return { id, answer: { deny: true }, outcome: false };
    throw new SudoAnswerError();
  }
  const password = data.password;
  // Checked by hand: a schema error could echo the value it refused.
  if (typeof password !== "string" || password.length < 1 || password.length > 1_024 || /[\x00\n\r]/.test(password)) throw new SudoAnswerError();
  if (data.outcome !== undefined && typeof data.outcome !== "boolean") throw new SudoAnswerError();
  return { id, answer: { password }, outcome: data.outcome === true };
}
export class SudoAnswerError extends Error { constructor() { super("Send an id and a password, or deny."); } }

/** The bundle's `askpass` command, run by sudo through `<bridge>/askpass`.
 * Prints the password and exits 0, or explains on stderr and exits 1. */
export async function askpass(prompt: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const place = await terminalPaneFromEnv(env).catch(() => undefined);
  const dispatchId = env.PHREN_DISPATCH_ID && briefId.safeParse(env.PHREN_DISPATCH_ID).success ? env.PHREN_DISPATCH_ID : undefined;
  const data = JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...(prompt ? { prompt: prompt.slice(0, 200) } : {}),
    ...(place ? { place } : {}), ...(dispatchId ? { dispatchId } : {}) });
  const reply = await new Promise<{ status: number; body: Json }>(resolve => {
    const req = request({ socketPath: localSocket(), path: "/sudo", method: "POST", timeout: SUDO_HOLD_MS + 15_000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, res => {
      let text = "";
      res.on("data", chunk => { text += chunk.toString(); if (text.length > 16_384) req.destroy(); });
      res.on("end", () => { try { resolve({ status: res.statusCode ?? 0, body: object(JSON.parse(text)) }); } catch { resolve({ status: 0, body: {} }); } });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ status: 0, body: { error: "Phren Hook is not running on this computer (phren bridge status)." } }));
    req.end(data);
  });
  if (reply.status === 200 && typeof reply.body.password === "string") { process.stdout.write(`${reply.body.password}\n`); return 0; }
  // Linux: the Hook already wrote it into this process's stdout.
  if (reply.status === 200 && reply.body.delivered === true) return 0;
  process.stderr.write(`phren askpass: ${typeof reply.body.error === "string" ? reply.body.error : "sudo was not approved."}\n`);
  return 1;
}

/** `phren sudo <command...>`: `sudo -A` with this Hook's askpass, so the
 * password comes from the phone even with no terminal (a `!` command, an
 * agent's shell). Exits with sudo's status. */
export async function runSudo(args: string[]): Promise<number> {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: phren sudo <command...>\nRuns sudo -A <command>; Phren asks your phone for the password.");
    return args.length ? 0 : 1;
  }
  if (!askpassInstalled()) throw new Error("Phren Hook's askpass helper is missing. Run phren bridge install.");
  const { spawn } = await import("node:child_process");
  return new Promise(resolve => {
    const child = spawn("sudo", ["-A", ...args], { stdio: "inherit", env: { ...process.env, SUDO_ASKPASS: askpassPath() } });
    child.on("error", error => { process.stderr.write(`phren sudo: ${error.message}\n`); resolve(127); });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 + (({ SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1 } as Record<string, number>)[signal] ?? 1) : 1)));
  });
}
