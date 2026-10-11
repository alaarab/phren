import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { load } from "js-yaml";
import type { Computer, LoadComputers, SshArgs } from "./contract.js";

const exec = promisify(execFile);

/** The bridge directory every wiring path hangs off (matches the Hook). */
export function bridgeRoot(): string {
  return process.env.PHREN_BRIDGE_HOME || path.join(homedir(), ".local/share/phren/bridge");
}

const LOCAL: Computer = { name: "This computer", local: true, server: "default" };

/** This computer, then desktop.yaml's computers (desktop key), else the
 * hooks.yaml peers with the dispatch key (phase 0 fallback). */
export const loadComputers: LoadComputers = async () => {
  const root = bridgeRoot();
  const desktop = await readPeers(path.join(root, "desktop.yaml"));
  if (desktop) return [LOCAL, ...parseComputers(desktop.doc, desktop.file, desktopKeyPath())];
  const hooks = await readPeers(path.join(root, "hooks.yaml"));
  return hooks ? [LOCAL, ...parseComputers(hooks.doc, hooks.file, path.join(root, "id_ed25519_dispatch"))] : [LOCAL];
};

export const desktopKeyPath = (): string => path.join(bridgeRoot(), "id_ed25519_desktop");

async function readPeers(file: string): Promise<{ doc: unknown; file: string } | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${path.basename(file)} could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"}).`);
  }
  try {
    return { doc: load(text), file: path.basename(file) };
  } catch (error) {
    throw new Error(`${path.basename(file)} is invalid: ${(error as Error).message}`);
  }
}

function parseComputers(doc: unknown, file: string, keyFile: string): Computer[] {
  const computers = doc && typeof doc === "object" ? (doc as { computers?: unknown }).computers : undefined;
  if (!Array.isArray(computers)) throw new Error(`${file} is invalid: expected a \`computers\` list.`);
  return computers.map((entry, i) => {
    const where = `computers[${i}]`;
    if (!entry || typeof entry !== "object") throw new Error(`${file} is invalid at ${where}.`);
    const row = entry as Record<string, unknown>;
    const str = (key: string): string => {
      const value = row[key];
      if (typeof value !== "string" || value.length === 0) throw new Error(`${file} is invalid at ${where}.${key}.`);
      return value;
    };
    const port = row.port === undefined ? 22 : number(row.port, `${file} ${where}.port`);
    const server = row.server === undefined ? "default" : str("server");
    return { name: str("name"), local: false, address: str("address"), username: str("username"), port, hostKey: str("hostKey"), server, keyFile };
  });
}

function number(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error(`Invalid at ${where}.`);
  return value;
}

const written = new Map<string, string>();

/** OpenSSH argv (no leading "ssh") to run a remote command under a pinned key. */
export const sshArgs: SshArgs = (c, remoteCommand, opts) => {
  if (c.local) throw new Error("sshArgs cannot run on the local computer; use the Hook socket.");
  if (!c.address || !c.username || !c.hostKey || !c.keyFile) throw new Error(`Computer ${c.name} is missing SSH details.`);
  const root = bridgeRoot();
  const port = c.port ?? 22;
  const controlDir = path.join(root, "desktop-cm");
  const knownHosts = knownHostsPath(c.name);
  // The master socket and pinned known_hosts live together; %C hashes the connection tuple.
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  if (written.get(c.name) !== c.hostKey) {
    const lines = [`${c.address} ${c.hostKey}`];
    if (port !== 22) lines.push(`[${c.address}]:${port} ${c.hostKey}`);
    writeFileSync(knownHosts, `${lines.join("\n")}\n`, { mode: 0o600 });
    chmodSync(knownHosts, 0o600);
    written.set(c.name, c.hostKey);
  }
  return [
    "-F", "/dev/null",
    "-o", "ControlMaster=auto",
    "-o", "ControlPersist=60",
    "-o", `ControlPath=${controlPath(c, opts?.slot ?? 0)}`,
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "HostKeyAlgorithms=ssh-ed25519",
    "-o", "UpdateHostKeys=no",
    "-i", c.keyFile,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "ForwardAgent=no",
    "-o", "ClearAllForwardings=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    ...(opts?.tty ? ["-tt"] : []),
    "-p", String(port),
    `${c.username}@${c.address}`,
    remoteCommand,
  ];
};

/** The OpenSSH argv to tear down the ControlMaster listening on `slot`: the
 * same pinned path/port/address, then `-O exit`. No remote command runs. */
export function masterExitArgs(c: Computer, slot: number): string[] {
  if (c.local) throw new Error("masterExitArgs cannot run on the local computer.");
  if (!c.address || !c.username) throw new Error(`Computer ${c.name} is missing SSH details.`);
  return [
    "-F", "/dev/null",
    "-o", `ControlPath=${controlPath(c, slot)}`,
    "-p", String(c.port ?? 22),
    `${c.username}@${c.address}`,
    "-O", "exit",
  ];
}

/** Best-effort teardown of every master slot for `c`; failures are ignored. */
export async function closeMasters(c: Computer): Promise<void> {
  if (c.local) return;
  try {
    await Promise.all([0, 1, 2, 3].map(slot =>
      exec("ssh", masterExitArgs(c, slot), { timeout: 5_000 }).then(() => undefined, () => undefined)));
  } catch {
    // A missing address or ssh must never fail teardown.
  }
}

/** The ControlMaster socket path for one slot. A hash of the key file path
 * keeps computers that share a name but not a key apart; the slot index lets
 * the channel pool spread concurrent channels over several connections. */
function controlPath(c: Computer, slot: number): string {
  const tag = createHash("sha256").update(c.keyFile ?? "").digest("hex").slice(0, 8);
  return path.join(controlSocketDir(), `${tag}-${slot}-%C`);
}

/** Unix socket paths are capped at 104 bytes on macOS, and ssh appends a
 * 40-character %C hash plus a 17-character temp suffix, so the masters live
 * in a short private directory rather than under the bridge folder. */
function controlSocketDir(): string {
  const dir = `/tmp/phren-desktop-${userInfo().uid}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== userInfo().uid || (info.mode & 0o077))
    throw new Error(`${dir} must be a private directory owned by you.`);
  return dir;
}

/** A filesystem-safe fragment of a display name. */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100) || "computer";
}

/** Where this computer's pinned known_hosts lives (removed on revoke). */
export function knownHostsPath(name: string): string {
  return path.join(bridgeRoot(), "desktop-cm", `known_hosts-${safeName(name)}`);
}
