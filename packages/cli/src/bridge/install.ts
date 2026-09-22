import { activateModules as moduleSnapshot, type ModuleSnapshot } from "../modules/runtime.js";
import { defaultPhrenPath } from "../shared.js";
import { disabledHint } from "../modules/registry.js";
import { execFile } from "node:child_process";
import { usageStatusLine } from "./usage.js";
import { chmod, copyFile, mkdir, open, readFile, rename, symlink, unlink, lstat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { bridgeRoot, object, objects, atomic, socketPath } from "./protocol.js";
import { herdrRoot } from "./herdr.js";
import { health } from "./transport.js";

const exec = promisify(execFile);
const label = "com.phren.hook";
const unit = "phren-hook.service";
export const forcedCommand = 'command="sh ~/.local/share/phren/bridge/dispatch"';
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
    if (!parsed || parsed.options[0] !== "restrict" || !/^\s+ssh-ed25519 [A-Za-z0-9+/=]+ phren-iphone\s*$/.test(parsed.rest)) return line;
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

async function activate(version: string) {
  const root = bridgeRoot();
  const next = path.join(root, `current-${process.pid}`);
  await symlink(path.join("versions", version), next);
  await rename(next, path.join(root, "current"));
}

async function stopService() {
  if (process.platform === "darwin") await exec("launchctl", ["bootout", `gui/${process.getuid!()}/${label}`]).catch(() => {});
  else await exec("systemctl", ["--user", "stop", unit]).catch(() => {});
}
async function startService() {
  if (process.platform === "darwin") {
    // bootout returns before launchd finishes releasing the old job. A valid
    // immediate bootstrap can transiently fail with EIO during an update.
    for (let attempt = 0; ; attempt++) {
      try {
        await exec("launchctl", ["bootstrap", `gui/${process.getuid!()}`, path.join(homedir(), "Library/LaunchAgents", `${label}.plist`)]);
        break;
      } catch (error) {
        if (attempt >= 5 || !String((error as { stderr?: string }).stderr).includes("Bootstrap failed: 5:")) throw error;
        await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
      }
    }
  }
  else { await exec("systemctl", ["--user", "daemon-reload"]); await exec("systemctl", ["--user", "enable", "--now", unit]); }
}

export async function install(version: string, noService = false): Promise<void> {
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
  const previous = await readFile(path.join(root, "installed.json"), "utf8").then(v => JSON.parse(v) as { version: string; previous?: string }).catch(() => null);
  const gateway = await detectGateway();
  await atomic(path.join(root, "dispatch"), gatewayScript(gateway, {
    root, herdr, store: modules.store, profile: modules.profile, node: process.execPath,
    bundle: path.join(root, "current/bridge-hook.mjs"), socket: socketPath(), timing: path.join(root, "gateway.json"),
  }), 0o700);
  const environmentPath = [path.dirname(process.execPath), path.join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin"].join(":");
  const program = path.join(root, "current/bridge-hook.mjs");
  if (!noService) {
    if (process.platform === "darwin") {
      const folder = path.join(homedir(), "Library/LaunchAgents"); await mkdir(folder, { recursive: true });
      await atomic(path.join(folder, `${label}.plist`), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(program)}</string><string>serve</string></array><key>Umask</key><integer>63</integer><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>Nice</key><integer>-5</integer><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(environmentPath)}</string><key>PHREN_BRIDGE_HOME</key><string>${xml(root)}</string><key>PHREN_HERDR_HOME</key><string>${xml(herdr)}</string><key>PHREN_PATH</key><string>${xml(modules.store)}</string><key>PHREN_PROFILE</key><string>${xml(modules.profile)}</string></dict><key>StandardErrorPath</key><string>${xml(path.join(root, "service.log"))}</string></dict></plist>\n`);
    } else {
      const folder = path.join(homedir(), ".config/systemd/user"); await mkdir(folder, { recursive: true });
      await atomic(path.join(folder, unit), `[Unit]\nDescription=Phren Hook\n[Service]\nExecStart=${systemdQuote(process.execPath)} ${systemdQuote(program)} serve\nNice=-5\nEnvironment=${systemdQuote("PATH=" + environmentPath)} ${systemdQuote("PHREN_BRIDGE_HOME=" + root)} ${systemdQuote("PHREN_HERDR_HOME=" + herdr)} ${systemdQuote("PHREN_PATH=" + modules.store)} ${systemdQuote("PHREN_PROFILE=" + modules.profile)}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n[Install]\nWantedBy=default.target\n`);
    }
    await stopService();
  }
  await activate(version);
  try {
    if (!noService) {
      await startService();
      let ready = false;
      for (let i = 0; i < 30; i++) {
        try { const status = await health(); ready = status.version === version; } catch { /* bounded readiness check */ }
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!ready) throw new Error("The new Phren Hook did not become ready.");
    }
    await applyAgentHooks(hookEdits);
    if (await applyOpencodePlugin()) {
      console.log("opencode chat: restart any opencode session started before now so it loads the transcript plugin.");
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
    await atomic(path.join(root, "installed.json"), JSON.stringify({ version, previous: previous?.version === version ? previous.previous : previous?.version, node: process.execPath, gateway }, null, 2) + "\n");
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
  if (process.platform === "darwin") await unlink(path.join(homedir(), "Library/LaunchAgents", `${label}.plist`)).catch(() => {});
  else { await exec("systemctl", ["--user", "disable", unit]).catch(() => {}); await unlink(path.join(homedir(), ".config/systemd/user", unit)).catch(() => {}); await exec("systemctl", ["--user", "daemon-reload"]).catch(() => {}); }
  await applyAgentHooks(await planAgentHooks(path.join(bridgeRoot(), "current/bridge-hook.mjs"), true));
  await applyOpencodePlugin(true);
  // Preserve journal, settings, uploaded images, rollback version and SSH backups.
  console.log("Phren Hook stopped and its background service removed. Remove phren-iphone and phren-computer keys from authorized_keys to revoke device access. Local data remains in " + bridgeRoot());
}

interface SettingsEdit { file: string; before?: string; after: string }

async function missingFile<T>(operation: Promise<T>): Promise<T | undefined> {
  try { return await operation; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function planAgentHooks(program: string, remove = false, modules?: ModuleSnapshot): Promise<SettingsEdit[]> {
  const edits: SettingsEdit[] = [];
  for (const [source, file] of [
    ["codex", path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "hooks.json")],
    ["claude", path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "settings.json")],
    ["copilot", path.join(process.env.COPILOT_HOME || path.join(homedir(), ".copilot"), "hooks/phren.json")],
  ]) {
    const metadata = await missingFile(lstat(file));
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
    const command = `${quote(process.execPath)} ${quote(program)} hook ${source}`;
    const ownHook = (entry: unknown) => typeof entry === "string" && entry.endsWith(` ${quote(program)} hook ${source}`);
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
        hooks[event] = remove || modules?.has("hook") === false ? entries : [...entries, { type: "command", bash: command, timeoutSec: 3 }];
      }
    } else {
      for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest", "PreToolUse", "PostToolUse", ...(source === "claude" ? ["PreCompact"] : [])]) {
        const groups = objects(hooks[event]).map(group => ({ ...group, hooks: objects(group.hooks).filter(h => !ownHook(h.command)) })).filter(group => group.hooks.length);
        // Snapshot shell and file-edit calls so every card can show actual
        // changed-file rows, including files outside the original cwd.
        // Codex names tools differently across versions; filter its callbacks
        // inside the Hook. Claude can narrow its registration here.
        const group = event.endsWith("ToolUse") ? { ...(source === "claude" ? { matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit|apply_patch|str_replace_editor" } : {}), hooks: [{ type: "command", command, timeout: 10 }] }
          : { hooks: [{ type: "command", command, timeout: event === "PermissionRequest" ? 60 : 3 }] };
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

async function restoreAgentHooks(edits: SettingsEdit[]) {
  for (const { file, before, after } of edits) {
    // A concurrent user edit always wins over rollback.
    if (await missingFile(readFile(file, "utf8")) !== after) continue;
    if (before === undefined) await unlink(file); else await atomic(file, before);
  }
}

export async function rollback() {
  const config = JSON.parse(await readFile(path.join(bridgeRoot(), "installed.json"), "utf8")) as { version: string; previous?: string };
  if (!config.previous || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(config.previous)) throw new Error("No previous helper version is available.");
  await stopService(); await activate(config.previous); await startService();
  await atomic(path.join(bridgeRoot(), "installed.json"), JSON.stringify({ version: config.previous, previous: config.version }) + "\n");
}

export async function reconcileModuleHooks(store: string, profile?: string): Promise<void> {
  const modules = moduleSnapshot(store, profile);
  const root = bridgeRoot();
  // Synced enablement alone never installs a host service or enrolls a key.
  if (!await missingFile(readFile(path.join(root, "installed.json")))) return;
  await applyAgentHooks(await planAgentHooks(path.join(root, "current/bridge-hook.mjs"), false, modules));
  await applyOpencodePlugin(!modules.has("hook"));
  if (!modules.has("hook")) await stopService();
}
