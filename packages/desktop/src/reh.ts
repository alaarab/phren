// The Node extension host for Phren desktop's editor: VS Code's remote
// extension host (REH), built from the exact VS Code commit the editor bundle
// uses (packages/desktop-editor/scripts/build-reh.sh). It runs on this computer,
// bound to loopback with a secret connection token, and holds the extensions
// whose code needs Node (most language servers). The page learns its address
// and token only through the cookie-protected /api/reh.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface RehStatus {
  available: boolean;
  /** "localhost:<port>" for the editor's remoteAuthority. */
  authority?: string;
  connectionToken?: string;
  version?: string;
  reason?: string;
}

const configRoot = () => process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
export const rehRoot = (): string => process.env.PHREN_DESKTOP_REH ?? path.join(configRoot(), "phren", "desktop-reh");
const buildOut = (): string => path.join(process.env.PHREN_REH_BUILD ?? path.join(homedir(), ".cache", "phren", "reh-build"), "out");
export const rehExtensionsDir = (): string => path.join(rehRoot(), "extensions");

function platformTarget(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${os}-${arch}`;
}

/** The newest built server for this platform: PHREN_REH_TARBALL, else build-reh.sh's output. */
export function findTarball(): string | undefined {
  if (process.env.PHREN_REH_TARBALL) return existsSync(process.env.PHREN_REH_TARBALL) ? process.env.PHREN_REH_TARBALL : undefined;
  const dir = buildOut();
  if (!existsSync(dir)) return undefined;
  const prefix = `vscode-reh-${platformTarget()}-`;
  const found = readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith(".tar.gz")).sort();
  return found.length ? path.join(dir, found[found.length - 1]) : undefined;
}

/** Unpack the tarball once into <reh>/<name>/ (temp folder, then rename). */
async function ensureInstalled(tarball: string): Promise<string> {
  const name = path.basename(tarball, ".tar.gz");
  const target = path.join(rehRoot(), name);
  if (existsSync(path.join(target, "product.json"))) return target;
  await mkdir(rehRoot(), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  await mkdir(temporary, { recursive: true });
  try {
    await exec("tar", ["-xzf", tarball, "-C", temporary, "--strip-components=1"], { timeout: 120_000 });
    if (!existsSync(path.join(temporary, "product.json"))) throw new Error("The server archive has no product.json.");
    await rename(temporary, target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return target;
}

/** The server's launcher script inside an unpacked REH (bin/code-server-oss or similar). */
function launcher(dir: string): string {
  const bin = path.join(dir, "bin");
  const name = readdirSync(bin).find(f => /server/.test(f) && !f.endsWith(".cmd"));
  if (!name) throw new Error("The server has no launcher in bin/.");
  return path.join(bin, name);
}

async function connectionToken(): Promise<{ file: string; token: string }> {
  const file = path.join(rehRoot(), "connection-token");
  try {
    const token = (await readFile(file, "utf8")).trim();
    if (/^[A-Za-z0-9-]{32,}$/.test(token) && ((await stat(file)).mode & 0o077) === 0) return { file, token };
  } catch { /* create it */ }
  const token = randomBytes(24).toString("hex");
  await mkdir(rehRoot(), { recursive: true, mode: 0o700 });
  await writeFile(file, token, { mode: 0o600 });
  await chmod(file, 0o600);
  return { file, token };
}

let child: ChildProcess | null = null;
let starting: Promise<RehStatus> | null = null;
let current: RehStatus | null = null;

/** Start the server once (lazily) and report how the editor reaches it. */
export function rehStatus(): Promise<RehStatus> {
  if (current?.available && child && child.exitCode === null) return Promise.resolve(current);
  if (starting) return starting;
  starting = start().finally(() => { starting = null; });
  return starting;
}

async function start(): Promise<RehStatus> {
  const tarball = findTarball();
  if (!tarball) return { available: false, reason: "No Node extension host is built for this computer. Run packages/desktop-editor/scripts/build-reh.sh." };
  let dir: string;
  try { dir = await ensureInstalled(tarball); }
  catch (error) { return { available: false, reason: `The Node extension host could not be unpacked: ${(error as Error).message}` }; }
  const version = path.basename(dir).replace(/^vscode-reh-[a-z0-9]+-[a-z0-9]+-/, "");
  const { file, token } = await connectionToken();
  await mkdir(rehExtensionsDir(), { recursive: true, mode: 0o700 });
  return new Promise<RehStatus>((resolve) => {
    const proc = spawn(launcher(dir), [
      "--host", "127.0.0.1", "--port", "0",
      "--connection-token-file", file,
      "--extensions-dir", rehExtensionsDir(),
      "--accept-server-license-terms", "--disable-telemetry",
    ], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, VSCODE_AGENT_FOLDER: path.join(rehRoot(), "data") } });
    child = proc;
    let output = "";
    const timer = setTimeout(() => finish({ available: false, reason: "The Node extension host did not start within 30 s." }), 30_000);
    function finish(status: RehStatus) {
      clearTimeout(timer);
      current = status;
      resolve(status);
    }
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8192);
      const match = /listening on (?:[\d.:]*?:)?(\d{2,5})\b/i.exec(output);
      if (match && !current?.available) finish({ available: true, authority: `localhost:${match[1]}`, connectionToken: token, version });
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (code) => {
      child = null;
      if (current?.available) current = null; // restart lazily on the next request
      else finish({ available: false, reason: `The Node extension host exited (${code ?? "signal"}): ${output.split("\n").filter(Boolean).pop() ?? ""}` });
    });
  });
}

export function stopReh(): void {
  child?.kill("SIGTERM");
  child = null;
  current = null;
}

/** Install a Node extension's VSIX into the server's extensions folder. */
export async function installIntoReh(vsix: string): Promise<boolean> {
  const tarball = findTarball();
  if (!tarball) return false;
  const dir = await ensureInstalled(tarball);
  await mkdir(rehExtensionsDir(), { recursive: true, mode: 0o700 });
  await exec(launcher(dir), ["--install-extension", vsix, "--force", "--extensions-dir", rehExtensionsDir(), "--accept-server-license-terms"],
    { timeout: 120_000, env: { ...process.env, VSCODE_AGENT_FOLDER: path.join(rehRoot(), "data") } });
  return true;
}

export async function uninstallFromReh(id: string): Promise<void> {
  const tarball = findTarball();
  if (!tarball) return;
  const dir = await ensureInstalled(tarball);
  await exec(launcher(dir), ["--uninstall-extension", id, "--extensions-dir", rehExtensionsDir(), "--accept-server-license-terms"],
    { timeout: 60_000, env: { ...process.env, VSCODE_AGENT_FOLDER: path.join(rehRoot(), "data") } }).catch(() => {});
}
