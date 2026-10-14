// What the Node extension host (reh.ts) is allowed to reach. It runs
// extensions' Node code as the owner, so everything the daemon holds that would
// let that code act as the desktop stays out of its reach:
//
// - environment: no PHREN_* (the daemon token's fd number among them), no SSH
//   agent, no terminal multiplexer, no VS Code IPC hook, no variable that looks
//   like a credential; HOME, TMPDIR and XDG_RUNTIME_DIR point at the host's own
//   folders, so tools that default to ~/.ssh or ~/.npmrc find nothing there;
// - file descriptors: the daemon closes the token pipe after reading it, and the
//   host gets only stdin (/dev/null), stdout and stderr;
// - on macOS, sandbox-exec with HOST_PROFILE below: reading or writing the bridge
//   folder (the desktop key, hooks.yaml, desktop.yaml, known_hosts), the SSH
//   ControlMaster folder, the desktop's traces and cookies, and connecting to
//   the Hook socket, the SSH agent, Herdr or tmux are denied; so are AppleEvents,
//   LaunchServices opens, launchd jobs and cron, which would run code outside
//   the sandbox. Everything else (the owner's projects, toolchains, the network)
//   stays allowed, because language servers need it.
//
// The host gets no daemon credential at all. Its one channel is the loopback
// WebSocket the editor page opens to it with the per-start connection token.
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeRoot } from "./hosts.js";

/** Variables dropped by name prefix: Phren's own, SSH, the terminal
 * multiplexers, Electron and VS Code (a desktop started from a VS Code terminal
 * would otherwise hand the host that window's IPC hook), npm's run context. */
const DROP_PREFIX = /^(PHREN_|SSH_|TMUX|HERDR_|ELECTRON_|VSCODE_|npm_)/i;
/** Variables dropped because their name says they carry a credential. */
const DROP_SECRET = /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTH(?!OR)|COOKIE|(^|_)KEY$/i;
/** Variables dropped because they hand a process a channel or code to load. */
const DROP_EXACT = new Set(["NODE_OPTIONS", "DBUS_SESSION_BUS_ADDRESS", "GIT_ASKPASS", "SUDO_ASKPASS", "OLDPWD"]);

/** Toolchains that find themselves through $HOME. Moving HOME would break
 * them, so each one that exists in the owner's home is pointed at explicitly. */
const TOOLCHAIN_HOMES: Record<string, string> = {
  CARGO_HOME: ".cargo",
  RUSTUP_HOME: ".rustup",
  GOPATH: "go",
  PYENV_ROOT: ".pyenv",
  NVM_DIR: ".nvm",
  VOLTA_HOME: ".volta",
  BUN_INSTALL: ".bun",
  SDKMAN_DIR: ".sdkman",
  GIT_CONFIG_GLOBAL: ".gitconfig",
};

export interface HostDirs {
  /** The host's own HOME and cwd. */
  home: string;
  /** Its TMPDIR and XDG_RUNTIME_DIR (short: language servers put sockets there). */
  tmp: string;
  /** VS Code's server data folder. */
  agentFolder: string;
}

/** The Node extension host's environment: `base` minus anything that grants the
 * desktop's access, with its own HOME and temporary folders. */
export function hostEnv(base: NodeJS.ProcessEnv, dirs: HostDirs, ownerHome = homedir()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || DROP_PREFIX.test(key) || DROP_SECRET.test(key) || DROP_EXACT.has(key)) continue;
    env[key] = value;
  }
  for (const [key, relative] of Object.entries(TOOLCHAIN_HOMES)) {
    if (env[key]) continue;
    const where = path.join(ownerHome, relative);
    if (existsSync(where)) env[key] = where;
  }
  env.HOME = dirs.home;
  env.PWD = dirs.home;
  env.TMPDIR = dirs.tmp;
  env.TMP = dirs.tmp;
  env.TEMP = dirs.tmp;
  if (process.platform !== "darwin") env.XDG_RUNTIME_DIR = dirs.tmp;
  env.VSCODE_AGENT_FOLDER = dirs.agentFolder;
  return env;
}

/** A private 0700 folder owned by this user (created if missing), never a symlink. */
export function privateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${dir} must be a directory.`);
  if (process.platform === "win32") return dir;
  if (info.uid !== userInfo().uid) throw new Error(`${dir} must be a directory owned by you.`);
  // One of ours made before it had to be private: tighten it.
  if (info.mode & 0o077) chmodSync(dir, 0o700);
  return dir;
}

/** The host's temporary folder: short, because unix socket paths are capped at
 * 104 bytes on macOS and VS Code puts its IPC sockets there. */
export const hostTmpDir = (): string =>
  process.platform === "win32" ? path.join(tmpdir(), "phren-reh") : `/tmp/phren-reh-${userInfo().uid}`;

/**
 * The macOS sandbox profile. Paths come in as parameters (`-D NAME=path`), so
 * no path is ever spliced into the profile's text. Rules are evaluated last
 * match wins, after `(allow default)`.
 */
export const HOST_PROFILE = `(version 1)
(allow default)
(deny file-read* file-write* (subpath (param "BRIDGE")))
(deny file-read* file-write* (subpath (param "CONTROL")))
(deny file-read* file-write* (subpath (param "TRACES")))
(deny file-read* file-write* (subpath (param "APPDATA")))
(deny file-write* (subpath (param "DESKTOP_CONFIG")) (subpath (param "DESKTOP_CODE")) (subpath (param "LAUNCH_AGENTS")))
(deny network-outbound (remote unix-socket (subpath (param "BRIDGE"))))
(deny network-outbound (remote unix-socket (subpath (param "CONTROL"))))
(deny network-outbound (remote unix-socket (subpath (param "HERDR"))))
(deny network-outbound (remote unix-socket (subpath (param "TMUX"))))
(deny network-outbound (remote unix-socket (regex #"^/private/tmp/com\\.apple\\.launchd\\.[^/]+/Listeners$")))
(deny appleevent-send)
(deny mach-lookup (global-name "com.apple.coreservices.appleevents"))
(deny lsopen)
(deny process-exec (literal "/bin/launchctl") (literal "/usr/bin/crontab") (literal "/usr/bin/at") (literal "/usr/bin/osascript") (literal "/usr/bin/open"))
`;

/** A path the profile can match: absolute and with symlinks resolved as far as
 * it exists (/tmp is /private/tmp on macOS, and the sandbox sees real paths). */
function real(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = path.dirname(head);
    if (parent === head) break;
    tail.unshift(path.basename(head));
    head = parent;
  }
  try { head = realpathSync(head); } catch { /* keep it as given */ }
  return path.join(head, ...tail);
}

/** The folders the profile protects, resolved for this computer. */
export function protectedPaths(): Record<string, string> {
  const home = homedir();
  const config = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const cache = process.env.XDG_CACHE_HOME || path.join(home, ".cache");
  const tmuxDir = process.env.TMUX_TMPDIR || "/tmp";
  // The daemon's own code: protected only in an installed app, so a developer
  // can still edit this checkout in the editor.
  const code = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  return {
    BRIDGE: real(bridgeRoot()),
    CONTROL: real(`/tmp/phren-desktop-${userInfo().uid}`),
    TRACES: real(path.join(cache, "phren", "desktop-traces")),
    APPDATA: real(path.join(home, "Library", "Application Support", "Phren")),
    DESKTOP_CONFIG: real(process.env.PHREN_DESKTOP_EXTENSIONS || path.join(config, "phren", "desktop-extensions")),
    DESKTOP_CODE: /\.app\/Contents\//.test(code) ? real(code) : "/nonexistent/phren-desktop-code",
    LAUNCH_AGENTS: real(path.join(home, "Library", "LaunchAgents")),
    HERDR: real(process.env.PHREN_HERDR_HOME || path.join(home, ".config", "herdr")),
    TMUX: real(path.join(tmuxDir, `tmux-${userInfo().uid}`)),
  };
}

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** How the host is isolated on this computer: an OS sandbox, or only its
 * environment and folders. */
export function isolation(): "sandbox" | "environment" {
  if (process.env.PHREN_REH_SANDBOX === "off") return "environment";
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC) ? "sandbox" : "environment";
}

/** The command line that runs `command args` isolated: under sandbox-exec on
 * macOS, else as is. */
export function isolatedCommand(command: string, args: string[], paths = protectedPaths()): { command: string; args: string[] } {
  if (isolation() !== "sandbox") return { command, args };
  const params = Object.entries(paths).flatMap(([name, value]) => ["-D", `${name}=${value}`]);
  return { command: SANDBOX_EXEC, args: ["-p", HOST_PROFILE, ...params, command, ...args] };
}
