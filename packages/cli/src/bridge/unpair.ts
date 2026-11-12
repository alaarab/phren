import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { hookRequest } from "./client.js";
import { removeAuthorizedKeys } from "./computers.js";
import { forcedCommand } from "./install.js";
import { bridgeRoot } from "./protocol.js";

const exec = promisify(execFile);
export const UNPAIR_USAGE = "phren unpair [<number> | SHA256:<fingerprint> | --all | --notifications]";

export interface PhoneKey { line: string; device: "ios" | "android"; fingerprint: string }

const phoneLine = new RegExp(`^restrict,pty,${forcedCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ssh-ed25519 ([A-Za-z0-9+/]+={0,2}) phren-(iphone|android)\\s*$`);

/** The phone keys `phren pair` and the phone's password sign-in wrote, in file order. */
export function phoneKeys(authorizedKeys: string): PhoneKey[] {
  const keys: PhoneKey[] = [];
  for (const line of authorizedKeys.split("\n")) {
    const match = phoneLine.exec(line);
    if (!match) continue;
    // The fingerprint `ssh-keygen -l` and the phone's key screen show.
    const fingerprint = `SHA256:${createHash("sha256").update(Buffer.from(match[1], "base64")).digest("base64").replace(/=+$/, "")}`;
    keys.push({ line, device: match[2] === "android" ? "android" : "ios", fingerprint });
  }
  return keys;
}

export interface ProcessRow { pid: number; ppid: number; uid: number; command: string }

export function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), command: match[4] });
  }
  return rows;
}

/**
 * The SSH connections to end after a key is removed. sshd does not say which
 * key opened a connection, and one that is already open keeps working without
 * its authorized_keys line: it can open the Hook pipe again at any time. So
 * every connection of this user that runs nothing but the Phren gateway, or
 * nothing at all, is ended; the phones and computers still enrolled reconnect.
 * A connection running anything else (a login shell, an editor's server, this
 * command itself) is left alone.
 */
export function gatewayConnections(rows: ProcessRow[], options: { uid: number; root: string; self: number }): { sessions: number[]; children: number[] } {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const ancestors = new Set<number>();
  for (let pid: number | undefined = options.self, hops = 0; pid && pid > 1 && hops < 64; pid = byPid.get(pid)?.ppid, hops++) ancestors.add(pid);
  const gateway = (command: string) => command.includes(`${options.root}/`) || command.includes("/.local/share/phren/bridge/dispatch");
  // "sshd: user" before the first channel, "sshd: user@notty" or "@pts/3" after;
  // the root-owned "[priv]" monitor fails the uid check and goes with its child.
  // An internal-sftp child carries the same title and is someone's transfer.
  const session = /^sshd(?:-session)?: [^\s@]+(?:@(?!internal-sftp)\S+)?\s*$/;
  const sessions: number[] = [], children: number[] = [];
  for (const row of rows) {
    if (row.uid !== options.uid || ancestors.has(row.pid) || !session.test(row.command)) continue;
    const own = rows.filter(child => child.ppid === row.pid);
    if (!own.every(child => child.uid === options.uid && gateway(child.command))) continue;
    sessions.push(row.pid);
    children.push(...own.map(child => child.pid));
  }
  return { sessions, children };
}

/**
 * End them; returns how many connections were ended. A sign-in that was accepted
 * just before the key went can still be finishing, so the scan runs again after
 * a pause until one pass finds nothing.
 */
export async function endGatewayConnections(root = bridgeRoot(), pauseMs = 1500): Promise<number> {
  let ended = 0;
  for (let pass = 0; pass < 4; pass++) {
    if (pass) await new Promise(resolve => setTimeout(resolve, pauseMs));
    const { stdout } = await exec("ps", ["-Aww", "-o", "pid=,ppid=,uid=,command="], { timeout: 5000, maxBuffer: 16_777_216 });
    const { sessions, children } = gatewayConnections(parseProcessRows(stdout), { uid: userInfo().uid, root, self: process.pid });
    if (pass && !sessions.length) break;
    for (const pid of children) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
    for (const pid of sessions) { try { process.kill(pid, "SIGTERM"); ended++; } catch { /* already gone */ } }
  }
  return ended;
}

/**
 * Push registrations are not tied to an SSH key, so the removed phone's cannot
 * be told from the others: the Hook drops them all. With no Hook running, the
 * saved list goes and the next Hook starts without it.
 */
export async function forgetPushRegistrations(root = bridgeRoot()): Promise<number> {
  try {
    const reply = await hookRequest("/v1/push/forget", {}, undefined, 10_000);
    return typeof reply.removed === "number" ? reply.removed : 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
    const file = path.join(root, "push-devices.json");
    const saved = await readFile(file, "utf8").then(text => JSON.parse(text) as unknown).catch(() => []);
    await rm(file, { force: true });
    return Array.isArray(saved) ? saved.length : 0;
  }
}

const deviceName = (key: PhoneKey) => key.device === "android" ? "Android phone" : "iPhone";

export async function runUnpair(args: string[], options: { sshDirectory?: string; endConnections?: () => Promise<number>; forgetPush?: () => Promise<number> } = {}): Promise<number> {
  if (args.length > 1 || args[0] === "--help" || args[0] === "-h") { console.error(`Usage: ${UNPAIR_USAGE}`); return 1; }
  if (!["darwin", "linux"].includes(process.platform)) { console.error("phren unpair supports macOS and Linux."); return 1; }
  const forgetPush = async (): Promise<number> => {
    try {
      const removed = await (options.forgetPush ?? forgetPushRegistrations)();
      console.log(removed
        ? `Removed ${removed} notification registration${removed === 1 ? "" : "s"}, so a removed phone gets no more alerts from this computer. Phones that are still paired register again within an hour of opening Phren.`
        : "No notification registrations to remove.");
      return 0;
    } catch (error) {
      console.error(`Could not remove notification registrations (${(error as Error).message}). A removed phone may still get alerts from this computer; run phren bridge update, then phren unpair --notifications.`);
      return 1;
    }
  };
  // On its own: after a key was removed by hand, or to finish a removal whose last step failed.
  if (args[0] === "--notifications") return forgetPush();
  const sshDirectory = options.sshDirectory ?? path.join(homedir(), ".ssh");
  const keys = phoneKeys(await readFile(path.join(sshDirectory, "authorized_keys"), "utf8").catch(() => ""));
  if (!keys.length) { console.log("No phone is paired with this computer."); return args.length ? 1 : 0; }
  if (!args.length) {
    console.log("Phones paired with this computer:\n");
    keys.forEach((key, index) => console.log(`  ${index + 1}. ${deviceName(key)}  ${key.fingerprint}`));
    console.log("");
    console.log(`Remove one with: phren unpair <number>   (or its fingerprint, or --all)`);
    return 0;
  }
  const target = args[0];
  const chosen = target === "--all" ? keys
    : /^[1-9][0-9]{0,3}$/.test(target) ? keys.slice(Number(target) - 1, Number(target))
      : keys.filter(key => key.fingerprint === target);
  if (!chosen.length) { console.error(`No paired phone matches ${target}. Run phren unpair to list them.`); return 1; }
  const lines = new Set(chosen.map(key => key.line));
  const removed = await removeAuthorizedKeys(line => lines.has(line), sshDirectory);
  if (!removed) { console.error("The key was already gone. Run phren unpair to list what is paired now."); return 1; }
  console.log(`Removed ${removed === 1 ? `the ${deviceName(chosen[0])} key ${chosen[0].fingerprint}` : `${removed} phone keys`}. It can no longer sign in.`);
  try {
    const ended = await (options.endConnections ?? endGatewayConnections)();
    console.log(ended
      ? `Ended ${ended} open Phren connection${ended === 1 ? "" : "s"}, so a connection the removed phone still held is closed. Phones and computers that are still paired reconnect on their own.`
      : "No open Phren connections to end.");
  } catch (error) {
    console.error(`Could not end open connections (${(error as Error).message}). A connection the phone already had open may keep working until it drops; restart SSH or this computer to be sure.`);
    return 1;
  }
  return forgetPush();
}
