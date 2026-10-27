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

import { GIT_GLOBAL_SAFE, GIT_SPECS, own, parseFind, parsedPaths, parseOptions, parseSed, READ_ONLY_SPECS, type CommandSpec } from "./shell-options.js";

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
    const spec = git ? own(GIT_SPECS, git.sub) : undefined;
    const parsed = git && spec && parseOptions(git.rest, spec);
    // `git show HEAD:.env` reads the path after the colon.
    return parsed && spec ? parsedPaths(parsed, spec).flatMap((p) => (p.includes(":") ? [p, p.slice(p.indexOf(":") + 1)] : [p])) : null;
  }
  const spec: CommandSpec | undefined = own(READ_ONLY_SPECS, binary);
  const parsed = spec && parseOptions(args, spec);
  return parsed && spec ? parsedPaths(parsed, spec) : null;
}

/**
 * A command that reads the files below a directory, not only the files it names: where it starts (cwd when
 * nothing is named), whether it follows symlinks, and which files it reads there. `all`: every file (grep -r,
 * diff -r, rg told to ignore no ignore file). `unignored`: what git doesn't ignore, and hidden files only with
 * `hidden` (rg's default). `tracked`: git's tracked files (git grep).
 */
export interface RecursiveRead { roots: string[]; follow: boolean; scope: "all" | "unignored" | "tracked"; hidden: boolean }

/** Where a command reads every file below a directory (grep -r, rg, diff -r, git grep, git diff --no-index),
 * or null when it reads only the files named. The caller looks below each for a secret file, since no
 * operand names it. */
export function recursiveReads(tokens: string[]): RecursiveRead | null {
  const [binary, ...args] = tokens;
  if (!binary) return null;
  const parse = (spec: CommandSpec | undefined, rest: string[]) => {
    const parsed = spec && parseOptions(rest, spec);
    return parsed && spec ? { parsed, paths: parsedPaths(parsed, spec) } : null;
  };
  const named = (options: { name: string; value?: string }[], ...names: string[]) => options.some((o) => names.includes(o.name));
  if (binary === "grep" || binary === "egrep" || binary === "fgrep") {
    const read = parse(own(READ_ONLY_SPECS, binary), args);
    if (!read) return null;
    const { options } = read.parsed;
    const follow = named(options, "-R", "--dereference-recursive");
    // Any -d value but an exact `read` or `skip` may recurse (GNU takes `rec`, BSD `RECURSE`).
    const recurse = follow || named(options, "-r", "--recursive")
      || options.some((o) => (o.name === "-d" || o.name === "--directories") && o.value !== "read" && o.value !== "skip");
    return recurse ? { roots: read.paths.length ? read.paths : ["."], follow, scope: "all", hidden: true } : null;
  }
  if (binary === "rg") {
    const read = parse(own(READ_ONLY_SPECS, "rg"), args);
    if (!read) return null;
    const { options } = read.parsed;
    const u = options.filter((o) => o.name === "-u").length + (named(options, "--unrestricted") ? 1 : 0);
    // A --glob overrides rg's ignore rules, as -u and --no-ignore do.
    const all = u > 0 || named(options, "--no-ignore", "--no-ignore-vcs", "-g", "--glob", "--iglob");
    return { roots: read.paths.length ? read.paths : ["."], follow: named(options, "-L", "--follow"),
      scope: all ? "all" : "unignored", hidden: u > 1 || named(options, "-.", "--hidden") };
  }
  if (binary === "diff") {
    const read = parse(own(READ_ONLY_SPECS, "diff"), args);
    return read && named(read.parsed.options, "-r", "--recursive") ? { roots: read.paths, follow: true, scope: "all", hidden: true } : null;
  }
  if (binary === "git") {
    const git = gitSubcommand(args);
    const spec = git ? own(GIT_SPECS, git.sub) : undefined;
    const read = git && spec ? parse(spec, git.rest) : null;
    if (!git || !read) return null;
    const { options } = read.parsed;
    // Two directories compared, the files on one side only printed whole.
    if (git.sub === "diff" && named(options, "--no-index")) return { roots: read.paths, follow: true, scope: "all", hidden: true };
    if (git.sub !== "grep") return null;
    // Its operands are revisions or pathspecs; each that is a directory is searched too.
    const untracked = named(options, "--untracked", "--no-index", "--no-exclude-standard");
    return { roots: [".", ...read.paths], follow: false, scope: untracked ? "all" : "tracked", hidden: true };
  }
  return null;
}

/** Whether a read-only command or a git read takes only its listed options (and date only +FORMAT). */
function readOnlyIsSafe(name: string, args: string[]): boolean | undefined {
  if (name === "find") return parseFind(args) !== null;
  if (name === "sed") return parseSed(args) !== null;
  if (name === "git") {
    const git = gitSubcommand(args);
    const spec = git ? own(GIT_SPECS, git.sub) : undefined;
    const parsed = git && spec ? parseOptions(git.rest, spec) : null;
    if (!parsed) return false;
    // `%G…` placeholders verify signatures, which runs gpg.program.
    if (parsed.options.some((o) => (o.name === "--format" || o.name === "--pretty") && o.value?.includes("%G"))) return false;
    // Pathspec magic (`:/`, `:(top)`) and `..` reach past where the search below cwd was looked at.
    if (git!.sub === "grep" && parsed.operands.some((o) => o.startsWith(":") || o.split("/").includes(".."))) return false;
    return true;
  }
  const spec = own(READ_ONLY_SPECS, name);
  if (!spec) return undefined;
  // `printf -v NAME` assigns a variable (`printf -v PATH .` changes what the next command runs).
  if (name === "printf" && args[0]?.startsWith("-v")) return false;
  const parsed = parseOptions(args, spec);
  if (!parsed) return false;
  // A bare date operand sets the clock.
  if (name === "date" && parsed.operands.some((o) => !o.startsWith("+"))) return false;
  // A jq filter's `import "x" as $d` and `include` read files (searching paths it names) no check here sees.
  if (name === "jq" && /\b(import|include)\b/.test(parsed.operands[0] ?? "")) return false;
  return true;
}

/** Package scripts that `npm run` and friends may run unprompted. */
const SAFE_SCRIPT = /^(test|build|lint|check|typecheck|type-check|tsc|compile)(:[\w:-]+)?$/;
/** A script variant that rewrites sources or snapshots (`lint:fix`, `test:update`). */
const REWRITING_SCRIPT = /fix|write|format|apply|update|snapshot/i;
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Multi-command tools whose allowlist entries are scoped to the subcommand. */
export const MULTI_COMMAND_TOOLS = new Set([
  "git", "npm", "pnpm", "yarn", "bun", "npx", "cargo", "go", "docker", "kubectl", "gh", "pip", "pip3", "uv", "poetry",
  "brew", "dotnet", "mvn", "gradle", "terraform", "helm", "systemctl", "apt", "apt-get", "ruff", "biome",
]);

/** A simple command's words, and for each whether the shell would expand it into something unseen: file
 * names (an unquoted `*`, `?`, `[…]` or `{a,b}`) or a variable (`$NAME`, `${…}`, not in single quotes).
 * Such a word is not what the command sees, so no check can read it. */
export interface CommandWords {
  words: string[]; globbed: boolean[];
  /** The operators around it (`&&`, `||`, `|`, `;`, "" at either end): a `cd` in a pipeline moves no later command. */
  before?: string; after?: string;
}

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
    // An unquoted `~name`, `~+` or `~-` (also after `=` or `:`) is a home directory or $PWD/$OLDPWD, never what
    // the word says; `~` and `~/…` are expanded where paths are checked.
    const tilde = bare.includes("~") && /(?:^|[=:])~[^/]/.test(current);
    if (inToken) { tokens.push(current); globbed.push(expands || tilde || GLOB.test(bare)); }
    current = "";
    bare = "";
    expands = false;
    inToken = false;
  };
  // Inside double quotes `$"` is a `$` before the closing quote, and `$'` a `$` before a quote character.
  const variable = (i: number, quoted = false) => command[i] === "$"
    && (quoted ? /[A-Za-z_{0-9@*#?$!-]/ : /[A-Za-z_{0-9@*#?$!'"-]/).test(command[i + 1] ?? "");
  // The operator before the segment being read, and the one that ends it.
  let before = "";
  const endSegment = (after = "") => {
    endToken();
    if (tokens.length === 0) {
      // An empty segment (`a &&⏎ b`) keeps the operator before it, unless this one is a pipe.
      if (after === "|" || after === "||") before = after;
      return;
    }
    segments.push({ words: tokens, globbed, before, after });
    before = after;
    tokens = [];
    globbed = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    // A line continuation: bash drops the backslash and newline and joins the word (`sec\⏎rets.json`), which this
    // reader would keep as two characters, so it isn't vouched for (outside single quotes, where it is literal).
    if (c === "\\" && command[i + 1] === "\n" && quote !== "'") return null;
    if (quote) {
      // Inside double quotes a backslash escapes `"`, `\`, `$` and a backquote: `"a\" b"` is one word, and
      // reading `\"` as the closing quote would put the rest of the line outside it.
      if (quote === '"' && c === "\\" && /["\\$`]/.test(command[i + 1] ?? "")) { current += command[++i]; continue; }
      if (c === quote) quote = null;
      else if (quote === '"' && (c === "`" || (c === "$" && command[i + 1] === "("))) return null;
      else { if (quote === '"' && variable(i, true)) expands = true; current += c; }
      continue;
    }
    if (variable(i)) expands = true;
    if (c === "'" || c === '"') { quote = c; inToken = true; continue; }
    if (c === "\\") { current += command[i + 1] ?? ""; inToken = true; i++; continue; }
    if (c === "`" || (c === "$" && command[i + 1] === "(") || c === "<" && command[i + 1] === "(") return null;
    if (c === "&" && command[i + 1] === "&") { endSegment("&&"); i++; continue; }
    if (c === "|") { if (command[i + 1] === "|") { endSegment("||"); i++; } else endSegment("|"); continue; }
    if (c === ";" || c === "\n") { endSegment(";"); continue; }
    if (c === "&" || c === ">" || c === "<") {
      // Only the harmless redirections: stderr into stdout, output thrown away. The whole target must be that
      // descriptor or /dev/null (`>&1pwned` writes the file 1pwned).
      const rest = command.slice(i);
      const harmless = /^(?:>&[12]|>[ \t]*\/dev\/null|&>[ \t]*\/dev\/null)(?=$|[ \t\n;|&])/.exec(rest);
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
  // Past `--` too: `npm run lint -- --fix` hands --fix on to the script's own tool.
  if (args.some((a) => FIXING_ARG.test(a))) return false;
  if (RUNNERS.has(name)) return true;
  const subs = own(SUBCOMMANDS, name);
  if (!subs) return false;
  if (subs.size === 0) return true;
  const positional = args.filter((a) => !a.startsWith("-"));
  const sub = positional[0];
  if (sub === undefined || !subs.has(sub)) return false;
  // `npm run deploy` runs whatever the package says; only the usual check scripts pass.
  if (sub === "run" && SCRIPT_RUNNERS.has(name)) {
    return positional[1] !== undefined && SAFE_SCRIPT.test(positional[1]) && !REWRITING_SCRIPT.test(positional[1]);
  }
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
