import { activateModules, moduleSnapshot, type ModuleSnapshot } from "./modules/runtime.js";
import { enableHookForPhone } from "./modules/config.js";
import { disabledCommand } from "./cli-registry.js";
import * as fs from "fs";
import * as path from "path";
import { errorMessage } from "./utils.js";
import { logger } from "./logger.js";
import {
  defaultPhrenPath,
  findPhrenPath,
  ensureFtsCacheRootPrivate,
  expandHomePath,
  getPhrenPath,
  readRootManifest,
} from "./shared.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";
import { VERSION } from "./package-metadata.js";
import {
  TOPIC_ORDER,
  helpTopicNames,
  lookupCommand,
  type CliContext,
  type Topic,
} from "./cli-registry.js";
import {
  formatCheatSheet,
  formatCommand,
  formatDocTopic,
  formatFullHelp,
  formatTopic,
} from "./cli-help.js";

export type TopLevelInvocation =
  | { kind: "manage"; argv: string[] }
  | { kind: "mcp"; phrenArg: string }
  // `phren mcp`: serve the store phren finds itself (the Claude Code plugin's entry).
  | { kind: "mcp-serve" }
  | { kind: "help" }
  | { kind: "version" };

function looksLikePhrenRootArg(arg: string | undefined): arg is string {
  if (!arg || arg.startsWith("-")) return false;
  try {
    const resolved = path.resolve(expandHomePath(arg));
    return fs.existsSync(resolved) && Boolean(readRootManifest(resolved));
  } catch {
    return false;
  }
}

function firstPositionalArg(argv: string[]): string | undefined {
  return argv.find((arg) => !arg.startsWith("-"));
}

export function resolveTopLevelInvocation(argv: string[]): TopLevelInvocation {
  const argvCommand = argv[0];
  const positional = firstPositionalArg(argv);

  if (looksLikePhrenRootArg(positional)) {
    return { kind: "mcp", phrenArg: positional };
  }

  if (argvCommand === "mcp" && argv.length === 1) {
    return { kind: "mcp-serve" };
  }

  if (argvCommand === "--help" || argvCommand === "-h") {
    // `phren --help all` reads like `phren help all`, so it does the same.
    return argv.length > 1 ? { kind: "manage", argv } : { kind: "help" };
  }

  if (argvCommand === "--version" || argvCommand === "-v" || argvCommand === "version") {
    return { kind: "version" };
  }

  if (argvCommand === "help") {
    return argv.length > 1 ? { kind: "manage", argv } : { kind: "help" };
  }

  if (argvCommand === "manage" || argvCommand === "mem") {
    return { kind: "manage", argv: argv.slice(1).length > 0 ? argv.slice(1) : [] };
  }

  if (!argvCommand) {
    return { kind: "manage", argv: [] };
  }

  return { kind: "manage", argv };
}

export function printIntegratedHelp(): void {
  console.log(formatCheatSheet(helpSnapshot()));
}

export function printIntegratedVersion(): void {
  console.log(`phren v${VERSION}`);
}

async function flushTopLevelOutput(): Promise<void> {
  await Promise.all([
    new Promise<void>((resolve) => process.stdout.write("", () => resolve())),
    new Promise<void>((resolve) => process.stderr.write("", () => resolve())),
  ]);
}

async function finish(exitCode?: number): Promise<true> {
  if (exitCode !== undefined) process.exitCode = exitCode;
  await flushTopLevelOutput();
  return true;
}

function buildCliContext(): CliContext {
  return {
    phrenPath: () => getPhrenPath(),
    profile: () => resolveRuntimeProfile(getPhrenPath()),
  };
}

function helpSnapshot(): ModuleSnapshot | undefined {
  try { return moduleSnapshot(findPhrenPath() ?? defaultPhrenPath()); }
  catch { return undefined; }
}

async function runHelp(args: string[]): Promise<true> {
  const snapshot = helpSnapshot();
  const target = args[0]?.toLowerCase();

  if (!target) {
    console.log(formatCheatSheet(helpSnapshot()));
    return finish();
  }

  if (target === "all") {
    console.log(formatFullHelp(snapshot));
    return finish();
  }

  // Topic precedence: a name that's both a topic and a command (e.g. "projects",
  // "skills") shows the topic view, which lists every command in that group.
  // Matches the legacy HELP_TOPICS behavior.
  if ((TOPIC_ORDER as readonly string[]).includes(target)) {
    console.log(formatTopic(target as Topic, snapshot));
    return finish();
  }

  const unavailable = snapshot && disabledCommand([target, ...args.slice(1)].join(" "), snapshot);
  if (unavailable) { console.log(unavailable); return finish(); }
  const cmdHelp = formatCommand(target, snapshot);
  if (cmdHelp !== null) {
    console.log(cmdHelp);
    return finish();
  }

  const docHelp = formatDocTopic(target);
  if (docHelp !== null) {
    console.log(docHelp);
    return finish();
  }

  console.log(`Unknown topic: ${target}\nAvailable: ${helpTopicNames().join(", ")}`);
  return finish();
}

export async function runTopLevelCommand(
  argv: string[],
  opts: { allowDefaultShell?: boolean } = {},
): Promise<boolean> {
  const argvCommand = argv[0];

  // Health ping. Must run before lookupCommand - `--health` starts with `--`
  // so it's never a registered command name.
  if (argvCommand === "--health") return finish();

  if (argvCommand === "--help" || argvCommand === "-h" || argvCommand === "help") {
    return runHelp(argv.slice(1));
  }

  // Bare invocation. On a TTY (and unless suppressed), drop into the shell.
  // On a non-TTY pipeline, fall through to the unknown-command path below;
  // matches legacy behavior so scripts that grep stderr for "Unknown command"
  // keep working.
  if (!argvCommand) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      if (opts.allowDefaultShell === false) {
        console.log(formatCheatSheet(helpSnapshot()));
        return finish();
      }
      const shellCmd = lookupCommand("shell");
      if (shellCmd) await shellCmd.run([], buildCliContext());
      return finish();
    }
    return false;
  }

  const cmd = lookupCommand(argvCommand);
  if (!cmd) return false;
  let snapshot: ModuleSnapshot | undefined;
  try {
    const store = findPhrenPath() ?? defaultPhrenPath();
    snapshot = ["modules", "init", "quickstart", "verify", "uninstall", "doctor"].includes(cmd.name) || argv.includes("--help") || argv.includes("-h")
      ? moduleSnapshot(store) : activateModules(store);
    const wantsHook = cmd.name === "pair" || (cmd.name === "bridge" && argv[1] === "install");
    if (wantsHook && !snapshot.has("hook") && !argv.includes("--help") && !argv.includes("-h")) {
      if (enableHookForPhone(store)) console.log("Turned on the Hook module for this store (phren modules disable hook turns it off).");
      snapshot = activateModules(store, undefined, true);
    }
    const unavailable = disabledCommand([cmd.name, ...argv.slice(1)].join(" "), snapshot);
    if (unavailable) { console.error(unavailable); return finish(1); }
  } catch (error) {
    if (!["init", "modules", "doctor", "verify", "uninstall", "link"].includes(cmd.name)) {
      console.error(errorMessage(error)); return finish(1);
    }
  }


  // Any command can end up building or reading the FTS snapshot cache, which
  // is a SQLite export of the whole store landing in os.tmpdir() — /tmp (1777)
  // on Linux and WSL. Harden the per-user cache root before the command runs.
  ensureFtsCacheRootPrivate();

  // Intercept before any handler runs - in particular before namespace
  // handlers that used to print their own per-subcommand help text.
  // `phren agent` hands every argument to the agent, which prints its own help.
  if (cmd.name !== "agent" && (argv.includes("--help") || argv.includes("-h")) || (argv.length === 1 && ["maintain", "config", "bridge"].includes(cmd.name))) {
    const out = formatCommand(cmd.name, snapshot);
    if (out) console.log(out);
    return finish();
  }

  // Telemetry. Broadens from the legacy CLI_COMMANDS-only branch - natives
  // (add/init/etc.) are now tracked too. Telemetry is opt-in. Hidden internal
  // commands (hook-prompt, background-sync, etc.) are skipped: they fire on
  // every prompt and would drown the meaningful counts.
  if (!cmd.hidden) {
    try {
      const { trackCliCommand } = await import("./telemetry.js");
      trackCliCommand(defaultPhrenPath(), cmd.name);
    } catch (err: unknown) {
      logger.debug("cli", `trackCliCommand: ${errorMessage(err)}`);
    }
  }

  try {
    const code = await cmd.run(argv.slice(1), buildCliContext());
    return finish(typeof code === "number" ? code : undefined);
  } catch (err: unknown) {
    console.error(errorMessage(err));
    return finish(1);
  }
}
