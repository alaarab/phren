import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rename, symlink, unlink, lstat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { bridgeRoot, object, objects } from "./protocol.js";
import { health } from "./transport.js";

const exec = promisify(execFile);
const label = "com.phren.hook";
const unit = "phren-hook.service";
export const forcedCommand = 'command="sh ~/.local/share/phren/bridge/dispatch"';
export function upgradeKeys(text: string): { text: string; changed: number } {
  let changed = 0;
  const result = text.split(/(?<=\n)/).map(line => {
    if (!/ ssh-ed25519 [A-Za-z0-9+/=]+ phren-iphone\s*$/.test(line) || !line.startsWith("restrict,") || !line.includes('permitopen="127.0.0.1:')) return line;
    const old = /command="(?:\/usr\/bin\/false|python3 ~\/\.local\/share\/phren\/chat-progress\.py|sh ~\/\.local\/share\/phren\/bridge\/dispatch)"/;
    if (!old.test(line)) return line;
    let next = line.replace(old, forcedCommand);
    if (!/(^|,)pty,/.test(next)) next = next.replace(/^restrict,/, "restrict,pty,");
    if (next !== line) changed++;
    return next;
  }).join("");
  return { text: result, changed };
}
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const systemdQuote = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%") + '"';

async function atomic(file: string, text: string, mode = 0o600) {
  const temporary = file + `.phren-${process.pid}`;
  await writeFile(temporary, text, { mode, flag: "wx" });
  try { await rename(temporary, file); } finally { await unlink(temporary).catch(() => {}); }
}

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
  const root = bridgeRoot(), versions = path.join(root, "versions");
  await mkdir(versions, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
  const hookEdits = await planAgentHooks(path.join(root, "current/bridge-hook.mjs"));
  const own = fileURLToPath(import.meta.url);
  const bundle = own.endsWith("bridge-hook.mjs") ? own : path.join(path.dirname(own), "..", "bridge-hook.mjs");
  const destination = path.join(versions, version);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const installedBundle = path.join(destination, "bridge-hook.mjs");
  const previousBundle = await missingFile(readFile(installedBundle));
  const stagedBundle = installedBundle + `.phren-${process.pid}`;
  await copyFile(bundle, stagedBundle); await rename(stagedBundle, installedBundle);
  const previous = await readFile(path.join(root, "installed.json"), "utf8").then(v => JSON.parse(v) as { version: string; previous?: string }).catch(() => null);
  await atomic(path.join(root, "dispatch"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, "current/bridge-hook.mjs"))} ssh\n`, 0o700);
  const environmentPath = [path.dirname(process.execPath), path.join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin"].join(":");
  const program = path.join(root, "current/bridge-hook.mjs");
  if (!noService) {
    if (process.platform === "darwin") {
      const folder = path.join(homedir(), "Library/LaunchAgents"); await mkdir(folder, { recursive: true });
      await atomic(path.join(folder, `${label}.plist`), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(program)}</string><string>serve</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(environmentPath)}</string><key>PHREN_BRIDGE_HOME</key><string>${xml(root)}</string></dict><key>StandardErrorPath</key><string>${xml(path.join(root, "service.log"))}</string></dict></plist>\n`);
    } else {
      const folder = path.join(homedir(), ".config/systemd/user"); await mkdir(folder, { recursive: true });
      await atomic(path.join(folder, unit), `[Unit]\nDescription=Phren Hook\n[Service]\nExecStart=${systemdQuote(process.execPath)} ${systemdQuote(program)} serve\nEnvironment=${systemdQuote("PATH=" + environmentPath)} ${systemdQuote("PHREN_BRIDGE_HOME=" + root)}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n[Install]\nWantedBy=default.target\n`);
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
    await atomic(path.join(root, "installed.json"), JSON.stringify({ version, previous: previous?.version === version ? previous.previous : previous?.version, node: process.execPath }, null, 2) + "\n");
    console.log("Agent hooks installed. In Codex, review the new Phren entries in /hooks. Existing agents may need to resume before new hooks load.");
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
  // Preserve journal, settings, uploaded images, rollback version and SSH backups.
  console.log("Phren Hook stopped and its background service removed. Remove phren-iphone keys from authorized_keys to revoke iPhone access. Local data remains in " + bridgeRoot());
}

interface SettingsEdit { file: string; before?: string; after: string }

async function missingFile<T>(operation: Promise<T>): Promise<T | undefined> {
  try { return await operation; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function planAgentHooks(program: string, remove = false): Promise<SettingsEdit[]> {
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
    if (remove && before === undefined) continue;
    const parsed: unknown = before === undefined ? {} : JSON.parse(before);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid agent settings: ${file}`);
    const config = object(parsed);
    if (config.hooks !== undefined && (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks))) throw new Error(`Invalid hook configuration: ${file}`);
    const hooks = object(config.hooks);
    const command = `${quote(process.execPath)} ${quote(program)} hook ${source}`;
    const ownHook = (entry: unknown) => typeof entry === "string" && entry.endsWith(` ${quote(program)} hook ${source}`);
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest"]) {
      if (hooks[event] !== undefined && (!Array.isArray(hooks[event]) || (hooks[event] as unknown[]).some(v => !v || typeof v !== "object" || Array.isArray(v)))) throw new Error(`Invalid ${event} hooks: ${file}`);
      if (source !== "copilot" && objects(hooks[event]).some(g => !Array.isArray(g.hooks))) throw new Error(`Invalid ${event} hook group: ${file}`);
    }
    if (source === "copilot") {
      config.version = 1;
      for (const event of ["SessionStart", "UserPromptSubmit"]) {
        const entries = objects(hooks[event]).filter(h => !ownHook(h.bash) && !ownHook(h.command));
        hooks[event] = remove ? entries : [...entries, { type: "command", bash: command, timeoutSec: 3 }];
      }
    } else {
      for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest"]) {
        const groups = objects(hooks[event]).map(group => ({ ...group, hooks: objects(group.hooks).filter(h => !ownHook(h.command)) })).filter(group => group.hooks.length);
        hooks[event] = remove ? groups : [...groups, { hooks: [{ type: "command", command, timeout: event === "PermissionRequest" ? 60 : 3 }] }];
      }
    }
    config.hooks = hooks;
    const after = JSON.stringify(config, null, 2) + "\n";
    if (after === before) continue;
    edits.push({ file, before, after });
  }
  return edits;
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
