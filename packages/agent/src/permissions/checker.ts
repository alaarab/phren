import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PermissionConfig, PermissionRule } from "./types.js";
import { checkShellSafety, shellEnv } from "./shell-safety.js";
import { commandPaths, isAutoApprovableCommand, recursiveReads, splitCommandWords, type RecursiveRead } from "./shell-classify.js";
import { own } from "./shell-options.js";
import { evaluateRules } from "./rules.js";
import { validatePath, checkSensitivePath, checkSensitiveTarget, isPathInSandbox } from "./sandbox.js";
import { isAllowed } from "./allowlist.js";
import { parsePatch, patchPaths } from "../tools/apply-patch.js";

/** Tools that are safe in all modes — read-only, no side effects. */
export const READ_ONLY_TOOLS = new Set([
  "read_file",
  "glob",
  "grep",
  "read_image",
  "git_status",
  "git_diff",
  "task_output",
  "list_mcp_resources",
  "read_mcp_resource",
  "phren_search",
  "phren_get_tasks",
  "list_agents",
]);

/** Tools that access file paths and need sensitive-path checks. */
const FILE_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "multi_edit",
  "glob",
  "grep",
]);

/** Tools that auto-confirm mode allows without prompting. */
const AUTO_CONFIRM_TOOLS = new Set([
  "edit_file",
  "multi_edit",
  "apply_patch",
  "phren_add_finding",
  "phren_complete_task",
  // Spawning forks a child process running with auto-confirm permissions —
  // suggest mode must ask first (these were unprompted in every mode before).
  "spawn_agent",
  "send_message_to_agent",
]);

/** Tools that are always denied regardless of mode. */
const DENY_LIST_TOOLS = new Set<string>([
  // Reserved for future use — e.g. "delete_project"
]);

/** Search tools whose first positional is a pattern, not a file. */
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg"]);

/** A search tool's options that give the pattern (so no operand is one). */
const PATTERN_OPTION = /^(-e|--regexp)$/;
const PATTERN_OPTION_JOINED = /^(-e.|--regexp=)/;
/** Options whose value is a file of patterns: a path. */
const PATTERN_FILE_OPTION = /^(-f|--file)$/;

/** Is this path-like argument a secret file, under its own name or where it leads? */
function secretPath(value: string, cwd: string): boolean {
  const looksLikePath = /[/\\]/.test(value) || value.startsWith(".") || value.startsWith("~")
    || fs.existsSync(path.resolve(cwd, value));
  if (!looksLikePath) return false;
  const expanded = value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
  // Resolved against cwd, so `.aws/config` matches "/.aws/" like the absolute spelling; with a separator after
  // it too, so the directory `~/.ssh` itself matches "/.ssh/" (`git diff /var/empty ~/.ssh` prints its files).
  const abs = path.resolve(cwd, expanded), real = realTarget(cwd, expanded);
  return checkSensitivePath(value).sensitive || checkSensitiveTarget(abs, real).sensitive
    || checkSensitiveTarget(abs + path.sep, real === undefined ? undefined : real + path.sep).sensitive;
}

/**
 * Where a path argument leads, resolved as the kernel does: each symlink before the `..` after it, so
 * `link/../public.txt` is the public.txt beside link's target, not the one in cwd (path.resolve, and
 * fs.realpathSync, collapse the `..` first). A path that isn't there yet resolves through its folder.
 */
export function realTarget(cwd: string, value: string): string | undefined {
  const raw = path.isAbsolute(value) ? value : `${cwd}${path.sep}${value}`;
  try { return fs.realpathSync.native(raw); } catch { /* not there (yet) */ }
  try { return path.join(fs.realpathSync.native(path.dirname(raw)), path.basename(raw)); } catch { return undefined; }
}

/**
 * Whether a simple command names a secret file. Only arguments that look like
 * paths count (they exist, contain a separator, or start with `.` or `~`), and
 * a search tool's pattern is skipped, so `rg 'credentials.json' src` doesn't
 * ask. After `--` every argument is an operand.
 */
function namesSecretFile(tokens: string[], cwd: string): boolean {
  // A command this reader knows: exactly the files its own options parser reads (`rg -neTOKEN x` searches x).
  const known = commandPaths(tokens);
  if (known) return known.some((p) => secretPath(p, cwd));
  const [binary, ...args] = tokens;
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  const searchTool = PATTERN_FIRST.has(binary ?? "");
  // A pattern given by -e/--regexp or -f/--file: every operand is a path.
  let patternPending = searchTool && !options.some((a) =>
    PATTERN_OPTION.test(a) || PATTERN_OPTION_JOINED.test(a) || PATTERN_FILE_OPTION.test(a) || /^--file=/.test(a));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (end === -1 || i < end) {
      if (arg.startsWith("-")) {
        // An explicit pattern is not a path; skip it and its value.
        if (searchTool && PATTERN_OPTION.test(arg)) { i++; continue; }
        if (searchTool && PATTERN_OPTION_JOINED.test(arg)) continue;
        const eq = arg.indexOf("=");
        if (eq !== -1 && secretPath(arg.slice(eq + 1), cwd)) return true;
        continue;
      }
    } else if (i === end) continue;
    if (patternPending && !PATTERN_FILE_OPTION.test(args[i - 1] ?? "")) { patternPending = false; continue; }
    if (secretPath(arg, cwd)) return true;
  }
  return false;
}

/** git config that makes even a read (`git diff`, `git status`) run a configured program, and that no
 * override can switch off without knowing its driver's name: an external diff, a diff driver's command or
 * textconv, a clean/smudge/process filter. The rest (fsmonitor, the pager, signature checks) every agent
 * shell switches off itself (GIT_HARDENING, shell-safety.ts). */
const GIT_HELPER_KEYS = "^(diff\\.external|diff\\..+\\.(command|textconv)|filter\\..+\\.(clean|smudge|process)|format\\.pretty|pretty\\..+)$";

/** Which git reads run which helpers: diff programs where a diff or blob is shown, filters where the work
 * tree is compared with the index, a configured format (`format.pretty`, `pretty.<name>`) where commits are
 * printed. `git rev-parse` or `git ls-files` run none, so a difftool in the owner's config doesn't make
 * them ask. */
const HELPERS_RUN: Record<string, RegExp> = {
  diff: /^(diff|filter)\./, show: /^(diff|filter|format|pretty)\./, log: /^(diff|filter|format|pretty)\./,
  blame: /^(diff|filter)\./, grep: /^(diff|filter)\./, status: /^filter\./, shortlog: /^(format|pretty)\./,
};

/** The helper config git-lfs and git-crypt install, by key and exact value: the same program each time,
 * never a shell line someone wrote into the repository's config. */
const KNOWN_HELPERS: [RegExp, RegExp][] = [
  [/^filter\.lfs\.clean$/, /^git-lfs clean -- %f$/],
  [/^filter\.lfs\.smudge$/, /^git-lfs smudge( --skip)? -- %f$/],
  [/^filter\.lfs\.process$/, /^git-lfs filter-process( --skip)?$/],
  [/^filter\.git-crypt(-[\w-]+)?\.(clean|smudge)$/, /^"?(git-crypt|\/[\w./-]+\/git-crypt)"? (clean|smudge)( --key-name=[\w-]+)?$/],
  [/^diff\.git-crypt(-[\w-]+)?\.textconv$/, /^"?(git-crypt|\/[\w./-]+\/git-crypt)"? diff( --key-name=[\w-]+)?$/],
];

/** Whether `bin` is, where it really leads, inside `root` (case-folded where the file system usually is). */
function realInside(bin: string, root: string): boolean {
  const real = (p: string) => { try { return fs.realpathSync.native(p); } catch { return undefined; } };
  const target = real(bin), base = real(root) ?? root;
  if (target === undefined) return true;
  const fold = (p: string) => (process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p);
  return isPathInSandbox(fold(target), fold(base), []);
}

/** Whether `git <sub>`, run in `cwd`, has config that makes it run a program: a helper that subcommand uses
 * (other than git-lfs's and git-crypt's own, installed outside the project), or a configured log format that
 * verifies signatures (`%G`). A git that can't be asked can't vouch; with no cwd there (the command can't
 * start) nothing runs. */
export function gitRunsHelpers(cwd: string, projectRoot: string, sub: string): boolean {
  const runs = own(HELPERS_RUN, sub);
  if (!runs) return false;
  let out: string;
  try {
    out = execFileSync("git", ["config", "--get-regexp", GIT_HELPER_KEYS], {
      cwd, env: shellEnv(), encoding: "utf-8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch (err: unknown) {
    // Exit 1: no such key; ENOENT: no git, so nothing runs. Anything else (a timeout) can't vouch for the config.
    return (err as { status?: number }).status !== 1 && (err as { code?: string }).code !== "ENOENT";
  }
  return out.split("\n").filter(Boolean).some((line) => {
    const at = line.indexOf(" ");
    const key = at === -1 ? line : line.slice(0, at), value = at === -1 ? "" : line.slice(at + 1);
    if (!runs.test(key)) return false;
    if (/^(format|pretty)\./.test(key)) return value.includes("%G");
    const known = KNOWN_HELPERS.some(([k, v]) => k.test(key) && v.test(value));
    const bin = /^"?(\/[^"\s]+)/.exec(value)?.[1];
    return !known || (bin !== undefined && realInside(bin, projectRoot));
  });
}

/** Most files looked at below one directory a recursive read starts from; past it the command asks. */
export const RECURSIVE_WALK_LIMIT = 20_000;
/** As RECURSIVE_WALK_LIMIT, for a list git gives (cheap to check: no directory reads). */
const GIT_LIST_LIMIT = 200_000;

/** A list a program prints, NUL- or newline-separated, or undefined when it fails. Exit 1 is an empty list,
 * and so is a program that isn't installed: the command can't run it either. */
function listed(program: string, args: string[], cwd: string, separator: string): string[] | undefined {
  try {
    const out = execFileSync(program, args, { cwd, env: shellEnv(), encoding: "utf-8", timeout: 10_000,
      maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return out.split(separator).filter(Boolean);
  } catch (err: unknown) {
    const { status, code } = err as { status?: number; code?: string };
    return status === 1 || code === "ENOENT" ? [] : undefined;
  }
}

/** Whether any of `files` (relative to `cwd`) is a secret file, by name or, when `follow`, where it leads;
 * too many to look at counts. */
function secretAmong(files: string[], cwd: string, follow: boolean): boolean {
  if (files.length > GIT_LIST_LIMIT) return true;
  return files.some((file) => {
    const full = path.resolve(cwd, file);
    if (checkSensitivePath(full).sensitive) return true;
    if (!follow) return false;
    try { return checkSensitivePath(fs.realpathSync.native(full)).sensitive; } catch { return false; }
  });
}

/**
 * Whether a recursive read could reach a secret file. rg says itself which files it reads (`rg --files` with
 * the run's own filtering options: its ignore files, hidden and glob rules are not modelled here). git grep
 * reads the tracked files below cwd, and asks for an operand that is not a path there (a revision's tree,
 * deleted secrets included). Anything else is walked: every entry below each root, where the root really
 * leads (a symlink before the `..` after it); a symlink there asks when it follows symlinks, and so do too
 * many entries. A program that can't list counts as reaching one.
 */
function recursiveReachesSecret(read: RecursiveRead, cwd: string): boolean {
  // No cwd there: the command can't start.
  if (!fs.existsSync(cwd)) return false;
  if (read.scope === "rg") {
    // The shell expands `~/` before rg sees it.
    const roots = read.roots.map((r) => (r === "~" || r.startsWith("~/") ? path.join(os.homedir(), r.slice(1)) : r));
    const files = listed("rg", ["--files", "--null", ...(read.rgArgs ?? []), "--", ...roots], cwd, "\0");
    return files === undefined || secretAmong(files, cwd, read.follow);
  }
  for (const root of read.roots) {
    const expanded = root === "~" || root.startsWith("~/") ? path.join(os.homedir(), root.slice(1)) : root;
    const start = realTarget(cwd, expanded);
    let directory = false;
    try { directory = start !== undefined && fs.statSync(start).isDirectory(); } catch { /* not there */ }
    if (read.scope === "tracked") {
      if (!directory && !fs.existsSync(path.resolve(cwd, expanded))) return true;
      if (!directory) continue;
      const files = listed("git", ["ls-files", "-z", "--cached"], start!, "\0");
      if (files === undefined || secretAmong(files, start!, false)) return true;
      continue;
    }
    if (!directory || start === undefined) continue;
    if (checkSensitivePath(start + path.sep).sensitive) return true;
    const pending = [start];
    let seen = 0;
    while (pending.length) {
      const dir = pending.pop()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (++seen > RECURSIVE_WALK_LIMIT) return true;
        const full = path.join(dir, entry.name);
        if (checkSensitivePath(full).sensitive || checkSensitivePath(full + path.sep).sensitive) return true;
        if (entry.isSymbolicLink() && read.follow) return true;
        if (entry.isDirectory()) pending.push(full);
      }
    }
  }
  return false;
}

/**
 * Whether a shell command may reach a secret file or leave the sandbox: an argument names one, a word the
 * shell expands into file names (`cat config/*`) hides the names, a recursive read has one below it, git's
 * config runs a program on a read, or a `cd` goes outside the sandbox. Each segment's paths resolve where the
 * `cd`s before it left the shell (`cd ~/.aws && cat credentials`). A `cd` whose effect this can't tell asks:
 * no target or `-`; one that may be skipped (after `&&` or `||`: `false && cd src; grep -r .`) or runs in a
 * subshell (a pipeline); one followed by `||`, or by a later `||` (what comes after may run where the shell
 * started); and one to a directory it may not enter (not there, not searchable) unless only `&&` and `|`
 * follow it (when it fails, nothing after it runs; after `;` the rest runs where the shell was).
 */
function commandTouchesSecret(command: string, cwd: string, config: PermissionConfig): boolean {
  const segments = splitCommandWords(command);
  if (!segments) return false;
  let here = cwd;
  let moved = false;
  for (const [index, { words, globbed, before, after }] of segments.entries()) {
    if (globbed.some(Boolean)) return true;
    if (moved && before === "||") return true;
    if (words[0] === "cd") {
      if ((before !== "" && before !== ";") || after === "|" || after === "||") return true;
      const target = commandPaths(words)?.[0];
      if (target === undefined || target === "-") return true;
      const expanded = target === "~" || target.startsWith("~/") ? path.join(os.homedir(), target.slice(1)) : target;
      const next = path.resolve(here, expanded);
      const real = realTarget(here, expanded) ?? next;
      let enterable = false;
      try { enterable = fs.statSync(real).isDirectory(); fs.accessSync(real, fs.constants.X_OK); } catch { enterable = false; }
      const stopsOnFailure = segments.slice(index + 1).every((s) => s.before === "&&" || s.before === "|");
      if (!enterable && !stopsOnFailure) return true;
      if (!validatePath(next, config.projectRoot, config.allowedPaths).ok || !validatePath(real, config.projectRoot, config.allowedPaths).ok) return true;
      if (checkSensitiveTarget(next + path.sep, real + path.sep).sensitive) return true;
      here = next;
      moved = true;
      continue;
    }
    if (namesSecretFile(words, here)) return true;
    const sub = words[0] === "git" ? words.slice(1).find((w) => !w.startsWith("-")) : undefined;
    if (sub !== undefined && gitRunsHelpers(here, config.projectRoot, sub)) return true;
    const recursive = recursiveReads(words);
    if (recursive && recursiveReachesSecret(recursive, here)) return true;
  }
  return false;
}

/**
 * Check whether a tool call should be allowed, asked about, or denied.
 */
export function checkPermission(
  config: PermissionConfig,
  toolName: string,
  input: Record<string, unknown>,
): PermissionRule {
  // Deny-list always wins
  if (DENY_LIST_TOOLS.has(toolName)) {
    return { verdict: "deny", reason: `Tool "${toolName}" is on the deny list.` };
  }

  // apply_patch names its paths inside the patch text.
  let patchFiles: string[] = [];
  if (toolName === "apply_patch") {
    try {
      patchFiles = patchPaths(parsePatch(String(input.patch ?? "")));
    } catch {
      // Unparseable: the tool itself reports the error without writing.
    }
  }

  // Declarative rules (settings files, --allowedTools / --disallowedTools).
  // A deny rule wins at once; ask and allow apply below, after the checks no
  // rule may override (blocked commands, secret files, paths outside the
  // project).
  const rule = evaluateRules(config.rules, toolName, input, config.projectRoot, patchFiles);
  if (rule?.verdict === "deny") {
    return { verdict: "deny", reason: `Denied by the permission rule "${rule.rule}".` };
  }

  // Shell commands get extra scrutiny
  if (toolName === "shell") {
    const cmd = (input.command as string) || "";
    const safety = checkShellSafety(cmd);
    if (!safety.safe && safety.severity === "block") {
      return { verdict: "deny", reason: safety.reason };
    }
    // A warn pattern (command substitution, env, sudo, a force push) asks in
    // every mode but full-auto, which means allow: --yolo in a headless run,
    // where every ask is a denial, must not refuse `echo $(git rev-parse HEAD)`.
    if (!safety.safe && safety.severity === "warn" && config.mode !== "full-auto" && rule?.verdict !== "allow") {
      return { verdict: "ask", reason: safety.reason };
    }

    // Check cwd for shell
    const cwd = (input.cwd as string) || config.projectRoot;
    const cwdResult = validatePath(cwd, config.projectRoot, config.allowedPaths);
    if (!cwdResult.ok) {
      if (config.mode === "full-auto") {
        return { verdict: "ask", reason: `Shell cwd outside sandbox: ${cwdResult.error}` };
      }
      // suggest and auto-confirm will ask below anyway
    }
  }

  // Path-based tools: validate sandbox + sensitive path
  if (FILE_TOOLS.has(toolName)) {
    const filePath = (input.path as string) || "";
    if (filePath) {
      // Sensitive path check applies in ALL modes
      const sensitive = checkSensitivePath(filePath);
      if (sensitive.sensitive) {
        return { verdict: "deny", reason: `Sensitive path: ${sensitive.reason}` };
      }

      // Sandbox check: ask for out-of-sandbox paths in ALL modes (not just full-auto)
      const pathResult = validatePath(filePath, config.projectRoot, config.allowedPaths);
      if (!pathResult.ok) {
        return { verdict: "ask", reason: `Path outside sandbox: ${pathResult.error}` };
      }
      // A harmless name can link to a secret file.
      const target = checkSensitivePath(pathResult.resolved);
      if (target.sensitive) {
        return { verdict: "deny", reason: `Sensitive path: ${target.reason}` };
      }
    }
  }

  // apply_patch: check every path the patch names.
  if (toolName === "apply_patch") {
    for (const p of patchFiles) {
      const sensitive = checkSensitivePath(p);
      if (sensitive.sensitive) {
        return { verdict: "deny", reason: `Sensitive path: ${sensitive.reason}` };
      }
      const pathResult = validatePath(p, config.projectRoot, config.allowedPaths);
      if (!pathResult.ok) {
        return { verdict: "ask", reason: `Path outside sandbox: ${pathResult.error}` };
      }
      const target = checkSensitivePath(pathResult.resolved);
      if (target.sensitive) {
        return { verdict: "deny", reason: `Sensitive path: ${target.reason}` };
      }
    }
  }

  if (rule?.verdict === "ask") {
    return { verdict: "ask", reason: `The permission rule "${rule.rule}" asks first.` };
  }

  // Always-safe tools pass in all modes
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { verdict: "allow", reason: "Read-only tool, always allowed." };
  }

  if (rule?.verdict === "allow") {
    return { verdict: "allow", reason: `Allowed by the permission rule "${rule.rule}".` };
  }

  // Session allowlist — user previously approved this tool+pattern via (a)llow-tool or (s)ession-allow.
  // Placed after deny-list, shell-safety blocks, and sensitive-path denials so those are never bypassed.
  // An approved shell command still asks outside the sandbox or before it reads a secret file: approving
  // `cat` once is not approving `cat .env`.
  if (isAllowed(toolName, input)) {
    const shellOk = toolName !== "shell" || (() => {
      const cwd = (input.cwd as string) || config.projectRoot;
      return validatePath(cwd, config.projectRoot, config.allowedPaths).ok && !commandTouchesSecret((input.command as string) || "", cwd, config);
    })();
    if (shellOk) return { verdict: "allow", reason: "Session allowlist." };
  }

  // Mode-specific logic
  switch (config.mode) {
    case "suggest":
      // Suggest mode: ask for everything except safe tools
      return { verdict: "ask", reason: `Suggest mode requires confirmation for "${toolName}".` };

    case "auto-confirm":
      if (AUTO_CONFIRM_TOOLS.has(toolName)) {
        // An edit under .git (its config, hooks) can make the next auto-approved git read run a program.
        const edited = toolName === "apply_patch" ? patchFiles : typeof input.path === "string" ? [input.path] : [];
        const inGitDir = edited.some((p) => path.resolve(config.projectRoot, p).split(path.sep).includes(".git"));
        if (inGitDir) return { verdict: "ask", reason: `Auto-confirm mode asks before "${toolName}" edits git's own files.` };
        // Auto-confirm tools are allowed if path is in sandbox
        return { verdict: "allow", reason: `Auto-confirm mode allows "${toolName}".` };
      }
      if (toolName === "shell") {
        const cwd = (input.cwd as string) || config.projectRoot;
        const cwdResult = validatePath(cwd, config.projectRoot, config.allowedPaths);
        // Only commands that read, build or test; anything else (rm, git
        // push, npm publish, a redirect into a file) asks.
        // A read-only command still asks before it touches a secret file
        // (`cat .env`), as read_file would be refused.
        const command = (input.command as string) || "";
        // The cheap checks first: the secret check may walk a directory or ask git for its config.
        if (cwdResult.ok && isAutoApprovableCommand(command) && !commandTouchesSecret(command, cwd, config)) {
          return { verdict: "allow", reason: "Read, build or test command within sandbox." };
        }
      }
      return { verdict: "ask", reason: `Auto-confirm mode requires confirmation for "${toolName}".` };

    case "plan":
      // Plan mode: read-only tools are allowed; everything that mutates needs
      // explicit approval so the user can review the plan before it executes.
      return { verdict: "ask", reason: `Plan mode requires approval for "${toolName}".` };

    case "full-auto":
      // Full-auto: allow everything not denied or warned
      return { verdict: "allow", reason: "Full-auto mode." };

    default:
      return { verdict: "ask", reason: "Unknown permission mode." };
  }
}
