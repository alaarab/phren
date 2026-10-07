import { activateModules as moduleSnapshot, type ModuleSnapshot } from "../modules/runtime.js";
import { defaultPhrenPath } from "../shared.js";
import { disabledHint } from "../modules/registry.js";
import { execFile } from "node:child_process";
import { usageStatusLine } from "./usage.js";
import { access, chmod, copyFile, mkdir, open, readFile, rename, symlink, unlink, lstat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { codexHome, claudeConfigDir } from "../home-paths.js";
import { claudeHomes } from "./claude-accounts.js";
import { syncAccountMcpServers } from "./claude-account-setup.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { bridgeRoot, object, objects, atomic, socketPath } from "./protocol.js";
import { herdrRoot } from "./herdr.js";
import { health } from "./transport.js";
import { FAST_HOOK_SOURCE, fastHookPath } from "./hook-fast.js";
import { installAskpass, removeAskpass } from "./sudo.js";
import { readStoredVoice, SPEECH_VOICE_ENV, writeSpeechVoice } from "./speech-voice.js";
import { carryCodexHookTrust } from "./codex-hook-trust.js";
import type { GatewayScope } from "./scoped-gateway.js";
import { type CodexServerEntry, serversInService } from "./codex-servers.js";

const exec = promisify(execFile);
const label = "com.phren.hook";
const unit = "phren-hook.service";
export const forcedCommand = 'command="sh ~/.local/share/phren/bridge/dispatch"';
/** A scoped key's forced command. A separate script, so a key added before
 * the Hook can serve its scope fails closed instead of reaching `dispatch`. */
export const scopedForcedCommand = (scope: GatewayScope) => `command="sh ~/.local/share/phren/bridge/dispatch-scoped ${scope}"`;
function keyOptions(line: string): { options: string[]; rest: string } | undefined {
  const options: string[] = [];
  let quoted = false, start = 0;
  for (let i = 0; i < line.length; i++) {
    const character = line[i];
    if (quoted && character === "\\" && line[i + 1] === '"') { i++; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (!quoted && (character === "," || /\s/.test(character))) {
      options.push(line.slice(start, i)); start = i + 1;
      if (character !== ",") return { options, rest: line.slice(i) };
    }
  }
  return undefined;
}

export function upgradeKeys(text: string): { text: string; changed: number } {
  let changed = 0;
  const result = text.split(/(?<=\n)/).map(line => {
    const parsed = keyOptions(line);
    if (!parsed || parsed.options[0] !== "restrict" || !/^\s+ssh-ed25519 [A-Za-z0-9+/=]+ phren-(?:iphone|android)\s*$/.test(parsed.rest)) return line;
    const old = /^command="(?:\/usr\/bin\/false|python3 ~\/\.local\/share\/phren\/chat-progress\.py|sh ~\/\.local\/share\/phren\/bridge\/dispatch)"$/;
    if (!parsed.options.some(option => old.test(option))) return line;
    // permitopen restricts TCP destinations only. Removing generic forwarding
    // also prevents access to private Unix sockets through this device key.
    const options = parsed.options.filter(option => option.toLowerCase() !== "port-forwarding" && !option.toLowerCase().startsWith("permitopen="))
      .map(option => old.test(option) ? forcedCommand : option);
    if (!options.includes("pty")) options.splice(1, 0, "pty");
    const next = options.join(",") + parsed.rest;
    if (next !== line) changed++;
    return next;
  }).join("");
  return { text: result, changed };
}
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The service environment install writes. Any other key in an existing
 * LaunchAgent (a voice, a proxy, an API override someone added by hand) is
 * kept: before, `phren bridge update` rewrote the plist and dropped it. */
const MANAGED_ENVIRONMENT = new Set(["PATH", "PHREN_BRIDGE_HOME", "PHREN_HERDR_HOME", "PHREN_PATH", "PHREN_PROFILE"]);

/** The existing LaunchAgent's own EnvironmentVariables beyond phren's, read
 * with plutil. A missing or unreadable plist has none. */
export async function extraLaunchAgentEnvironment(file: string,
  read: (file: string) => Promise<string> = async f => (await exec("plutil", ["-convert", "json", "-o", "-", f])).stdout): Promise<Record<string, string>> {
  let parsed: unknown;
  try { parsed = JSON.parse(await read(file)); } catch { return {}; }
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(object(object(parsed).EnvironmentVariables))) {
    if (!MANAGED_ENVIRONMENT.has(key) && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && typeof value === "string") extra[key] = value;
  }
  return extra;
}

export interface LaunchAgentValues { label: string; node: string; program: string; path: string; root: string; herdr: string; store: string; profile: string }

/** The Hook's LaunchAgent: phren's own environment first, then every kept key. */
export function launchAgentXml(values: LaunchAgentValues, extra: Record<string, string> = {}): string {
  const environment: [string, string][] = [["PATH", values.path], ["PHREN_BRIDGE_HOME", values.root], ["PHREN_HERDR_HOME", values.herdr],
    ["PHREN_PATH", values.store], ["PHREN_PROFILE", values.profile], ...Object.entries(extra).filter(([key]) => !MANAGED_ENVIRONMENT.has(key))];
  const env = environment.map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(values.label)}</string><key>ProgramArguments</key><array><string>${xml(values.node)}</string><string>${xml(values.program)}</string><string>serve</string></array><key>Umask</key><integer>63</integer><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>Nice</key><integer>-5</integer><key>EnvironmentVariables</key><dict>${env}</dict><key>StandardErrorPath</key><string>${xml(path.join(values.root, "service.log"))}</string></dict></plist>\n`;
}
const systemdQuote = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%") + '"';

/** The forwarder the forced command uses for the phone's byte pipe. */
export type GatewayKind = "socat" | "nc" | "node";
export interface GatewayEnvironment {
  root: string; herdr: string; store: string; profile: string;
  node: string; bundle: string; socket: string; timing: string;
}

async function commandOutput(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await exec(file, args, { env, timeout: 2000 });
    return stdout + stderr || undefined;
  } catch (error) {
    const value = error as { stdout?: string; stderr?: string };
    return `${value.stdout ?? ""}${value.stderr ?? ""}` || undefined;
  }
}

/** Pick the cheapest reliable forwarder at install time: socat, then an nc that
 *  understands Unix sockets, then the node gateway that always works. */
export async function detectGateway(env: NodeJS.ProcessEnv = process.env): Promise<GatewayKind> {
  if ((await commandOutput("/bin/sh", ["-c", "command -v socat"], env))?.trim()) return "socat";
  const help = await commandOutput("nc", ["-h"], env);
  if (help !== undefined && /(^|\s)-U(\s|,|$)/m.test(help)) return "nc";
  return "node";
}

/** The POSIX sh forced command: the phone's byte pipe goes straight to the Hook
 *  socket through a tiny forwarder, so a loaded machine never pays for a fresh
 *  node process; every other SSH command falls through to the node gateway. */
export function gatewayScript(gateway: GatewayKind, environment: GatewayEnvironment): string {
  const { root, herdr, store, profile, node, bundle, socket, timing } = environment;
  const forward = gateway === "socat"
    ? `  if command -v socat >/dev/null 2>&1; then rm -f ${quote(timing)}; exec socat - UNIX-CONNECT:${quote(socket)}; fi`
    : gateway === "nc"
      ? `  if command -v nc >/dev/null 2>&1; then rm -f ${quote(timing)}; exec nc -U ${quote(socket)}; fi`
      : "";
  const pipe = forward ? `if [ "$SSH_ORIGINAL_COMMAND" = "phren-hook v1 pipe" ]; then\n${forward}\nfi\n` : "";
  return `#!/bin/sh
# Phren Hook gateway. The phone's byte pipe goes straight to the Hook socket
# through a tiny forwarder so a loaded machine does not pay for a fresh node
# process; every other SSH command falls through to the node gateway.
export PHREN_BRIDGE_HOME=${quote(root)}
export PHREN_HERDR_HOME=${quote(herdr)}
export PHREN_PATH=${quote(store)}
export PHREN_PROFILE=${quote(profile)}
${pipe}exec ${quote(node)} ${quote(bundle)} ssh
`; }

/** The scoped keys' forced command: always the node gateway (never the raw
 *  socat/nc pipe), told which scope the key holds. An unknown scope or an older
 *  bundle without `ssh-scoped` refuses. */
export function scopedGatewayScript(environment: Omit<GatewayEnvironment, "socket" | "timing">): string {
  const { root, herdr, store, profile, node, bundle } = environment;
  return `#!/bin/sh
# Phren Hook scoped gateway for keys limited to one route set (phren pair --scope).
export PHREN_BRIDGE_HOME=${quote(root)}
export PHREN_HERDR_HOME=${quote(herdr)}
export PHREN_PATH=${quote(store)}
export PHREN_PROFILE=${quote(profile)}
exec ${quote(node)} ${quote(bundle)} ssh-scoped "$1"
`; }

export const scopedGatewayPath = (root = bridgeRoot()) => path.join(root, "dispatch-scoped");

async function activate(version: string) {
  const root = bridgeRoot();
  const next = path.join(root, `current-${process.pid}`);
  await symlink(path.join("versions", version), next);
  await rename(next, path.join(root, "current"));
}

/** The launchd domain for the LaunchAgent: the GUI session when someone is
 *  logged in at the screen, else the per-user background domain an SSH login
 *  has (gui/<uid> does not exist there, so a bootstrap into it fails). */
function launchDomain(uid: number, guiSession: boolean): string {
  return guiSession ? `gui/${uid}` : `user/${uid}`;
}

/** The commands that restart the Hook in `domain`, printed when launchd refuses. */
export function launchCommands(domain: string, plist: string): string[] {
  return [`launchctl bootout ${domain}/${label}`, `launchctl bootstrap ${domain} ${quote(plist)}`, `launchctl kickstart -k ${domain}/${label}`];
}

const launchAgentPlist = () => path.join(homedir(), "Library/LaunchAgents", `${label}.plist`);
async function guiSession(uid: number): Promise<boolean> {
  return exec("launchctl", ["print", `gui/${uid}`]).then(() => true, () => false);
}

async function stopService() {
  if (process.platform === "darwin") {
    // Either domain may hold the job from an earlier install.
    for (const gui of [true, false]) await exec("launchctl", ["bootout", `${launchDomain(process.getuid!(), gui)}/${label}`]).catch(() => {});
  }
  else await exec("systemctl", ["--user", "stop", unit]).catch(() => {});
}
async function startService(): Promise<string | undefined> {
  if (process.platform === "darwin") {
    const uid = process.getuid!(), gui = await guiSession(uid), domain = launchDomain(uid, gui);
    // bootout returns before launchd finishes releasing the old job. A valid
    // immediate bootstrap can transiently fail with EIO during an update.
    for (let attempt = 0; ; attempt++) {
      try {
        await exec("launchctl", ["bootstrap", domain, launchAgentPlist()]);
        break;
      } catch (error) {
        const stderr = String((error as { stderr?: string }).stderr ?? "");
        if (attempt < 5 && stderr.includes("Bootstrap failed: 5:")) { await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1))); continue; }
        throw new Error(`launchctl could not start the Phren Hook in ${domain}: ${stderr.trim() || (error as Error).message}\nTo start it by hand:\n  ${launchCommands(domain, launchAgentPlist()).join("\n  ")}`);
      }
    }
    // RunAtLoad does not always fire for a job bootstrapped from an SSH login.
    // A failed kickstart is only fatal if the version check below also fails.
    const kickstartError = await exec("launchctl", ["kickstart", `${domain}/${label}`]).then(() => undefined, error =>
      String((error as { stderr?: string }).stderr || (error as Error).message).trim());
    if (!gui) console.log(`No one is logged in at this Mac's screen, so the Phren Hook runs in ${domain}. After a screen login, run phren bridge install again to move it into gui/${uid}.`);
    return kickstartError;
  }
  else { await exec("systemctl", ["--user", "daemon-reload"]); await exec("systemctl", ["--user", "enable", "--now", unit]); }
}

/** How long install waits for Codex turns that would stop with the Hook. */
export const CODEX_TURN_WAIT_MS = 10 * 60 * 1000;

/** Codex workers still running inside the Hook's service (started by a Hook
 * from before each server got its own scope) stop with it, mid-turn or not.
 * Say which, and wait up to `waitMs` for the running turns to finish. */
export async function waitForCodexWorkers(waitMs = CODEX_TURN_WAIT_MS, inService: () => Promise<CodexServerEntry[]> = () => serversInService(unit),
  log: (line: string) => void = console.log, pollMs = 5_000): Promise<void> {
  if (process.platform !== "linux") return;
  const describe = (entry: CodexServerEntry) => `${entry.pane}${entry.dispatchId ? ` (dispatch ${entry.dispatchId.slice(0, 8)})` : ""}${entry.activeTurn ? ", turn running" : ", idle"}`;
  let workers = await inService();
  if (!workers.length) return;
  log(`${workers.length} Codex worker${workers.length === 1 ? "" : "s"} run inside the Phren Hook's service and will stop when it restarts: ${workers.map(describe).join("; ")}.`
    + " Hooks from this version on start each Codex server in its own scope, so later restarts leave them running.");
  const deadline = Date.now() + waitMs;
  while (workers.some(entry => entry.activeTurn) && Date.now() < deadline) {
    log(`Waiting up to ${Math.ceil((deadline - Date.now()) / 60_000)} min for ${workers.filter(entry => entry.activeTurn).length} running Codex turn(s) to finish. Pass --force to restart now.`);
    await new Promise(resolve => setTimeout(resolve, pollMs));
    workers = await inService();
  }
  const cut = workers.filter(entry => entry.activeTurn);
  if (cut.length) log(`Restarting anyway: ${cut.map(describe).join("; ")} will stop mid-turn and return failed.`);
}

async function serviceReady(version: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    try { if ((await health()).version === version) return true; } catch { /* Hook is still starting */ }
    if (i < 49) await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

export async function install(version: string, noService = false, force = false): Promise<void> {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("Phren Hook supports macOS and Linux.");
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error("Invalid helper version.");
  const modules = moduleSnapshot(defaultPhrenPath(), undefined, true);
  if (!modules.has("hook")) throw new Error(disabledHint("hook"));
  const root = bridgeRoot(), herdr = herdrRoot(), versions = path.join(root, "versions");
  await mkdir(versions, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  const serviceLog = path.join(root, "service.log");
  const log = await open(serviceLog, "a", 0o600);
  try { await log.chmod(0o600); } finally { await log.close(); }
  const hookEdits = await planAgentHooks(path.join(root, "current/bridge-hook.mjs"), false, modules);
  const own = fileURLToPath(import.meta.url);
  const bundle = own.endsWith("bridge-hook.mjs") ? own : path.join(path.dirname(own), "..", "bridge-hook.mjs");
  const destination = path.join(versions, version);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const installedBundle = path.join(destination, "bridge-hook.mjs");
  const previousBundle = await missingFile(readFile(installedBundle));
  const stagedBundle = installedBundle + `.phren-${process.pid}`;
  await copyFile(bundle, stagedBundle); await rename(stagedBundle, installedBundle);
  await atomic(fastHookPath(destination), FAST_HOOK_SOURCE);
  const previous = await readFile(path.join(root, "installed.json"), "utf8").then(v => JSON.parse(v) as { version: string; previous?: string }).catch(() => null);
  const gateway = await detectGateway();
  await atomic(path.join(root, "dispatch"), gatewayScript(gateway, {
    root, herdr, store: modules.store, profile: modules.profile, node: process.execPath,
    bundle: path.join(root, "current/bridge-hook.mjs"), socket: socketPath(), timing: path.join(root, "gateway.json"),
  }), 0o700);
  await atomic(scopedGatewayPath(root), scopedGatewayScript({
    root, herdr, store: modules.store, profile: modules.profile, node: process.execPath, bundle: path.join(root, "current/bridge-hook.mjs"),
  }), 0o700);
  await installAskpass(process.execPath, path.join(root, "current/bridge-hook.mjs"));
  const environmentPath = [path.dirname(process.execPath), path.join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin"].join(":");
  const program = path.join(root, "current/bridge-hook.mjs");
  if (!noService) {
    if (process.platform === "darwin") {
      const folder = path.join(homedir(), "Library/LaunchAgents"); await mkdir(folder, { recursive: true });
      const plist = path.join(folder, `${label}.plist`);
      const extra = await extraLaunchAgentEnvironment(plist);
      // The talk-mode voice used to live only here; it moves to the Hook's own setting.
      if (extra[SPEECH_VOICE_ENV] && !(await readStoredVoice())) await writeSpeechVoice(extra[SPEECH_VOICE_ENV]).catch(() => {});
      await atomic(plist, launchAgentXml({ label, node: process.execPath, program, path: environmentPath, root, herdr, store: modules.store, profile: modules.profile }, extra));
    } else {
      const folder = path.join(homedir(), ".config/systemd/user"); await mkdir(folder, { recursive: true });
      await atomic(path.join(folder, unit), `[Unit]\nDescription=Phren Hook\n[Service]\nExecStart=${systemdQuote(process.execPath)} ${systemdQuote(program)} serve\nNice=-5\nEnvironment=${systemdQuote("PATH=" + environmentPath)} ${systemdQuote("PHREN_BRIDGE_HOME=" + root)} ${systemdQuote("PHREN_HERDR_HOME=" + herdr)} ${systemdQuote("PHREN_PATH=" + modules.store)} ${systemdQuote("PHREN_PROFILE=" + modules.profile)}\nRestart=always\nRestartSec=3\nUMask=0077\n[Install]\nWantedBy=default.target\n`);
    }
    if (!force) await waitForCodexWorkers();
    await stopService();
  }
  await activate(version);
  try {
    if (!noService) {
      let kickstartError = await startService();
      let ready = await serviceReady(version);
      if (!ready && process.platform === "darwin") {
        // launchd may accept bootstrap but leave a throttled or old job behind.
        // Reload the plist and give the new job a second bounded start window.
        await stopService();
        kickstartError = await startService();
        ready = await serviceReady(version);
      }
      if (!ready) {
        const uid = process.getuid!(), domain = process.platform === "darwin" ? launchDomain(uid, await guiSession(uid)) : undefined;
        throw new Error(`The new Phren Hook ${version} did not become ready after ${domain ? "two launchd starts" : "starting the service"}.${kickstartError ? ` Last launchctl kickstart error: ${kickstartError}.` : ""} See ${serviceLog}. ` + (domain
          ? `To start it by hand:\n  ${launchCommands(domain, launchAgentPlist()).join("\n  ")}`
          : `Check systemctl --user status ${unit}.`));
      }
    }
    await applyAgentHooks(hookEdits);
    const synced = await syncAccountMcpServers().catch(() => []);
    if (synced.length) console.log(`Claude accounts: refreshed MCP servers in ${synced.join(", ")}.`);
    if (await applyOpencodePlugin()) {
      console.log("opencode chat: restart any opencode session started before now so it loads the transcript plugin.");
    }
    // phren-agent calls the installed bundle itself, so it has no settings to edit.
    if ((await import("../modules/agent-package.js")).agentInstalled()) {
      console.log("phren-agent chat: found; it reports to this Hook itself, so restart any phren-agent session started before now.");
    }
    const keys = path.join(homedir(), ".ssh/authorized_keys");
    const keyStat = await lstat(keys).catch(() => null);
    if (keyStat && !keyStat.isSymbolicLink() && keyStat.isFile()) {
      const before = await readFile(keys, "utf8"), after = upgradeKeys(before);
      if (after.changed) {
        await copyFile(keys, keys + `.phren-hook-${Date.now()}.bak`);
        if (await readFile(keys, "utf8") !== before) throw new Error("authorized_keys changed during installation. Run install again.");
        await atomic(keys, after.text, keyStat.mode & 0o777);
      }
      console.log(`Updated ${after.changed} Phren iPhone key(s); other keys were preserved.`);
    }
    await atomic(path.join(root, "installed.json"), JSON.stringify({ version, previous: previous?.version === version ? previous.previous : previous?.version, node: process.execPath, gateway, store: modules.store }, null, 2) + "\n");
    // Last, so a failed install restores hooks.json without leaving trust for entries it no longer has.
    await carryCodexHookTrust(program, codexHooksBefore(hookEdits));
    console.log("Agent hooks installed. In Codex, review the new Phren entries in /hooks. Existing agents may need to resume before new hooks load.");
    console.log(`SSH gateway: ${gateway}${gateway === "node" ? " (no socat or nc -U found)" : ""}.`);
    console.log(`Phren Hook ${version} installed${noService ? " (service not started)" : " and running"}. Run phren bridge doctor.`);
  } catch (error) {
    await restoreAgentHooks(hookEdits);
    if (!noService) await stopService();
    if (previous?.version) {
      if (previous.version === version && previousBundle) {
        await writeFile(stagedBundle, previousBundle); await rename(stagedBundle, installedBundle);
      }
      await activate(previous.version);
      if (!noService) await startService();
    }
    throw error;
  }
}

export async function uninstall() {
  await stopService();
  if (process.platform === "darwin") await unlink(launchAgentPlist()).catch(() => {});
  else { await exec("systemctl", ["--user", "disable", unit]).catch(() => {}); await unlink(path.join(homedir(), ".config/systemd/user", unit)).catch(() => {}); await exec("systemctl", ["--user", "daemon-reload"]).catch(() => {}); }
  await applyAgentHooks(await planAgentHooks(path.join(bridgeRoot(), "current/bridge-hook.mjs"), true));
  await applyOpencodePlugin(true);
  await removeAskpass();
  // Preserve journal, settings, uploaded images, rollback version and SSH backups.
  console.log("Phren Hook stopped and its background service removed. Remove phren-iphone, phren-android, phren-computer and phren-gitboy keys from authorized_keys to revoke device access. Local data remains in " + bridgeRoot());
}

interface SettingsEdit { file: string; before?: string; after: string }

async function missingFile<T>(operation: Promise<T>): Promise<T | undefined> {
  try { return await operation; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Whether the version `current/` points at ships the Claude forwarder; one
 * from before it does not, and its Claude callbacks run the bundle. */
const currentHasFastHook = (root: string) => access(fastHookPath(path.join(root, "current"))).then(() => true, () => false);

export async function planAgentHooks(program: string, remove = false, modules?: ModuleSnapshot, fastClaude = true): Promise<SettingsEdit[]> {
  const edits: SettingsEdit[] = [];
  // Extra Claude homes (one per account) get the same hooks; a symlinked settings.json shares another home's, so it is skipped.
  const extraClaude = claudeHomes().slice(1).map(home => ["claude", path.join(home.dir, "settings.json")] as const);
  for (const [source, file] of [
    ["codex", path.join(codexHome(), "hooks.json")],
    ["claude", path.join(claudeConfigDir(), "settings.json")],
    ...extraClaude,
    ["copilot", path.join(process.env.COPILOT_HOME || path.join(homedir(), ".copilot"), "hooks/phren.json")],
  ]) {
    const metadata = await missingFile(lstat(file));
    if (metadata && extraClaude.some(([, extra]) => extra === file) && (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 2_097_152)) continue;
    if (metadata && (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 2_097_152)) {
      throw new Error(`Agent settings require a manual update: ${file}`);
    }
    const before = await missingFile(readFile(file, "utf8"));
    if ((remove || modules?.has("hook") === false) && before === undefined) continue;
    const parsed: unknown = before === undefined ? {} : JSON.parse(before);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid agent settings: ${file}`);
    const config = object(parsed);
    if (config.hooks !== undefined && (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks))) throw new Error(`Invalid hook configuration: ${file}`);
    const hooks = object(config.hooks);
    // Claude's callbacks run the small forwarder beside the bundle (hook-fast.ts)
    // instead of loading the whole bundle for every event.
    const fast = fastHookPath(path.dirname(program));
    const command = source === "claude" && fastClaude ? `${quote(process.execPath)} ${quote(fast)} claude` : `${quote(process.execPath)} ${quote(program)} hook ${source}`;
    const ownHook = (entry: unknown) => typeof entry === "string" && (entry.endsWith(` ${quote(program)} hook ${source}`) || (source === "claude" && entry.endsWith(` ${quote(fast)} claude`)));
    if (remove || modules?.has("hook") === false) {
      const owned = Object.values(hooks).flatMap(objects).some(group => ownHook(group.command) || ownHook(group.bash) || objects(group.hooks).some(hook => ownHook(hook.command)));
      const statusChanged = source === "claude" && JSON.stringify(usageStatusLine(config.statusLine, program, true)) !== JSON.stringify(config.statusLine);
      if (!owned && !statusChanged) continue;
    }
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest", "PreToolUse", "PostToolUse", ...(source === "claude" ? ["PreCompact"] : [])]) {
      if (hooks[event] !== undefined && (!Array.isArray(hooks[event]) || (hooks[event] as unknown[]).some(v => !v || typeof v !== "object" || Array.isArray(v)))) throw new Error(`Invalid ${event} hooks: ${file}`);
      if (source !== "copilot" && objects(hooks[event]).some(g => !Array.isArray(g.hooks))) throw new Error(`Invalid ${event} hook group: ${file}`);
    }
    if (source === "copilot") {
      config.version = 1;
      for (const event of ["SessionStart", "UserPromptSubmit"]) {
        const entries = objects(hooks[event]).filter(h => !ownHook(h.bash) && !ownHook(h.command));
        hooks[event] = remove || modules?.has("hook") === false ? entries : [...entries, { type: "command", bash: command, timeoutSec: 15 }];
      }
    } else {
      for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest", "PreToolUse", "PostToolUse", ...(source === "claude" ? ["PreCompact"] : [])]) {
        const groups = objects(hooks[event]).map(group => ({ ...group, hooks: objects(group.hooks).filter(h => !ownHook(h.command)) })).filter(group => group.hooks.length);
        // Snapshot shell and file-edit calls so every card can show actual
        // changed-file rows, including files outside the original cwd.
        // Codex names tools differently across versions; filter its callbacks
        // inside the Hook. Claude can narrow its registration here.
        const group = event.endsWith("ToolUse") ? { ...(source === "claude" ? { matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit|apply_patch|str_replace_editor" } : {}), hooks: [{ type: "command", command, timeout: 10 }] }
          : { hooks: [{ type: "command", command, timeout: event === "PermissionRequest" ? 60 : 15 }] };
        const owner = event.endsWith("ToolUse") ? "git" : "hook";
        hooks[event] = remove || modules?.has("hook") === false || modules?.has(owner) === false ? groups : [...groups, group];
      }
    }
    config.hooks = hooks;
    if (source === "claude") {
      const statusLine = usageStatusLine(config.statusLine, program, remove || modules?.has("hook") === false);
      if (statusLine === undefined) delete config.statusLine; else config.statusLine = statusLine;
    }
    const after = JSON.stringify(config, null, 2) + "\n";
    if (after === before) continue;
    edits.push({ file, before, after });
  }
  return edits;
}

const opencodePluginsDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode", "plugins");
declare const OPENCODE_PLUGIN_SOURCE: string | undefined;
/** The first line of every plugin copy phren wrote; a copy without it belongs to the user. */
export const OPENCODE_PLUGIN_MARKER = "// Installed by Phren Hook";
/** Whether to (re)write the installed plugin: a missing copy, or one phren wrote that is now out of date. */
export function opencodePluginNeedsWrite(existing: string | undefined, source: string): boolean {
  if (existing === undefined) return true;
  if (existing === source) return false;
  return existing.startsWith(OPENCODE_PLUGIN_MARKER);
}
async function opencodePluginSource(): Promise<string | undefined> {
  if (typeof OPENCODE_PLUGIN_SOURCE === "string") return OPENCODE_PLUGIN_SOURCE;
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.join(here, "..", "..", "plugins", "opencode", "phren-transcript.js"),
    path.join(here, "..", "plugins", "opencode", "phren-transcript.js"),
  ]) {
    const source = await missingFile(readFile(candidate, "utf8"));
    if (source !== undefined) return source;
  }
  return undefined;
}
async function applyOpencodePlugin(remove = false): Promise<boolean> {
  const dir = opencodePluginsDir(), file = path.join(dir, "phren-transcript.js");
  const source = await opencodePluginSource();
  const existing = await missingFile(readFile(file, "utf8"));
  if (remove) {
    if (existing !== undefined && (existing === source || existing.startsWith(OPENCODE_PLUGIN_MARKER))) await unlink(file);
    return false;
  }
  if (source === undefined || !opencodePluginNeedsWrite(existing, source)) return false;
  if (!(await lstat(path.dirname(dir)).catch(() => null))?.isDirectory()) return false;
  await mkdir(dir, { recursive: true });
  await atomic(file, source, 0o644);
  return true;
}

async function applyAgentHooks(edits: SettingsEdit[]) {
  for (const { file, before, after } of edits) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    if (await missingFile(readFile(file, "utf8")) !== before) throw new Error("Agent settings changed during installation. Run install again.");
    if (before !== undefined) await copyFile(file, file + `.phren-hook-${Date.now()}.bak`);
    await atomic(file, after);
  }
}

/** Codex's hooks.json as it stood before `edits` rewrote it, when they did. */
const codexHooksBefore = (edits: SettingsEdit[]) => edits.find(edit => edit.file === path.join(codexHome(), "hooks.json"))?.before;

async function restoreAgentHooks(edits: SettingsEdit[]) {
  for (const { file, before, after } of edits) {
    // A concurrent user edit always wins over rollback.
    if (await missingFile(readFile(file, "utf8")) !== after) continue;
    if (before === undefined) await unlink(file); else await atomic(file, before);
  }
}

export async function rollback() {
  const config = JSON.parse(await readFile(path.join(bridgeRoot(), "installed.json"), "utf8")) as { version: string; previous?: string; store?: string };
  if (!config.previous || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(config.previous)) throw new Error("No previous helper version is available.");
  await stopService(); await activate(config.previous); await startService();
  // The version now in `current/` decides whether Claude's callbacks run its
  // forwarder or, from before the forwarder, its bundle.
  const root = bridgeRoot();
  const program = path.join(root, "current/bridge-hook.mjs");
  const edits = await planAgentHooks(program, false, moduleSnapshot(defaultPhrenPath(), undefined, true), await currentHasFastHook(root));
  await applyAgentHooks(edits);
  await carryCodexHookTrust(program, codexHooksBefore(edits));
  await atomic(path.join(bridgeRoot(), "installed.json"), JSON.stringify({ version: config.previous, previous: config.version, ...(config.store ? { store: config.store } : {}) }) + "\n");
}

export async function reconcileModuleHooks(store: string, profile?: string): Promise<void> {
  const modules = moduleSnapshot(store, profile);
  const root = bridgeRoot();
  // Synced enablement alone never installs a host service or enrolls a key.
  const installed = await missingFile(readFile(path.join(root, "installed.json"), "utf8"));
  if (!installed) return;
  // The Hook serves the store it was installed with. `phren init` or `link`
  // on another store (a scratch store, a test's) must not stop it or rewrite
  // its agent hooks: a test run inside a Hook-launched worker did exactly that.
  const served = (() => { try { return object(JSON.parse(installed)).store; } catch { return undefined; } })();
  if (typeof served === "string" && path.resolve(served) !== path.resolve(store)) return;
  const program = path.join(root, "current/bridge-hook.mjs");
  const edits = await planAgentHooks(program, false, modules, await currentHasFastHook(root));
  await applyAgentHooks(edits);
  await carryCodexHookTrust(program, codexHooksBefore(edits));
  await applyOpencodePlugin(!modules.has("hook"));
  if (!modules.has("hook")) await stopService();
}
