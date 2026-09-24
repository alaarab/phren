import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { forcedCommand } from "./install.js";
import { BridgeError, bridgeRoot, computerName } from "./protocol.js";

const exec = promisify(execFile);
export { computerName };
export const dispatchKeyPath = (root = bridgeRoot()) => path.join(root, "id_ed25519_dispatch");

export function publicComputerKey(value: string): string {
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/.exec(value.trim());
  if (!match) throw new BridgeError(400, "Supply one ed25519 public key.");
  const blob = Buffer.from(match[1], "base64");
  if (blob.length !== 51 || blob.readUInt32BE(0) !== 11 || blob.subarray(4, 15).toString() !== "ssh-ed25519"
      || blob.readUInt32BE(15) !== 32 || blob.toString("base64") !== match[1]) {
    throw new BridgeError(400, "Invalid ed25519 public key.");
  }
  return `ssh-ed25519 ${match[1]}`;
}

export function computerKeyLine(name: string, publicKey: string): string {
  return `restrict,pty,${forcedCommand} ${publicComputerKey(publicKey)} phren-computer:${computerName.parse(name)}`;
}

async function regularFile(file: string): Promise<boolean> {
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink()) throw new BridgeError(409, "Refusing an unexpected enrollment file.");
  return true;
}

/** Never replace a dispatch identity implicitly: every peer enrolled this key. */
export async function enrollComputer(name: string, root = bridgeRoot()): Promise<string> {
  computerName.parse(name);
  await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  const lock = path.join(root, "enroll-computer.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new BridgeError(409, "Computer enrollment is already running; inspect enroll-computer.lock if interrupted."); }
  try {
    const key = dispatchKeyPath(root);
    if (!(await regularFile(key))) {
      const temporary = await mkdtemp(path.join(root, "enroll-"));
      try {
        const generated = path.join(temporary, "key");
        await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "phren-computer", "-f", generated], { timeout: 10_000 });
        await rename(generated, key);
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    await chmod(key, 0o600);
    const { stdout } = await exec("ssh-keygen", ["-y", "-P", "", "-f", key], { timeout: 10_000, maxBuffer: 4096 });
    return computerKeyLine(name, stdout.trim());
  } finally { await rm(lock, { recursive: true, force: true }); }
}

/** Accept a public key, rebuilding the restrictions rather than trusting supplied options. */
export async function acceptComputer(name: string, input: string, sshDirectory = path.join(homedir(), ".ssh")): Promise<void> {
  computerName.parse(name);
  const prefix = `restrict,pty,${forcedCommand} `;
  const raw = input.trim();
  const publicKey = publicComputerKey(raw.startsWith(prefix) ? raw.slice(prefix.length) : raw);
  const line = computerKeyLine(name, publicKey);
  const directory = await lstat(sshDirectory).catch(() => undefined);
  if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) throw new BridgeError(409, "Refusing an unexpected SSH directory.");
  await mkdir(sshDirectory, { recursive: true, mode: 0o700 }); await chmod(sshDirectory, 0o700);
  const lock = path.join(sshDirectory, ".phren-enroll.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new BridgeError(409, "SSH enrollment is already running; inspect .phren-enroll.lock if interrupted."); }
  const file = path.join(sshDirectory, "authorized_keys");
  const temporary = path.join(lock, "authorized_keys");
  try {
    const before = await regularFile(file) ? await readFile(file, "utf8") : "";
    const lines = before.split("\n").filter(Boolean);
    if (lines.includes(line)) { await chmod(file, 0o600); return; }
    const encoded = publicKey.split(" ")[1];
    if (lines.some(existing => existing.endsWith(` phren-computer:${name}`) || existing.split(/\s+/).includes(encoded))) {
      throw new BridgeError(409, "This name or key is already enrolled differently. Revoke the old line explicitly first.");
    }
    await writeFile(temporary, before + (before && !before.endsWith("\n") ? "\n" : "") + line + "\n", { mode: 0o600, flag: "wx" });
    const current = await regularFile(file) ? await readFile(file, "utf8") : "";
    if (current !== before) throw new BridgeError(409, "authorized_keys changed during enrollment. Try again.");
    await rename(temporary, file);
  } finally { await rm(lock, { recursive: true, force: true }); }
}
