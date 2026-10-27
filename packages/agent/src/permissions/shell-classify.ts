/**
 * What a shell command line does, coarsely: enough to tell a read-only or
 * build-and-test command, which auto-confirm may run unprompted, from
 * anything else, which it must ask about. The blocklist in shell-safety.ts
 * only names the catastrophic cases; everything it misses (`rm -rf src`,
 * `git push`, `npm publish`) used to count as safe.
 *
 * This is a conservative reader, not a shell parser: anything it doesn't
 * understand (redirection into a file, substitution, a leading variable
 * assignment, background `&`) is not auto-approvable.
 */

import { GIT_GLOBAL_SAFE, GIT_SPECS, parseFind, parsedPaths, parseOptions, parseSed, READ_ONLY_SPECS, type CommandSpec } from "./shell-options.js";

/** Build, test and type-check tools, and the subcommands of multi-command tools that build or test. Their
 * options are not listed one by one (they run the project's own code anyway); the ones that rewrite sources
 * (`--fix`, `--write`) are refused. Read-only commands and git take only their listed options (shell-options.ts). */
const RUNNERS = new Set(["tsc", "vitest", "jest", "mocha", "pytest", "mypy", "pyright"]);
const SUBCOMMANDS: Record<string, Set<string>> = {
  npm: new Set(["test", "t", "run", "ls", "view", "outdated"]),
  pnpm: new Set(["test", "t", "run", "lint", "build", "typecheck", "ls", "list", "why", "outdated"]),
  yarn: new Set(["test", "run", "lint", "build", "typecheck", "list", "why"]),
  bun: new Set(["test", "run"]),
  npx: new Set(["tsc", "vitest", "jest", "mocha", "eslint", "biome"]),
  cargo: new Set(["build", "check", "test", "clippy", "doc", "tree", "metadata"]),
  go: new Set(["build", "test", "vet", "list", "version", "doc"]),
  ruff: new Set(["check"]),
  eslint: new Set(),
  biome: new Set(["check", "lint", "ci"]),
};

/** Build and lint options that rewrite the project's sources. */
const FIXING_ARG = /^--(fix|write|apply|unsafe)(-[\w-]+)?(=|$)/;

/** git's options before the subcommand, and the subcommand, or null when an option there is not one of the
 * few that keep it `git <subcommand>` (-c sets config that runs programs, -C and --git-dir switch repositories). */
function gitSubcommand(args: string[]): { sub: string; rest: string[] } | null {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (!GIT_GLOBAL_SAFE.has(args[i])) return null;
    i++;
  }
  return i < args.length ? { sub: args[i], rest: args.slice(i + 1) } : null;
}

function gitGlobalOptionsUnsafe(args: string[]): boolean {
  for (const a of args) {
    if (!a.startsWith("-")) return false;
    if (!GIT_GLOBAL_SAFE.has(a)) return true;
  }
  return false;
}

/**
 * The files a simple command reads, as its own options parser sees them, or null when this reader has no
 * spec for it or its arguments don't parse (an unlisted option). Search patterns, jq's filter and echo's
 * words are not paths; a pattern given by -e makes every operand one.
 */
export function commandPaths(tokens: string[]): string[] | null {
  const [binary, ...args] = tokens;
  if (!binary || binary.includes("/")) return null;
  if (binary === "find") return parseFind(args);
  if (binary === "sed") return parseSed(args);
  if (binary === "git") {
    const git = gitSubcommand(args);
    const spec = git && GIT_SPECS[git.sub];
    const parsed = spec && parseOptions(git.rest, spec);
    // `git show HEAD:.env` reads the path after the colon.
    return parsed ? parsedPaths(parsed, spec).flatMap((p) => (p.includes(":") ? [p, p.slice(p.indexOf(":") + 1)] : [p])) : null;
  }
  const spec: CommandSpec | undefined = READ_ONLY_SPECS[binary];
  const parsed = spec && parseOptions(args, spec);
  return parsed ? parsedPaths(parsed, spec) : null;
}

/** Whether a read-only command or a git read takes only its listed options (and date only +FORMAT). */
function readOnlyIsSafe(name: string, args: string[]): boolean | undefined {
  if (name === "find") return parseFind(args) !== null;
  if (name === "sed") return parseSed(args) !== null;
  if (name === "git") {
    const git = gitSubcommand(args);
    const spec = git && GIT_SPECS[git.sub];
    return !!spec && parseOptions(git.rest, spec) !== null;
  }
  const spec = READ_ONLY_SPECS[name];
  if (!spec) return undefined;
  const parsed = parseOptions(args, spec);
  if (!parsed) return false;
  // A bare date operand sets the clock.
  if (name === "date" && parsed.operands.some((o) => !o.startsWith("+"))) return false;
  return true;
}

/** Package scripts that `npm run` and friends may run unprompted. */
const SAFE_SCRIPT = /^(test|build|lint|check|typecheck|type-check|tsc|compile)(:[\w:-]+)?$/;
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Multi-command tools whose allowlist entries are scoped to the subcommand. */
export const MULTI_COMMAND_TOOLS = new Set([
  "git", "npm", "pnpm", "yarn", "bun", "npx", "cargo", "go", "docker", "kubectl", "gh", "pip", "pip3", "uv", "poetry",
  "brew", "dotnet", "mvn", "gradle", "terraform", "helm", "systemctl", "apt", "apt-get", "ruff", "biome",
]);

/** A simple command's words, and for each whether the shell would expand it into something unseen: file
 * names (an unquoted `*`, `?`, `[…]` or `{a,b}`) or a variable (`$NAME`, `${…}`, not in single quotes).
 * Such a word is not what the command sees, so no check can read it. */
export interface CommandWords { words: string[]; globbed: boolean[] }

const GLOB = /[*?]|\[[^\]]*\]|\{[^{}]*(,|\.\.)[^{}]*\}/;

/** A command line split into its simple commands, or null when it has constructs this reader won't vouch for. */
export function splitCommandLine(command: string): string[][] | null {
  return splitCommandWords(command)?.map((segment) => segment.words) ?? null;
}

/** As splitCommandLine, with which words the shell would expand. */
export function splitCommandWords(command: string): CommandWords[] | null {
  const segments: CommandWords[] = [];
  let tokens: string[] = [];
  let globbed: boolean[] = [];
  let current = "";
  // The token's unquoted, unescaped characters: only these can glob.
  let bare = "";
  // A `$NAME` or `${…}` outside single quotes: the word is whatever the variable holds. `$'…'` and `$"…"`
  // too: bash decodes their escapes (`$'\056env'` is `.env`, `$'\055o'` is `-o`) where no check here looks.
  let expands = false;
  let inToken = false;
  let quote: "'" | '"' | null = null;
  const endToken = () => {
    if (inToken) { tokens.push(current); globbed.push(expands || GLOB.test(bare)); }
    current = "";
    bare = "";
    expands = false;
    inToken = false;
  };
  // Inside double quotes `$"` is a `$` before the closing quote, and `$'` a `$` before a quote character.
  const variable = (i: number, quoted = false) => command[i] === "$"
    && (quoted ? /[A-Za-z_{0-9@*#?$!-]/ : /[A-Za-z_{0-9@*#?$!'"-]/).test(command[i + 1] ?? "");
  const endSegment = () => {
    endToken();
    if (tokens.length > 0) segments.push({ words: tokens, globbed });
    tokens = [];
    globbed = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && (c === "`" || (c === "$" && command[i + 1] === "("))) return null;
      else { if (quote === '"' && variable(i, true)) expands = true; current += c; }
      continue;
    }
    if (variable(i)) expands = true;
    if (c === "'" || c === '"') { quote = c; inToken = true; continue; }
    if (c === "\\") { current += command[i + 1] ?? ""; inToken = true; i++; continue; }
    if (c === "`" || (c === "$" && command[i + 1] === "(") || c === "<" && command[i + 1] === "(") return null;
    if (c === "&" && command[i + 1] === "&") { endSegment(); i++; continue; }
    if (c === "|") { endSegment(); if (command[i + 1] === "|") i++; continue; }
    if (c === ";" || c === "\n") { endSegment(); continue; }
    if (c === "&" || c === ">" || c === "<") {
      // Only the harmless redirections: stderr into stdout, output thrown away.
      const rest = command.slice(i);
      const harmless = /^(?:>&[12]|>\s*\/dev\/null|&>\s*\/dev\/null)/.exec(rest);
      const fd = current === "1" || current === "2" ? current : null;
      if (!harmless || (inToken && !fd)) return null;
      current = "";
      bare = "";
      inToken = false;
      i += harmless[0].length - 1;
      continue;
    }
    if (c === " " || c === "\t") { endToken(); continue; }
    current += c;
    bare += c;
    inToken = true;
  }
  if (quote) return null;
  endSegment();
  return segments;
}

function segmentIsSafe({ words: tokens, globbed }: CommandWords): boolean {
  const [binary, ...args] = tokens;
  // A leading assignment (PATH=… cmd) can change what runs.
  if (!binary || /^[A-Za-z_][A-Za-z0-9_]*=/.test(binary)) return false;
  // A word the shell expands into file names is not what any check here read.
  if (globbed.some(Boolean)) return false;
  const name = binary.includes("/") ? "" : binary;
  const readOnly = readOnlyIsSafe(name, args);
  if (readOnly !== undefined) return readOnly;
  // After `--` every argument is an operand, never an option.
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  if (options.some((a) => FIXING_ARG.test(a))) return false;
  if (RUNNERS.has(name)) return true;
  const subs = SUBCOMMANDS[name];
  if (!subs) return false;
  if (subs.size === 0) return true;
  const positional = args.filter((a) => !a.startsWith("-"));
  const sub = positional[0];
  if (sub === undefined || !subs.has(sub)) return false;
  // `npm run deploy` runs whatever the package says; only the usual check scripts pass.
  if (sub === "run" && SCRIPT_RUNNERS.has(name)) return positional[1] !== undefined && SAFE_SCRIPT.test(positional[1]);
  return true;
}

/** True when every part of the command line only reads, builds or tests. */
export function isAutoApprovableCommand(command: string): boolean {
  const segments = splitCommandWords(command);
  return segments !== null && segments.length > 0 && segments.every(segmentIsSafe);
}

/** The allowlist pattern for one simple command: the binary, plus the subcommand for multi-command tools. */
export function commandPattern(tokens: string[]): string {
  const [binary, ...args] = tokens;
  if (!binary) return "*";
  // Such a git line is its own pattern, so approving `git status` doesn't approve it.
  if (binary === "git" && gitGlobalOptionsUnsafe(args)) return tokens.join(" ");
  if (MULTI_COMMAND_TOOLS.has(binary)) {
    const sub = args.find((a) => !a.startsWith("-"));
    if (sub) return `${binary} ${sub}`;
  }
  return binary;
}
