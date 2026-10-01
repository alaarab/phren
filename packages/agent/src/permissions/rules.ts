/**
 * Declarative permission rules: allow, ask and deny lists in settings files
 * and on the command line (`--allowedTools`, `--disallowedTools`), in Claude
 * Code's shape.
 *
 *   "read_file"            the tool, any input
 *   "mcp_github_*"         tool names with * globs
 *   "shell(npm test)"      a shell command; * matches anything, so
 *   "shell(git log *)"     covers git log with any arguments
 *   "edit_file(src/**)"    a file tool on paths under the project root
 *
 * A shell rule is matched against each simple command on the line: a deny or
 * ask rule applies when any command matches it, an allow rule only when
 * every command matches one, and a line this reader can't vouch for
 * (substitution, a redirect into a file) is never allowed by a rule.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { splitCommandLine } from "./shell-classify.js";

export interface PermissionRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

export type RuleVerdict = { verdict: "allow" | "ask" | "deny"; rule: string };

export function emptyRules(): PermissionRules {
  return { allow: [], ask: [], deny: [] };
}

interface ParsedRule {
  tool: RegExp;
  pattern?: string;
}

function globToRegExp(glob: string, opts: { slashes: boolean }): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += opts.slashes ? "[^/]*" : ".*";
      }
    } else if (c === "?") {
      re += opts.slashes ? "[^/]" : ".";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * A shell rule's command glob. A trailing " *" or Claude Code's ":*" also
 * matches the bare command, so "git log *" and "git log:*" cover `git log`.
 */
function shellPatternRegExp(pattern: string): RegExp {
  const prefix = /^(.*?)(?: \*|:\*)$/.exec(pattern);
  if (!prefix) return globToRegExp(pattern, { slashes: false });
  const head = globToRegExp(prefix[1], { slashes: false }).source.slice(1, -1);
  return new RegExp(`^${head}(?: .*)?$`);
}

function parseRule(rule: string): ParsedRule | null {
  const m = /^\s*([A-Za-z0-9_*.-]+)\s*(?:\((.*)\))?\s*$/s.exec(rule);
  if (!m) return null;
  return { tool: globToRegExp(m[1], { slashes: false }), ...(m[2] !== undefined ? { pattern: m[2].trim() } : {}) };
}

const PATH_TOOLS = new Set(["read_file", "write_file", "edit_file", "multi_edit", "glob", "grep", "read_image"]);

/** The paths a call touches, relative to the project root when inside it. */
function callPaths(toolName: string, input: Record<string, unknown>, projectRoot: string, patchPaths?: string[]): string[] {
  const raw = toolName === "apply_patch" ? (patchPaths ?? []) : PATH_TOOLS.has(toolName) ? [String(input.path ?? ".")] : [];
  return raw.map((p) => {
    const abs = path.resolve(projectRoot, p);
    const rel = path.relative(projectRoot, abs);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : abs;
  });
}

/** Does this rule cover this call? For shell, `segments` decides per simple command. */
function ruleMatches(
  rule: ParsedRule,
  toolName: string,
  subject: { command?: string[] | null; paths: string[] },
  mode: "any" | "all",
): boolean {
  if (!rule.tool.test(toolName)) return false;
  if (rule.pattern === undefined || rule.pattern === "*") return true;
  if (toolName === "shell") {
    const re = shellPatternRegExp(rule.pattern);
    if (!subject.command || subject.command.length === 0) return false;
    return mode === "any" ? subject.command.some((c) => re.test(c)) : subject.command.every((c) => re.test(c));
  }
  if (subject.paths.length === 0) return false;
  const re = globToRegExp(rule.pattern.replace(/^\.\//, ""), { slashes: true });
  return mode === "any" ? subject.paths.some((p) => re.test(p)) : subject.paths.every((p) => re.test(p));
}

/** Deny, then ask, then allow; null when no rule speaks to this call. */
export function evaluateRules(
  rules: PermissionRules | undefined,
  toolName: string,
  input: Record<string, unknown>,
  projectRoot: string,
  patchPaths?: string[],
): RuleVerdict | null {
  if (!rules || (rules.allow.length + rules.ask.length + rules.deny.length === 0)) return null;
  const subject = {
    command: toolName === "shell" ? splitCommandLine(String(input.command ?? "").trim())?.map((t) => t.join(" ")) : undefined,
    paths: callPaths(toolName, input, projectRoot, patchPaths),
  };
  // A shell line the reader can't split is matched whole by deny and ask rules.
  const denySubject = toolName === "shell" && !subject.command ? { ...subject, command: [String(input.command ?? "").trim()] } : subject;
  for (const verdict of ["deny", "ask"] as const) {
    for (const raw of rules[verdict]) {
      const rule = parseRule(raw);
      if (rule && ruleMatches(rule, toolName, denySubject, "any")) return { verdict, rule: raw };
    }
  }
  if (toolName === "shell") {
    // Every command on the line must be allowed, each by some rule.
    if (!subject.command || subject.command.length === 0) return null;
    const parsed = rules.allow.map((raw) => ({ raw, rule: parseRule(raw) }));
    const covering = subject.command.map((c) => parsed.find(({ rule }) => rule && ruleMatches(rule, toolName, { command: [c], paths: [] }, "all")));
    return covering.every(Boolean) ? { verdict: "allow", rule: covering.map((c) => c!.raw).join(", ") } : null;
  }
  for (const raw of rules.allow) {
    const rule = parseRule(raw);
    if (rule && ruleMatches(rule, toolName, subject, "all")) return { verdict: "allow", rule: raw };
  }
  return null;
}

/** Split a `--allowedTools` value: commas outside parentheses. */
export function parseRuleList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const c of value) {
    if (c === "(") depth++;
    if (c === ")") depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function readRules(file: string): PermissionRules {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as { permissions?: Partial<Record<keyof PermissionRules, unknown>> };
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { allow: list(data.permissions?.allow), ask: list(data.permissions?.ask), deny: list(data.permissions?.deny) };
  } catch {
    return emptyRules();
  }
}

/**
 * The rules for a session: `~/.phren-agent/settings.json`, then the
 * project's `.phren-agent/settings.json`, then the command line. Lists are
 * concatenated; deny always wins over allow, wherever it came from.
 */
export function loadPermissionRules(projectRoot: string, cli?: Partial<PermissionRules>, home = os.homedir()): PermissionRules {
  const sources = [
    readRules(path.join(home, ".phren-agent", "settings.json")),
    readRules(path.join(projectRoot, ".phren-agent", "settings.json")),
    { ...emptyRules(), ...cli },
  ];
  return {
    allow: sources.flatMap((s) => s.allow ?? []),
    ask: sources.flatMap((s) => s.ask ?? []),
    deny: sources.flatMap((s) => s.deny ?? []),
  };
}
