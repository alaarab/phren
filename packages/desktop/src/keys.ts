// The desktop's own identity: one ed25519 key, enrolled on each computer as a
// restricted peer and revoked on its own. See contract.ts, section keys.ts.
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { dump, load } from "js-yaml";
import type { Computer, EnrollDesktop, LinkComputer, RevokeComputer } from "./contract.js";
import { hookRequest } from "./hook-client.js";
import { bridgeRoot, desktopKeyPath, knownHostsPath, loadComputers } from "./hosts.js";

const exec = promisify(execFile);
const forcedCommand = 'command="sh ~/.local/share/phren/bridge/dispatch"';
/** A desktop name is the hooks.yaml name shape; the ssh host permits @ and : for user@host:port. */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const HOST = /^[A-Za-z0-9_][A-Za-z0-9_.@:-]{0,252}$/;

interface Peer {
  name: string;
  address: string;
  username: string;
  port: number;
  hostKey: string;
  server: string;
}
type DesktopDoc = { version: 1; computers: Peer[] };

/** The restricted authorized_keys line this desktop presents. */
export function desktopKeyLine(publicKey: string, comment: string): string {
  return `restrict,pty,${forcedCommand} ${publicDesktopKey(publicKey)} ${comment}`;
}

/** Replace the entry with the same name, or append it. */
export function upsertPeer(doc: unknown, peer: Peer): DesktopDoc {
  const computers = readPeers(doc);
  const index = computers.findIndex(entry => entry.name === peer.name);
  return { version: 1, computers: index === -1 ? [...computers, peer] : computers.map((entry, i) => i === index ? peer : entry) };
}

export function removePeer(doc: unknown, name: string): DesktopDoc {
  return { version: 1, computers: readPeers(doc).filter(entry => entry.name !== name) };
}

/** One ed25519 key, validated to be exactly an "ssh-ed25519 <51-byte blob>". */
function publicDesktopKey(value: string): string {
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/.exec(value.trim());
  if (!match) throw new Error("Supply one ed25519 public key.");
  const blob = Buffer.from(match[1], "base64");
  if (blob.length !== 51 || blob.readUInt32BE(0) !== 11 || blob.subarray(4, 15).toString() !== "ssh-ed25519"
      || blob.readUInt32BE(15) !== 32 || blob.toString("base64") !== match[1]) {
    throw new Error("Invalid ed25519 public key.");
  }
  return `ssh-ed25519 ${match[1]}`;
}

/** `phren-desktop:<this computer>`, the local hostname trimmed and made safe. */
function desktopComment(): string {
  const machine = hostname().split(".")[0].replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 100) || "desktop";
  return `phren-desktop:${machine}`;
}

async function regularFile(file: string): Promise<boolean> {
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Refusing an unexpected desktop key file.");
  return true;
}

/** Create the key if missing and return its public half, restricted line and comment. */
export const enrollDesktop: EnrollDesktop = async () => {
  const root = bridgeRoot();
  const comment = desktopComment();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const lock = path.join(root, "enroll-desktop.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new Error("Desktop enrollment is already running; inspect enroll-desktop.lock if interrupted."); }
  try {
    const key = desktopKeyPath();
    if (!(await regularFile(key))) {
      const temporary = await mkdtemp(path.join(root, "enroll-desktop-"));
      try {
        const generated = path.join(temporary, "key");
        await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", generated], { timeout: 10_000 });
        await rename(generated, key);
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    await chmod(key, 0o600);
    const { stdout } = await exec("ssh-keygen", ["-y", "-P", "", "-f", key], { timeout: 10_000, maxBuffer: 4096 });
    const publicKey = publicDesktopKey(stdout.trim());
    return { publicKey, line: desktopKeyLine(publicKey, comment), comment };
  } finally { await rm(lock, { recursive: true, force: true }); }
};

/** Link one computer over the owner's own ssh login, then verify the new key. */
export const linkComputer: LinkComputer = async (host, options) => {
  if (!HOST.test(host)) throw new Error("Supply an ssh host or user@host.");
  if (options?.name !== undefined && !NAME.test(options.name)) throw new Error("A computer name may use A-Z a-z 0-9 _ . - only.");
  const name = options?.name ?? host.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 100);
  const { line } = await enrollDesktop();

  const { stdout: config } = await exec("ssh", ["-G", host], { timeout: 10_000 });
  const { address, username, port } = parseSshG(config);

  const hostKey = await sshWithScript(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "sh -s"], linkScript(line)).then(hostKeyFrom, error => {
    const code = (error as { code?: unknown }).code;
    if (code === 3) throw new Error("The computer does not have the Phren Hook installed (PHREN_NO_HOOK).");
    if (code === 4) throw new Error("The computer has no ssh-ed25519 host key (PHREN_NO_HOSTKEY).");
    throw new Error(`Could not reach ${host} with your own ssh login: ${(error as Error).message}`);
  });

  const peer: Peer = { name, address, username, port, hostKey, server: options?.server || "default" };
  await updateDesktopYaml(doc => upsertPeer(doc, peer));

  const computer: Computer = { name, local: false, address, username, port, hostKey, server: peer.server, keyFile: desktopKeyPath() };
  const response = await hookRequest(computer, "GET", "/v1/health")
    .catch(error => { throw new Error(`Linked ${name}, but its Hook did not answer over the new key: ${(error as Error).message}`); });
  const product = jsonProduct(response.body);
  if (response.status !== 200 || product !== "phren-hook") {
    throw new Error(`Linked ${name}, but its Hook did not answer over the new key (status ${response.status}${product === undefined ? "" : `, product ${JSON.stringify(product)}`}).`);
  }
  return computer;
};

/** Remove this desktop's line over the owner's ssh, then drop the local entry. */
export const revokeComputer: RevokeComputer = async name => {
  if (!readPeers(await readDesktop()).some(peer => peer.name === name)) throw new Error(`No linked computer named ${name}.`);
  const target = (await loadComputers()).find(computer => !computer.local && computer.name === name);
  if (!target?.address || !target.username) throw new Error(`No linked computer named ${name}.`);

  let blob: string | undefined;
  try {
    const { stdout } = await exec("ssh-keygen", ["-y", "-P", "", "-f", desktopKeyPath()], { timeout: 10_000, maxBuffer: 4096 });
    blob = publicDesktopKey(stdout.trim()).split(" ")[1];
  } catch { blob = undefined; }

  let remote = false;
  if (blob) {
    const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", String(target.port ?? 22), `${target.username}@${target.address}`, "sh -s"];
    remote = await sshWithScript(args, revokeScript(blob)).then(() => true, () => false);
  }

  await updateDesktopYaml(doc => removePeer(doc, name));
  await rm(knownHostsPath(name), { force: true });
  return { remote };
};

function readPeers(doc: unknown): Peer[] {
  if (!doc || typeof doc !== "object") return [];
  const computers = (doc as { computers?: unknown }).computers;
  if (!Array.isArray(computers)) return [];
  return computers.filter((entry): entry is Peer => {
    const row = entry as { name?: unknown } | null;
    return !!row && typeof row.name === "string";
  });
}

async function readDesktop(): Promise<unknown> {
  const file = path.join(bridgeRoot(), "desktop.yaml");
  try { return load(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Read desktop.yaml under a lock, replace its computers, and write it 0600 via rename. */
async function updateDesktopYaml(update: (doc: unknown) => DesktopDoc): Promise<void> {
  const root = bridgeRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, "desktop-yaml.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch { throw new Error("desktop.yaml is being updated elsewhere; inspect desktop-yaml.lock if interrupted."); }
  try {
    const temporary = path.join(root, `desktop.yaml.${process.pid}.tmp`);
    await writeFile(temporary, dump(update(await readDesktop()), { lineWidth: -1 }), { mode: 0o600 });
    await rename(temporary, path.join(root, "desktop.yaml"));
  } finally { await rm(lock, { recursive: true, force: true }); }
}

/** Resolve the destination ssh -G computes for a host alias. */
function parseSshG(output: string): { address: string; username: string; port: number } {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+(.*\S)\s*$/.exec(line);
    if (match && !values.has(match[1])) values.set(match[1], match[2]);
  }
  const address = values.get("hostname");
  const username = values.get("user");
  const port = Number(values.get("port"));
  if (!address || !username || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("ssh -G did not report the host's address, user and port.");
  }
  return { address, username, port };
}

/** Run ssh with a POSIX sh script on stdin. execFile has no input option, so write it. */
function sshWithScript(args: string[], script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("ssh", args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) return resolve(stdout);
      const error = new Error(lastLine(stderr) || `ssh exited with code ${code ?? "unknown"}.`) as Error & { code?: number | null; stderr?: string };
      error.code = code;
      error.stderr = stderr;
      reject(error);
    });
    child.stdin?.end(script);
  });
}

const lastLine = (text: string): string =>
  text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop() ?? "";

/** Install the line and report the host key, read over the owner's already-trusted login. Exit 3/4 mean Hook/host key absent. */
const linkScript = (line: string): string => {
  const encoded = Buffer.from(line).toString("base64");
  return `set -e
[ -f "$HOME/.local/share/phren/bridge/dispatch" ] || { echo PHREN_NO_HOOK >&2; exit 3; }
line=$(printf %s '${encoded}' | base64 -d) || exit 1
blob=$(printf '%s\\n' "$line" | sed -n 's/.*ssh-ed25519 \\([^ ]*\\).*/\\1/p')
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys"
grep -Fq "$blob" "$HOME/.ssh/authorized_keys" || printf '%s\\n' "$line" >> "$HOME/.ssh/authorized_keys"
# sshd keeps host keys in /etc/ssh on most systems; Asustor and Homebrew-style layouts use the others.
for dir in /etc/ssh /usr/etc/ssh /usr/local/etc/ssh /opt/etc/ssh /etc; do
  if [ -f "$dir/ssh_host_ed25519_key.pub" ]; then echo "HOSTKEY $(head -n 1 "$dir/ssh_host_ed25519_key.pub")"; exit 0; fi
done
echo PHREN_NO_HOSTKEY >&2; exit 4`;
};

/** Remove every line carrying this desktop's key blob, keeping the file mode. */
const revokeScript = (blob: string): string => `set -e
file="$HOME/.ssh/authorized_keys"
[ -f "$file" ] || exit 0
tmp="$file.phren-revoke.$$"
grep -Fv '${blob}' "$file" > "$tmp" || [ $? -eq 1 ]
chmod 600 "$tmp"
mv "$tmp" "$file"
`;

function hostKeyFrom(stdout: string): string {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^HOSTKEY (ssh-ed25519 [A-Za-z0-9+/]+={0,2})(?:\s.*)?$/.exec(line.trim());
    if (match) return match[1];
  }
  throw new Error("The computer did not report its ssh-ed25519 host key.");
}

function jsonProduct(body: Buffer): unknown {
  try { return (JSON.parse(body.toString("utf8")) as { product?: unknown }).product; }
  catch { return undefined; }
}
