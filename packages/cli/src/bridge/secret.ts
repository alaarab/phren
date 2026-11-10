import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdir, readlink } from "node:fs/promises";
import { readlinkSync } from "node:fs";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { bridgeRoot, object, type Json } from "./protocol.js";
import { localSocket } from "./agent-hook-stores.js";
import { terminalPaneFromEnv } from "./terminal.js";
import { briefId } from "./launch-brief.js";
import {
  askpassInstalled, askpassPath, connectionHolders, deliverToListener, deliveryFrom, deliveryListener, listenerHolders, listeningInode,
  placeFrom, PRELOADS, processStart, readProcess, SUDO_HOLD_MS, userName,
  type AskpassDelivery, type DeliveryListener, type ProcessRecord, type SudoReply, type SudoSession,
} from "./sudo.js";

/**
 * A secret typed on the phone, handed to one command's stdin.
 *
 * `phren secret-exec [--prompt <text>] [--plist <key> [--field K=V]...] -- <command...>`
 * starts the command with a fresh pipe on its stdin, then runs the Hook's
 * askpass script (`<bridge>/askpass --secret-exec`) with its stdout on that
 * same pipe and closes its own copy. The askpass helper asks the Hook over
 * agent.sock, as `sudo -A`'s does, and writes what the phone sends (one line,
 * or a plist with the secret under `<key>`) into the pipe. The agent that ran
 * secret-exec never holds the pipe, so the secret reaches the command and
 * nothing else: not the agent's stdout, stderr, logs or transcript.
 *
 * Before asking the phone the Hook checks the chain (`verifySecretAsker`): the
 * helper is this Hook's node running its bundle as `askpass --secret-exec`
 * with nothing that loads other code, its parent is the installed script,
 * that script has exactly one sibling (the command), and the helper's stdout
 * is a pipe that no process of the owner's reads except that command and its
 * descendants. The connection is bound to the helper the same way sudo's is.
 * The Hook reads the command line itself (never what the caller claims) and
 * the phone shows it, the prompt, the stdin format and the session asking,
 * and needs an approval per run. The secret is never logged, stored or kept
 * past the write. Only phones that subscribe to `secrets` frames can answer
 * (an older app never sees these requests); with none open the request is
 * refused at once.
 */

export const SECRET_FLAG = "--secret-exec";
export const MAX_SECRET_PENDING = 4;
export const SECRET_SPEC_ENV = "PHREN_SECRET_SPEC";

/** How the secret is written to the command's stdin. */
export interface SecretSpec { prompt?: string; format: "line" | "plist"; key?: string; fields?: Record<string, string> }
const plistKey = /^[A-Za-z0-9_.-]{1,64}$/;
const printable = (value: unknown, max: number): value is string => typeof value === "string" && value.length >= 1 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
/** A spec from the helper's request, or undefined when anything is off. */
export function secretSpec(value: unknown): SecretSpec | undefined {
  const item = object(value);
  if (item.prompt !== undefined && !printable(item.prompt, 200)) return undefined;
  const prompt = item.prompt as string | undefined;
  if (item.format === "line" && item.key === undefined && item.fields === undefined) return { ...(prompt ? { prompt } : {}), format: "line" };
  if (item.format !== "plist" || typeof item.key !== "string" || !plistKey.test(item.key)) return undefined;
  const fields: Record<string, string> = {};
  if (item.fields !== undefined) {
    const raw = object(item.fields);
    if (Array.isArray(item.fields) || Object.keys(raw).length > 16) return undefined;
    for (const [name, field] of Object.entries(raw)) {
      if (!plistKey.test(name) || name === item.key || !printable(field, 256)) return undefined;
      fields[name] = field;
    }
  }
  return { ...(prompt ? { prompt } : {}), format: "plist", key: item.key, ...(Object.keys(fields).length ? { fields } : {}) };
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** What the command reads on stdin. */
export function secretPayload(spec: SecretSpec, secret: string): string {
  if (spec.format === "line") return `${secret}\n`;
  const entries = [...Object.entries(spec.fields ?? {}), [spec.key!, secret]]
    .map(([name, value]) => `\t<key>${xml(name)}</key>\n\t<string>${xml(value)}</string>\n`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${entries}</dict>\n</plist>\n`;
}

/** A secret as the phone may send it: one line, nothing a listener would cut. */
export const validSecret = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 1_024 && !/[\x00\n\r]/.test(value);

/** What the phone sees. Never carries the secret. */
export interface SecretRequestView {
  id: string; kind: "secret"; computer: string;
  /** The command that will read the secret, as the Hook read it from the process table. */
  command: string;
  /** The text the agent gave, shown as the agent's words, not the system's. */
  prompt?: string;
  stdin: { format: "line" } | { format: "plist"; key: string; fields?: Record<string, string> };
  account?: string; cwd?: string; session?: SudoSession;
  askedAt: string; expiresAt: string;
}

const exec = promisify(execFile);
/** Every process's parent, from `ps`. */
export async function processTable(): Promise<Map<number, number>> {
  const { stdout } = await exec("ps", ["-A", "-o", "pid=", "-o", "ppid="], { timeout: 5_000, maxBuffer: 16 * 1_048_576 });
  const table = new Map<number, number>();
  for (const row of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(row);
    if (match) table.set(Number(match[1]), Number(match[2]));
  }
  return table;
}
export const childrenIn = (table: Map<number, number>, parent: number) => [...table].filter(([, ppid]) => ppid === parent).map(([pid]) => pid);
export function descendantsIn(table: Map<number, number>, root: number): Set<number> {
  const found = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of table) if (!found.has(pid) && found.has(ppid)) { found.add(pid); grew = true; }
  }
  return found;
}

/** The owner's processes, other than `exclude`, that hold the pipe on `pid`'s
 * stdout (on macOS, its read end). Undefined when stdout is no pipe or the
 * Hook cannot tell. Processes of other users (root) are never listed. */
export async function pipeHolders(pid: number, exclude: number[]): Promise<number[] | undefined> {
  try {
    if (process.platform === "linux") {
      const target = await readlink(`/proc/${pid}/fd/1`);
      if (!/^pipe:\[\d+\]$/.test(target)) return undefined;
      const holders: number[] = [];
      for (const holder of (await readdir("/proc")).map(Number)) {
        if (!Number.isInteger(holder) || holder === pid || exclude.includes(holder)) continue;
        const fds = await readdir(`/proc/${holder}/fd`).catch(() => [] as string[]);
        if (fds.some(fd => { try { return readlinkSync(`/proc/${holder}/fd/${fd}`) === target; } catch { return false; } })) holders.push(holder);
      }
      return holders;
    }
    const own = await exec("lsof", ["-nP", "-a", "-p", String(pid), "-d", "1", "-F", "tdn"], { timeout: 5_000, maxBuffer: 65_536 });
    const type = /^t(.+)$/m.exec(own.stdout)?.[1], peer = /^n->(0x[0-9a-f]+)$/m.exec(own.stdout)?.[1];
    if (type !== "PIPE" || !peer) return undefined;
    const all = await exec("lsof", ["-nP", "-u", String(process.getuid?.() ?? ""), "-F", "pd"], { timeout: 10_000, maxBuffer: 64 * 1_048_576 }).catch(error => error as { stdout?: string });
    if (!all.stdout) return undefined;
    const holders = new Set<number>();
    let holder = 0;
    for (const row of String(all.stdout).split("\n")) {
      if (row.startsWith("p")) holder = Number(row.slice(1));
      else if (row === `d${peer}` && holder !== pid && !exclude.includes(holder)) holders.add(holder);
    }
    return [...holders];
  } catch { return undefined; }
}

export interface SecretCheck {
  processes: (pid: number) => Promise<ProcessRecord | undefined>;
  table: () => Promise<Map<number, number>>;
  holders: (pid: number, exclude: number[]) => Promise<number[] | undefined>;
  connection: (pid: number) => Promise<"asker" | "other" | "unknown">;
  node: string; bundles: string[]; script: string;
}
const REFUSED = "phren askpass --secret-exec only answers phren secret-exec.";
/** The chain from the helper to the one command it feeds, or why it is refused. */
export async function verifySecretAsker(pid: number, check: SecretCheck): Promise<{ command: ProcessRecord; commandPid: number } | { refused: string }> {
  const asker = await check.processes(pid);
  const script = asker ? await check.processes(asker.ppid) : undefined;
  if (!asker || !script) return { refused: REFUSED };
  // Exactly the helper: no prompt argument, no flags that could load other code.
  if (!check.bundles.some(bundle => asker.line === `${check.node} ${bundle} askpass ${SECRET_FLAG}`) || script.line !== `/bin/sh ${check.script} ${SECRET_FLAG}`) return { refused: REFUSED };
  if (asker.env?.some(name => [...PRELOADS, "NODE_OPTIONS"].includes(name)) || script.env?.some(name => PRELOADS.includes(name))) {
    return { refused: "askpass refused an environment that loads other code." };
  }
  const table = await check.table().catch(() => undefined);
  if (!table) return { refused: "Phren Hook could not read the process table." };
  const siblings = childrenIn(table, script.ppid).filter(item => item !== asker.ppid);
  if (siblings.length !== 1) return { refused: "phren secret-exec must run exactly one command." };
  const [commandPid] = siblings;
  const command = await check.processes(commandPid);
  if (!command) return { refused: "The command that would read the secret has exited." };
  const holders = await check.holders(pid, [asker.ppid]);
  if (!holders) return { refused: "Phren Hook could not check where the secret goes." };
  const allowed = descendantsIn(table, commandPid);
  if (holders.some(holder => !allowed.has(holder))) return { refused: "The secret must go to the command alone." };
  const connection = await check.connection(pid);
  if (connection !== "asker") return { refused: connection === "other" ? "Only askpass itself may ask for its secret." : "Phren Hook could not check who asked." };
  return { command, commandPid };
}

export interface SecretVerified { command: ProcessRecord; deliver: (secret: string) => Promise<SudoReply> }
async function defaultVerify(pid: number, hookFd: number | undefined, delivery?: AskpassDelivery): Promise<SecretVerified | { refused: string }> {
  const linux = process.platform === "linux";
  const running = process.argv[1] ? [path.resolve(process.argv[1])] : [];
  const start = linux ? await processStart(pid) : undefined;
  const inode = linux && delivery ? await listeningInode(delivery.socket) : undefined;
  // Linux needs the helper's own listener: no fallback to writing its stdout.
  if (linux && (!start || !delivery || !inode)) return { refused: "Phren Hook could not check who asked." };
  const result = await verifySecretAsker(pid, { processes: readProcess, table: processTable, holders: pipeHolders, node: process.execPath, script: askpassPath(),
    bundles: [...new Set([path.join(bridgeRoot(), "current/bridge-hook.mjs"), ...running])],
    connection: linux ? asker => listenerHolders(asker, inode!) : asker => connectionHolders(asker, hookFd) });
  if ("refused" in result) return result;
  return { command: result.command, deliver: linux ? secret => deliverToListener(pid, start!, delivery!, inode!, secret) : async secret => ({ password: secret }) };
}

interface Pending { view: SecretRequestView; respond: (reply: SudoReply | Promise<SudoReply>) => void; deliver: SecretVerified["deliver"]; timer: NodeJS.Timeout }

export interface SecretBrokerOptions {
  computer: () => string;
  describe?: (place: { server: string; workspace: string; tab: string; pane: string }) => Promise<Pick<SudoSession, "source" | "label"> | undefined>;
  label?: (dispatchId: string) => Promise<string | undefined>;
  verify?: (pid: number, hookFd: number | undefined, delivery?: AskpassDelivery) => Promise<SecretVerified | { refused: string }>;
  holdMs?: number;
  account?: string;
  now?: () => number;
}

export class SecretBroker {
  private pending = new Map<string, Pending>();
  private events = new EventEmitter();
  private watchers = 0;
  constructor(private options: SecretBrokerOptions) { this.events.setMaxListeners(64); }

  list(): SecretRequestView[] { return [...this.pending.values()].map(entry => entry.view); }
  /** Overview sockets that asked for `secrets` frames; each is a phone that can answer. */
  subscribe(listener: (requests: SecretRequestView[]) => void): () => void {
    this.watchers++;
    const handler = () => listener(this.list());
    this.events.on("change", handler);
    let open = true;
    return () => { if (!open) return; open = false; this.watchers--; this.events.off("change", handler); };
  }
  private changed() { this.events.emit("change"); }

  async ask(body: Json, respond: (reply: SudoReply) => void, hookFd?: number): Promise<{ cancel: () => void }> {
    const none = { cancel: () => {} };
    const spec = secretSpec(body.spec);
    if (!spec) { respond({ status: 400, error: "phren secret-exec sent an invalid request." }); return none; }
    // Push is not used: an app that predates secrets would show this as sudo.
    if (this.watchers === 0) { respond({ status: 503, error: "No phone can answer right now. Open Phren on your phone (an app that supports secret-exec)." }); return none; }
    if (this.pending.size >= MAX_SECRET_PENDING) { respond({ status: 429, error: "Too many secret requests are waiting for the phone." }); return none; }
    const verified = await (this.options.verify ?? defaultVerify)(Number(body.pid), hookFd, deliveryFrom(body.delivery));
    if ("refused" in verified) { respond({ status: 400, error: verified.refused }); return none; }
    const place = placeFrom(body.place);
    const dispatch = briefId.safeParse(body.dispatchId).success ? String(body.dispatchId) : undefined;
    const described = place && this.options.describe ? await this.options.describe(place).catch(() => undefined) : undefined;
    const dispatchLabel = dispatch && this.options.label ? await this.options.label(dispatch).catch(() => undefined) : undefined;
    const label = dispatchLabel ?? described?.label;
    const session: SudoSession | undefined = place || described || label
      ? { ...(described?.source ? { source: described.source } : {}), ...(label ? { label: label.slice(0, 120) } : {}), ...place } : undefined;
    const cwd = typeof body.cwd === "string" && path.isAbsolute(body.cwd) && body.cwd.length <= 1_024 ? body.cwd : undefined;
    const at = (this.options.now ?? Date.now)(), hold = this.options.holdMs ?? SUDO_HOLD_MS;
    const account = this.options.account ?? userName();
    const view: SecretRequestView = { id: randomUUID(), kind: "secret", computer: this.options.computer(), command: verified.command.line.slice(0, 2_000),
      ...(spec.prompt ? { prompt: spec.prompt } : {}),
      stdin: spec.format === "line" ? { format: "line" } : { format: "plist", key: spec.key!, ...(spec.fields ? { fields: spec.fields } : {}) },
      ...(account ? { account } : {}), ...(cwd ? { cwd } : {}), ...(session ? { session } : {}),
      askedAt: new Date(at).toISOString(), expiresAt: new Date(at + hold).toISOString() };
    const finish = (reply: SudoReply | Promise<SudoReply>) => {
      const entry = this.pending.get(view.id);
      if (!entry) return;
      clearTimeout(entry.timer); this.pending.delete(view.id); this.changed();
      void Promise.resolve(reply).catch(() => ({ status: 410, error: "askpass went away." })).then(respond);
    };
    const timer = setTimeout(() => finish({ status: 408, error: "No answer from the phone in time." }), hold);
    this.pending.set(view.id, { view, respond: finish, deliver: verified.deliver, timer });
    this.changed();
    return { cancel: () => { const entry = this.pending.get(view.id); if (!entry) return; clearTimeout(entry.timer); this.pending.delete(view.id); this.changed(); } };
  }

  /** The phone's answer, single use. */
  answer(id: string, answer: { secret: string } | { deny: true }): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.respond("secret" in answer ? entry.deliver(answer.secret) : { status: 403, error: "Denied on the phone." });
    return true;
  }

  close() { for (const entry of [...this.pending.values()]) entry.respond({ status: 503, error: "Phren Hook stopped." }); }

  /** The agent.sock `/secret` route. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let size = 0; const chunks: Buffer[] = [];
    for await (const bytes of req) { size += bytes.length; if (size > 16_384) throw new Error("Oversized secret request"); chunks.push(bytes); }
    const body = object(JSON.parse(Buffer.concat(chunks).toString()));
    let done = false, gone = false, held: { cancel: () => void } | undefined;
    res.on("close", () => { gone = true; if (!done) { done = true; held?.cancel(); } });
    held = await this.ask(body, reply => {
      if (done) return; done = true;
      if ("status" in reply) { res.statusCode = reply.status; res.end(JSON.stringify({ error: reply.error })); }
      else { res.statusCode = 200; res.end(JSON.stringify(reply)); }
    }, (req.socket as unknown as { _handle?: { fd?: number } })._handle?.fd);
    if (gone) held.cancel();
  }
}

/** `POST /v1/secrets/answer`. Checked by hand: a schema error could echo the value it refused. */
export function secretAnswer(data: Json): { id: string; answer: { secret: string } | { deny: true } } {
  const id = typeof data.id === "string" && /^[0-9a-f-]{36}$/i.test(data.id) ? data.id : undefined;
  if (!id) throw new SecretAnswerError();
  if (data.deny !== undefined) {
    if (data.deny === true && data.secret === undefined) return { id, answer: { deny: true } };
    throw new SecretAnswerError();
  }
  if (!validSecret(data.secret)) throw new SecretAnswerError();
  return { id, answer: { secret: data.secret } };
}
export class SecretAnswerError extends Error { constructor() { super("Send an id and a secret, or deny."); } }

/** The helper, `askpass --secret-exec`: asks the Hook, writes the payload to
 * stdout (the command's stdin pipe), and wipes its copy. */
export async function secretAskpass(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let spec: SecretSpec | undefined;
  try { spec = secretSpec(JSON.parse(env[SECRET_SPEC_ENV] ?? "")); } catch { spec = undefined; }
  if (!spec) { process.stderr.write("phren secret-exec: invalid request.\n"); return 1; }
  const place = await terminalPaneFromEnv(env).catch(() => undefined);
  const dispatchId = env.PHREN_DISPATCH_ID && briefId.safeParse(env.PHREN_DISPATCH_ID).success ? env.PHREN_DISPATCH_ID : undefined;
  let received: string | undefined;
  let listener: DeliveryListener | undefined;
  if (process.platform === "linux") {
    listener = await deliveryListener(secret => { received = secret; }).catch(() => undefined);
    if (!listener) { process.stderr.write("phren secret-exec: could not open its delivery socket.\n"); return 1; }
  }
  try {
    const data = JSON.stringify({ pid: process.pid, cwd: process.cwd(), spec, ...(place ? { place } : {}), ...(dispatchId ? { dispatchId } : {}),
      ...(listener ? { delivery: listener.delivery } : {}) });
    const reply = await new Promise<{ status: number; body: Json }>(resolve => {
      const req = request({ socketPath: localSocket(), path: "/secret", method: "POST", timeout: SUDO_HOLD_MS + 15_000,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, res => {
        let text = "";
        res.on("data", chunk => { text += chunk.toString(); if (text.length > 16_384) req.destroy(); });
        res.on("end", () => { try { resolve({ status: res.statusCode ?? 0, body: object(JSON.parse(text)) }); } catch { resolve({ status: 0, body: {} }); } });
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve({ status: 0, body: { error: "Phren Hook is not running on this computer (phren bridge status)." } }));
      req.end(data);
    });
    const secret = reply.status === 200 ? (typeof reply.body.password === "string" ? reply.body.password : reply.body.delivered === true ? received : undefined) : undefined;
    reply.body.password = ""; received = undefined;
    if (secret === undefined || !validSecret(secret)) {
      process.stderr.write(`phren secret-exec: ${typeof reply.body.error === "string" ? reply.body.error : "not approved."}\n`);
      return 1;
    }
    const payload = Buffer.from(secretPayload(spec, secret), "utf8");
    try {
      await new Promise<void>((resolve, reject) => process.stdout.write(payload, error => error ? reject(error) : resolve()));
    } catch { process.stderr.write("phren secret-exec: the command closed its input.\n"); return 1; } finally { payload.fill(0); }
    return 0;
  } finally { listener?.close(); }
}

export const SECRET_EXEC_USAGE = "Usage: phren secret-exec [--prompt <text>] [--plist <key> [--field <key>=<value>]...] -- <command...>\n"
  + "Runs <command> and writes a secret typed on your phone to its stdin (one line, or a plist with the secret under <key>).\n"
  + "Your phone shows the exact command, the prompt and the session, and asks you to approve each run. The secret never reaches this terminal.";

/** Parsed `phren secret-exec` arguments. */
export function secretExecArgs(args: string[]): { spec: SecretSpec; command: string[] } {
  const split = args.indexOf("--");
  if (split < 0 || split === args.length - 1) throw new Error(SECRET_EXEC_USAGE);
  const options = args.slice(0, split), command = args.slice(split + 1);
  let prompt: string | undefined, key: string | undefined;
  const fields: Record<string, string> = {};
  for (let index = 0; index < options.length; index++) {
    const name = options[index], value = options[++index];
    if (value === undefined) throw new Error(SECRET_EXEC_USAGE);
    if (name === "--prompt") prompt = value;
    else if (name === "--plist") key = value;
    else if (name === "--field") {
      const at = value.indexOf("=");
      if (at < 1) throw new Error(`--field takes <key>=<value>, not "${value}".`);
      fields[value.slice(0, at)] = value.slice(at + 1);
    } else throw new Error(SECRET_EXEC_USAGE);
  }
  if (Object.keys(fields).length && !key) throw new Error("--field needs --plist.");
  const spec = secretSpec(key ? { prompt, format: "plist", key, ...(Object.keys(fields).length ? { fields } : {}) } : { prompt, format: "line" });
  if (!spec) throw new Error("Invalid --prompt, --plist or --field: printable text, keys of letters, digits, _ . - only, at most 16 fields.");
  return { spec, command };
}

const signalCode = (code: number | null, signal: NodeJS.Signals | null) =>
  code ?? (signal ? 128 + (({ SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1 } as Record<string, number>)[signal] ?? 1) : 1);

/** `phren secret-exec`. Exits with the command's status, or 1 when the
 * secret was not given (the command is stopped then). */
export async function runSecretExec(args: string[], options: { script?: string } = {}): Promise<number> {
  if (!args.length || args[0] === "--help" || args[0] === "-h") { console.log(SECRET_EXEC_USAGE); return args.length ? 0 : 1; }
  const { spec, command } = secretExecArgs(args);
  const script = options.script ?? askpassPath();
  if (!options.script && !askpassInstalled()) throw new Error("Phren Hook's askpass helper is missing. Run phren bridge install.");
  const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "inherit", "inherit"] });
  const exited = new Promise<number>(resolve => {
    child.on("error", error => { process.stderr.write(`phren secret-exec: ${error.message}\n`); resolve(127); });
    child.on("exit", (code, signal) => resolve(signalCode(code, signal)));
  });
  child.stdin!.on("error", () => {});
  // The helper writes straight into the command's stdin; this process keeps no copy of that pipe.
  const env: NodeJS.ProcessEnv = { ...process.env, [SECRET_SPEC_ENV]: JSON.stringify(spec) };
  for (const name of ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH"]) delete env[name];
  const helper = spawn("/bin/sh", [script, SECRET_FLAG], { stdio: ["ignore", child.stdin!, "inherit"], env });
  child.stdin!.destroy();
  const helped = await new Promise<number>(resolve => {
    helper.on("error", () => resolve(1));
    helper.on("exit", (code, signal) => resolve(signalCode(code, signal)));
  });
  if (helped !== 0 && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const code = await exited;
  return helped !== 0 ? 1 : code;
}
