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

import { GIT_GLOBAL_SAFE, GIT_SPECS, optionArg, own, parseFind, parsedPaths, parseOptions, parseSed, READ_ONLY_SPECS,
  type CommandSpec, type ParsedArgs } from "./shell-options.js";

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
    // A `REV:PATH` operand's path is relative to the repository's top: gitRead's `blobs` has it.
    return parsed && spec ? parsedPaths(parsed, spec).filter((p) => blobPath(p) === undefined) : null;
  }
  const spec: CommandSpec | undefined = own(READ_ONLY_SPECS, binary);
  const parsed = spec && parseOptions(args, spec);
  return parsed && spec ? parsedPaths(parsed, spec) : null;
}

/**
 * A command that reads the files below a directory, not only the files it names: where it starts (cwd when
 * nothing is named), whether it follows symlinks, and which files it reads there. `all`: every file (diff -r).
 * `rg`: what `rg --files` lists with `listArgs`, the run's own filtering options (rg's ignore, hidden and glob
 * rules are its own to apply). `grep`: what `grep -l` with the run's own selecting options (`--include`,
 * `--exclude`, `--exclude-dir`…) lists. `tracked`: git's tracked files matching the run's pathspecs (git grep),
 * each an existing path.
 */
export interface RecursiveRead { roots: string[]; follow: boolean; scope: "all" | "rg" | "grep" | "tracked"; listArgs?: string[] }

/** grep's options that choose which files a recursive grep reads. */
const GREP_SELECT = new Set(["-r", "-R", "--recursive", "--dereference-recursive", "-d", "--directories", "-D", "--devices",
  "--include", "--exclude", "--exclude-dir", "--exclude-from", "-I", "-a", "--text", "--binary-files"]);

/** rg's options that change which files it reads, short and long. */
const RG_FILTERS = new Set(["-u", "-.", "-L", "-g", "-t", "-T", "-d", "--hidden", "--no-ignore", "--no-ignore-vcs", "--no-ignore-parent",
  "--no-ignore-dot", "--unrestricted", "--follow", "--glob", "--iglob", "--glob-case-insensitive", "--type", "--type-not", "--type-add",
  "--ignore-file", "--max-depth", "--no-config"]);

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
    if (!recurse) return null;
    // grep itself says which files its selection reads; the operands it names (not the -f/--exclude-from files) start it.
    const patternGiven = named(options, "-e", "--regexp", "-f", "--file");
    const roots = patternGiven ? read.parsed.operands : read.parsed.operands.slice(1);
    const listArgs = options.filter((o) => GREP_SELECT.has(o.name)).map(optionArg);
    return { roots: roots.length ? roots : ["."], follow, scope: "grep", listArgs };
  }
  if (binary === "rg") {
    const read = parse(own(READ_ONLY_SPECS, "rg"), args);
    if (!read) return null;
    const { options } = read.parsed;
    const listArgs = options.filter((o) => RG_FILTERS.has(o.name))
      .flatMap((o) => (o.value === undefined ? [o.name] : o.name.startsWith("--") ? [`${o.name}=${o.value}`] : [o.name, o.value]));
    return { roots: read.paths, follow: named(options, "-L", "--follow"), scope: "rg", listArgs };
  }
  if (binary === "diff") {
    const read = parse(own(READ_ONLY_SPECS, "diff"), args);
    return read && named(read.parsed.options, "-r", "--recursive") ? { roots: read.paths, follow: true, scope: "all" } : null;
  }
  if (binary === "git") {
    const git = gitSubcommand(args);
    const spec = git ? own(GIT_SPECS, git.sub) : undefined;
    const read = git && spec ? parse(spec, git.rest) : null;
    if (!git || !read) return null;
    const { options } = read.parsed;
    // Two directories compared (`--no-index`, or by git itself when a path is outside the work tree), the
    // files on one side only printed whole: every directory operand is read through.
    if (git.sub === "diff") return { roots: read.paths, follow: true, scope: "all" };
    if (git.sub !== "grep") return null;
    const everything = named(options, "--untracked", "--no-index", "--no-exclude-standard", "--recurse-submodules");
    // It searches the pathspecs it is given, else everything below cwd.
    const roots = read.paths.length ? read.paths : ["."];
    return { roots, follow: false, scope: everything ? "all" : "tracked" };
  }
  return null;
}

/** The file a `REV:PATH` (or index `:PATH`, `:N:PATH`) operand names, or undefined for a plain revision. A
 * colon inside a reflog date (`main@{2026-10-01 10:00}`) is part of the revision. */
export function blobPath(operand: string): string | undefined {
  const plain = operand.replace(/@\{[^}]*\}/g, "");
  const at = plain.indexOf(":");
  if (at === -1) return undefined;
  const rest = plain.slice(at + 1);
  return at === 0 && /^[0-3]:/.test(rest) ? rest.slice(2) : rest;
}

/** git options that print file contents as a patch (a `git log` without them prints none). `--binary` implies a patch. */
const GIT_PATCH_OPTIONS = new Set(["-p", "-u", "-U", "-W", "--patch", "--patch-with-stat", "--word-diff", "--color-words",
  "--function-context", "--unified", "--binary"]);
/** The pickaxe: commits chosen by what their diffs contain, which textconv may compute. */
const GIT_PICKAXE = new Set(["-S", "-G"]);
/** git options whose output is computed from file contents (a diffstat), so textconv runs for them too. */
const GIT_STAT_OPTIONS = new Set(["--stat", "--numstat", "--shortstat", "--dirstat", "--cumulative", "--check", "--summary"]);
/** The options of a diff that choose what is compared (not how it prints). */
const GIT_DIFF_SELECT = new Set(["--cached", "--staged", "--merge-base", "--diff-filter", "-S", "-G", "--ignore-submodules"]);
/** The options of a log or show that choose its commits. */
const GIT_LOG_SELECT = new Set(["-NUM", "-n", "--max-count", "--skip", "--since", "--after", "--until", "--before", "--author",
  "--committer", "--grep", "--all", "--branches", "--tags", "--remotes", "--merges", "--no-merges", "--first-parent", "--min-parents",
  "--max-parents", "--regexp-ignore-case", "--all-match", "--invert-grep", "--ancestry-path", "--cherry-pick", "--cherry-mark",
  "--left-right", "--full-history", "--simplify-by-decoration", "--follow", "-S", "-G", "--diff-filter", "--no-walk", "--mailmap",
  "--use-mailmap", "--boundary"]);

/**
 * What a git read runs and shows beyond the files it names: which kinds of configured helper it may start
 * (`diff`: an external diff, a diff driver's command or textconv; `filter`: clean/smudge; `format`: a configured
 * pretty format) for the operation it does, and, when it prints file contents it doesn't name (`git diff`,
 * `git log -p`, `git show`), the git arguments that list those files' paths (relative to the repository's top),
 * so each can be checked. `blobs`: the paths of its `REV:PATH` operands, relative to the repository's top.
 * `ask`: a form whose exposure can't be listed (`-C -C` takes unchanged files as copy sources, whose lines a
 * patch prints though no listing names them). Null when it isn't a git read this reader knows.
 */
export interface GitRead { helpers: string[]; exposure?: string[]; blobs: string[]; ask?: boolean }

export function gitRead(tokens: string[]): GitRead | null {
  if (tokens[0] !== "git") return null;
  const git = gitSubcommand(tokens.slice(1));
  const spec = git ? own(GIT_SPECS, git.sub) : undefined;
  const parsed = git && spec ? parseOptions(git.rest, spec) : null;
  if (!git || !parsed) return null;
  const has = (set: Set<string>) => parsed.options.some((o) => set.has(o.name));
  const names = ["--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv"];
  // Revisions and blobs come before a `--`; after it every operand is a pathspec.
  const end = parsed.dashdash ?? parsed.operands.length;
  const named = parsed.operands.slice(0, end), pathspecs = parsed.operands.slice(end);
  const blobs = ["diff", "show"].includes(git.sub) ? named.flatMap((o) => blobPath(o) ?? []) : [];
  const ask = parsed.options.filter((o) => o.name === "-C").length > 1;
  switch (git.sub) {
    case "diff":
      // --no-index compares directories, which the recursive-read walk covers.
      if (has(new Set(["--no-index"]))) return { helpers: ["diff", "filter"], blobs, ask };
      return { helpers: ["diff", "filter"], blobs, ask, exposure: ["diff", ...names, ...listingOf(parsed, GIT_DIFF_SELECT)] };
    case "log": {
      const patch = has(GIT_PATCH_OPTIONS);
      return { helpers: ["format", ...(patch || has(GIT_STAT_OPTIONS) || has(GIT_PICKAXE) ? ["diff"] : [])], blobs, ask,
        ...(patch ? { exposure: ["log", ...names, "--format=", "-m", ...listingOf(parsed, GIT_LOG_SELECT)] } : {}) };
    }
    case "show": {
      // A `REV:PATH` operand is a blob (`blobs`); the commits shown are the others (HEAD when nothing is named).
      // Only blobs named: no commit's patch is shown.
      const revs = named.filter((o) => blobPath(o) === undefined);
      if (named.length && !revs.length) return { helpers: ["diff", "format"], blobs, ask };
      const shown: ParsedArgs = { options: parsed.options, operands: [...(revs.length ? revs : ["HEAD"]), ...pathspecs],
        ...(parsed.dashdash !== undefined ? { dashdash: revs.length || 1 } : {}) };
      return { helpers: ["diff", "format"], blobs, ask,
        exposure: ["log", "--no-walk", ...names, "--format=", "-m", ...listingOf(shown, GIT_LOG_SELECT)] };
    }
    case "blame": return { helpers: ["diff", "filter"], blobs };
    // `-v` prints the staged patch, `-vv` the unstaged one too: every change against HEAD.
    case "status":
      return has(new Set(["-v", "--verbose"])) ? { helpers: ["diff", "filter"], blobs, exposure: ["diff", ...names, "HEAD"] } : { helpers: ["filter"], blobs };
    case "grep": return { helpers: ["filter"], blobs };
    case "shortlog": return { helpers: ["format"], blobs };
    default: return { helpers: [], blobs };
  }
}

/** The arguments a listing keeps from the run: its selecting options, revisions and pathspecs (after a `--`
 * where it had one). */
function listingOf(parsed: ParsedArgs, select: Set<string>): string[] {
  const before = parsed.dashdash === undefined ? parsed.operands : parsed.operands.slice(0, parsed.dashdash);
  const after = parsed.dashdash === undefined ? [] : parsed.operands.slice(parsed.dashdash);
  return [...parsed.options.filter((o) => select.has(o.name)).map(optionArg), ...before, ...(after.length ? ["--", ...after] : [])];
}

/**
 * Whether a printf format only prints: every `%` directive is a known conversion (or `%%`), never `%n`, which
 * stores a count in a variable (`printf '%n' PATH` empties PATH), and every backslash escape is a plain one
 * (an octal or hex escape could spell a `%` this check didn't read).
 */
export function printfFormatIsPlain(format: string): boolean {
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c === "\\") {
      if (!/["'\\abefnrtv]/.test(format[i + 1] ?? "")) return false;
      i++;
      continue;
    }
    if (c !== "%") continue;
    if (format[i + 1] === "%") { i++; continue; }
    const directive = /^%[-+ #0']*(\*|\d+)?(\.(\*|\d+)?)?(\([^()%]*\)T|[diouxXfFeEgGaAcsbq])/.exec(format.slice(i));
    if (!directive) return false;
    i += directive[0].length - 1;
  }
  return true;
}

/** Whether a jq program starts with a module directive (`import "x" as $d;`, `include "x";`, `module {…};`),
 * which reads files no check here sees. Directives come only before the program's body; a field `.import` or
 * a string "include" is not one. */
export function jqHasModuleDirective(program: string): boolean {
  let rest = program;
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    if (!rest.startsWith("#")) break;
    // Ended at either line break, so a comment jq ends sooner never hides a directive from this check.
    const end = rest.search(/[\r\n]/);
    rest = end === -1 ? "" : rest.slice(end + 1);
  }
  return /^(import|include|module)(?![\w$])/.test(rest);
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
  if (name === "printf") {
    // `printf -v NAME` and a `%n` directive assign a variable (`printf -v PATH .` changes what the next command runs).
    if (args[0]?.startsWith("-v")) return false;
    const format = args[0] === "--" ? args[1] : args[0];
    return format === undefined || printfFormatIsPlain(format);
  }
  const parsed = parseOptions(args, spec);
  if (!parsed) return false;
  // A bare date operand sets the clock.
  if (name === "date" && parsed.operands.some((o) => !o.startsWith("+"))) return false;
  // A jq program's `import "x" as $d` and `include` read files (searching paths it names) no check here sees.
  if (name === "jq" && jqHasModuleDirective(parsed.operands[0] ?? "")) return false;
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
  /** Whether the word's leading `~` is one bash expands to the home directory: unquoted, alone or before an
   * unquoted `/` (`~/x`, not `'~/x'`, `~"/x"` or `""~/x`). */
  home?: boolean[];
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
  let home: boolean[] = [];
  let current = "";
  // The token's unquoted, unescaped characters: only these can glob.
  let bare = "";
  // Whether the token's first character was neither quoted nor escaped (undefined before it has one).
  let firstBare: boolean | undefined;
  const begin = (plain: boolean) => { if (!inToken) firstBare = plain; inToken = true; };
  // A `$NAME` or `${…}` outside single quotes: the word is whatever the variable holds. `$'…'` and `$"…"`
  // too: bash decodes their escapes (`$'\056env'` is `.env`, `$'\055o'` is `-o`) where no check here looks.
  let expands = false;
  let inToken = false;
  let quote: "'" | '"' | null = null;
  const endToken = () => {
    // A leading `~` bash expands: unquoted, and the word is `~` or goes on with an unquoted `/`.
    const homeTilde = firstBare === true && (current === "~" ? bare === "~" : current.startsWith("~/") && bare.startsWith("~/"));
    // An unquoted `~name`, `~+` or `~-` at the start is a home directory or $PWD/$OLDPWD, never what the word
    // says; one after `=` or `:` (`a=~/x`, an assignment-looking word) is expanded too, where no check looks.
    const tilde = (firstBare === true && bare.startsWith("~") && !homeTilde) || /[=:]~/.test(bare);
    if (inToken) { tokens.push(current); globbed.push(expands || tilde || GLOB.test(bare)); home.push(homeTilde); }
    current = "";
    bare = "";
    expands = false;
    inToken = false;
    firstBare = undefined;
  };
  // Inside double quotes `$"` is a `$` before the closing quote, and `$'` a `$` before a quote character.
  // `$[…]` is bash's old arithmetic, which assigns (`"$[PATH=0]"`), quoted or not.
  const variable = (i: number, quoted = false) => command[i] === "$"
    && (quoted ? /[A-Za-z_{0-9@*#?$![-]/ : /[A-Za-z_{0-9@*#?$!'"[-]/).test(command[i + 1] ?? "");
  // The operator before the segment being read, and the one that ends it.
  let before = "";
  const endSegment = (after = "") => {
    endToken();
    if (tokens.length === 0) {
      // An empty segment (`a &&⏎ b`) keeps the operator before it, unless this one is a pipe.
      if (after === "|" || after === "||") before = after;
      return;
    }
    segments.push({ words: tokens, globbed, home, before, after });
    before = after;
    tokens = [];
    globbed = [];
    home = [];
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
    // A comment: bash ignores the rest of the line, quotes in it included, which this reader would not.
    if (c === "#" && !inToken) return null;
    if (c === "'" || c === '"') { quote = c; begin(false); continue; }
    if (c === "\\") { current += command[i + 1] ?? ""; begin(false); i++; continue; }
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
      firstBare = undefined;
      i += harmless[0].length - 1;
      continue;
    }
    if (c === " " || c === "\t") { endToken(); continue; }
    begin(true);
    current += c;
    bare += c;
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
