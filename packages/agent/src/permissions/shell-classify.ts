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

/** Commands that only read. */
const READ_ONLY = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "pwd", "echo", "printf", "which", "type",
  "file", "stat", "du", "df", "tree", "diff", "cmp", "sort", "uniq", "cut", "tr", "basename", "dirname", "realpath",
  "readlink", "date", "true", "false", "test", "[", "jq", "nl", "column", "sha256sum", "shasum", "md5sum", "whoami",
  "uname", "hostname", "cd", "find", "sed",
]);

/** Build, test and type-check tools, and the subcommands of multi-command tools that read, build or test. */
const RUNNERS = new Set(["tsc", "vitest", "jest", "mocha", "pytest", "mypy", "pyright"]);
const SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "grep", "describe", "shortlog"]),
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

/** Arguments that turn a read-only command into one that writes or runs things. */
const WRITING_ARGS: Record<string, RegExp> = {
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  // -i edits in place; a script's w command writes a file and e runs one.
  sed: /^(-i|--in-place)|(^|[;{}\n]|\/[gpIiMm0-9]*)\s*[we](\s|$)/,
  eslint: /^--fix/,
  git: /^(-o|--output)/,
};

/** Package scripts that `npm run` and friends may run unprompted. */
const SAFE_SCRIPT = /^(test|build|lint|check|typecheck|type-check|tsc|compile)(:[\w:-]+)?$/;
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Multi-command tools whose allowlist entries are scoped to the subcommand. */
export const MULTI_COMMAND_TOOLS = new Set([
  "git", "npm", "pnpm", "yarn", "bun", "npx", "cargo", "go", "docker", "kubectl", "gh", "pip", "pip3", "uv", "poetry",
  "brew", "dotnet", "mvn", "gradle", "terraform", "helm", "systemctl", "apt", "apt-get", "ruff", "biome",
]);

/** A command line split into its simple commands, or null when it has constructs this reader won't vouch for. */
export function splitCommandLine(command: string): string[][] | null {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;
  const endToken = () => {
    if (inToken) tokens.push(current);
    current = "";
    inToken = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && (c === "`" || (c === "$" && command[i + 1] === "("))) return null;
      else current += c;
      continue;
    }
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
      inToken = false;
      i += harmless[0].length - 1;
      continue;
    }
    if (c === " " || c === "\t") { endToken(); continue; }
    current += c;
    inToken = true;
  }
  if (quote) return null;
  endSegment();
  return segments;
}

function segmentIsSafe(tokens: string[]): boolean {
  const [binary, ...args] = tokens;
  // A leading assignment (PATH=… cmd) can change what runs.
  if (!binary || /^[A-Za-z_][A-Za-z0-9_]*=/.test(binary)) return false;
  const name = binary.includes("/") ? "" : binary;
  const writing = WRITING_ARGS[name];
  if (writing && args.some((a) => writing.test(a))) return false;
  if (READ_ONLY.has(name) || RUNNERS.has(name)) return true;
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
  const segments = splitCommandLine(command);
  return segments !== null && segments.length > 0 && segments.every(segmentIsSafe);
}

/** The allowlist pattern for one simple command: the binary, plus the subcommand for multi-command tools. */
export function commandPattern(tokens: string[]): string {
  const [binary, ...args] = tokens;
  if (!binary) return "*";
  if (MULTI_COMMAND_TOOLS.has(binary)) {
    const sub = args.find((a) => !a.startsWith("-"));
    if (sub) return `${binary} ${sub}`;
  }
  return binary;
}
