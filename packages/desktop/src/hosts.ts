import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

// Retain the argv used to open masters: key files may rotate before teardown.
const masters = new Map<string, Map<string, string[]>>();
const masterOwner = (c: Computer): string => JSON.stringify([bridgeRoot(), c.name, c.address, c.username, c.port ?? 22, c.keyFile, c.hostKey]);
const WINDOWS = process.platform === "win32";
const NULL_DEVICE = WINDOWS ? "NUL" : "/dev/null";

/** OpenSSH argv (no leading "ssh") to run a remote command under a pinned key. */
export const sshArgs: SshArgs = (c, remoteCommand, opts) => {
  if (c.local) throw new Error("sshArgs cannot run on the local computer; use the Hook socket.");
  if (!c.address || !c.username || !c.hostKey || !c.keyFile) throw new Error(`Computer ${c.name} is missing SSH details.`);
  const root = bridgeRoot();
  const port = c.port ?? 22;
  const controlDir = path.join(root, "desktop-cm");
  // Compute once so the pin file and socket always have the same identity.
  const identity = masterKey(c);
  const knownHosts = knownHostsPath(identity);
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  // Each identity has its own pin; a queued old Computer cannot overwrite it.
  // Publish the complete file atomically before any SSH process can read it.
  if (!existsSync(knownHosts)) {
    const lines = [`${c.address} ${c.hostKey}`];
    if (port !== 22) lines.push(`[${c.address}]:${port} ${c.hostKey}`);
    const temporary = `${knownHosts}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, knownHosts);
    } finally { rmSync(temporary, { force: true }); }
  }
  const socketPath = WINDOWS ? undefined : path.join(controlSocketDir(), `${identity}-${opts?.slot ?? 0}`);
  if (socketPath) {
    const owner = masterOwner(c);
    const opened = masters.get(owner) ?? new Map<string, string[]>();
    opened.set(socketPath, exitArgs(c, socketPath));
    masters.set(owner, opened);
  }
  return [
    "-F", NULL_DEVICE,
    // Windows' OpenSSH has no connection sharing: each request opens its own connection there.
    ...(WINDOWS ? [] : [
      "-o", "ControlMaster=auto",
      "-o", "ControlPersist=60",
      "-o", `ControlPath=${socketPath}`,
    ]),
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", `GlobalKnownHostsFile=${NULL_DEVICE}`,
    "-o", "StrictHostKeyChecking=yes",
    "-o", "HostKeyAlgorithms=ssh-ed25519",
    "-o", "UpdateHostKeys=no",
    "-i", c.keyFile,
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
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
  return exitArgs(c, controlPath(c, slot));
}

function exitArgs(c: Computer, socketPath: string): string[] {
  return [
    "-F", "/dev/null",
    "-o", `ControlPath=${socketPath}`,
    "-p", String(c.port ?? 22),
    `${c.username}@${c.address}`,
    "-O", "exit",
  ];
}

/** Best-effort teardown of every master slot for `c`; failures are ignored. */
export async function closeMasters(c: Computer): Promise<void> {
  if (c.local || WINDOWS) return;
  try {
    const owner = masterOwner(c);
    const opened = masters.get(owner);
    masters.delete(owner);
    const args = opened ? [...opened.values()] : [0, 1, 2, 3].map(slot => masterExitArgs(c, slot));
    await Promise.all(args.map(argv =>
      exec("ssh", argv, { timeout: 5_000 }).then(() => undefined, () => undefined)));
  } catch {
    // A missing address or ssh must never fail teardown.
  }
}

/** What one set of ControlMaster slots is shared by: the identity and the
 * destination, not the display name, so two names for one host and key share
 * a channel pool just as they share masters. */
export function masterKey(c: Computer): string {
  if (c.local) return c.name;
  if (!c.keyFile) throw new Error(`Computer ${c.name} is missing its SSH key.`);
  // Read every time so even same-size rotations with unchanged mtimes and
  // stale .pub sidecars get new masters. The private digest stays in memory;
  // only the combined socket identity leaves this function.
  const identity = createHash("sha256").update(readFileSync(c.keyFile)).digest("hex");
  return createHash("sha256").update(JSON.stringify([
    c.username ?? "", c.address ?? "", c.port ?? 22, c.hostKey ?? "", identity,
  ])).digest("hex").slice(0, 24);
}

/** The ControlMaster socket path for one slot. A hash of the private identity,
 * pinned host key and destination isolates changed credentials; the slot index lets
 * the channel pool spread concurrent channels over several connections. */
function controlPath(c: Computer, slot: number): string {
  return path.join(controlSocketDir(), `${masterKey(c)}-${slot}`);
}

/** Unix socket paths are capped at 104 bytes on macOS, and ssh appends a
 * 17-character temp suffix, so the masters live
 * in a short private directory rather than under the bridge folder. */
function controlSocketDir(): string {
  const dir = `/tmp/phren-desktop-${userInfo().uid}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== userInfo().uid || (info.mode & 0o077))
    throw new Error(`${dir} must be a private directory owned by you.`);
  return dir;
}

/** Where a master's pinned known_hosts lives (removed on revoke).
 * Pass the identity returned by masterKey, never a computer display name. */
export function knownHostsPath(identity: string): string {
  return path.join(bridgeRoot(), "desktop-cm", `known_hosts-${identity}`);
}
