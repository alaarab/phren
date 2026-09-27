import path from "node:path";

export type RequestKind = "command" | "tool" | "edit" | "question" | "other";
export interface ApprovalRequest { tool?: string; input?: unknown; cwd?: string; message?: string; question?: boolean }

const fallback = "Open Phren to review the request.";
const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

export function approvalTitle(agent: string, project?: string, computer?: string): string {
  const label = ({ claude: "Claude", codex: "Codex", opencode: "opencode", copilot: "Copilot" } as Record<string, string>)[agent.toLowerCase()] ?? "Your agent";
  return `${label}${project ? ` · ${project}` : ""}${computer ? ` on ${computer}` : ""}`;
}

/** Sanitize the whole line before shortening it for the notification. */
export function redactApproval(value: string): string {
  return value
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s'"<>]+/g, raw => {
      try {
        const suffix = /[),.;!?]+$/.exec(raw)?.[0] ?? "";
        const url = new URL(raw.slice(0, raw.length - suffix.length));
        return `${url.protocol}//${url.host}${url.pathname}${suffix}`;
      } catch { return "…"; }
    })
    .replace(/\bAuthorization\s*:\s*Bearer\s+(\S+)/gi, (_whole, token: string) => `Authorization: Bearer …${/["']$/.test(token) ? token.slice(-1) : ""}`)
    .replace(/(^|\s)(--(?:token|password|secret|api-key|access-token))(?:\s+|=)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1$2 …")
    // -p is a password only for MySQL-style clients (-pSECRET); elsewhere it is
    // mkdir -p, ssh -p 22, git log -p, claude -p.
    .replace(/(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n]*?\s-p)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1…")
    // Environment assignments only: a word after a separator, not a --flag=value.
    .replace(/(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s;]+)/g, "$1$2=…")
    .replace(/\b(?:gh[po]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|xox[abp]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{32,})\b/g, "…");
}

export function shortApproval(value: string): string {
  const line = oneLine(redactApproval(value));
  if (line.length <= 110) return line;
  const prefix = line.slice(0, 109);
  const boundary = prefix.lastIndexOf(" ");
  return (boundary >= 65 ? prefix.slice(0, boundary) : prefix).trimEnd() + "…";
}

/** A terminal approval dialog's command: Codex shows `$ <command>`, Claude's
 * dialog a `Bash command` heading over it. */
function dialogCommand(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return (/^\s*\$ (\S.*)$/m.exec(text) ?? /^\s*Bash command\s*\n+\s*(\S.*)$/m.exec(text))?.[1].trim();
}

function commandText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const wrapped = /^(?:\/[^\s]+\/)?(?:ba|z|fi)?sh\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/i.exec(value.trim());
    return wrapped ? wrapped[2] : value;
  }
  if (!Array.isArray(value)) return undefined;
  const argv = value.filter((part): part is string => typeof part === "string");
  if (!argv.length) return undefined;
  const shell = /(?:^|\/)(?:ba|z|fi)?sh$/.test(argv[0]);
  const option = argv.findIndex((part, index) => index > 0 && /^-[a-z]*c$/.test(part));
  return shell && option >= 0 && argv[option + 1] ? argv[option + 1] : argv.join(" ");
}

function relativeFile(file: string, cwd?: string): string {
  if (!cwd || !path.isAbsolute(file) || !path.isAbsolute(cwd)) return file;
  const relative = path.relative(cwd, file);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative.split(path.sep).join("/") : file;
}

export function approvalSummary(value: ApprovalRequest): { request: string; requestKind: RequestKind } {
  const input = fields(value.input), tool = value.tool ?? "";
  let line: string | undefined, requestKind: RequestKind = "other";
  if (value.question || /^AskUserQuestion$/i.test(tool)) {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    line = string(fields(questions[0]).question) ?? string(input.question) ?? string(input.message) ?? value.message;
    if (line) requestKind = "question";
  } else {
    const messageCommand = /^(?:bash|shell):\s*(.+)$/is.exec(value.message ?? "")?.[1];
    // A terminal dialog read from the pane arrives as tool "Question".
    const shown = tool === "Question" ? dialogCommand(value.message) : undefined;
    const command = commandText(input.command ?? input.cmd ?? input.commandLine ?? (Array.isArray(value.input) ? value.input : undefined)) ?? messageCommand ?? shown;
    if (command && (shown !== undefined || /^(?:Bash|Shell|exec_command|functions\.shell|bash|shell)$/i.test(tool) || input.command !== undefined || input.cmd !== undefined || input.commandLine !== undefined)) {
      line = `Run: ${command}`; requestKind = "command";
    } else {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
      const sentence = /Allow the ([\w.-]+) MCP server to run tool ([\w.-]+)\?/i.exec(value.message ?? string(input.description) ?? "");
      const server = mcp?.[1] ?? string(input.serverName) ?? string(input.server_name) ?? string(input.mcpServerName)
        ?? string(input.server) ?? sentence?.[1];
      const name = mcp?.[2] ?? string(input.toolName) ?? string(input.tool_name) ?? string(input.mcpToolName)
        ?? string(input.tool) ?? sentence?.[2];
      if (server && name) { line = `${server} MCP: ${name}`; requestKind = "tool"; }
      else {
        const patch = string(input.patch) ?? (typeof value.input === "string" ? value.input : undefined);
        const changed = patch ? new Set([...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^diff --git a\/(.+?) b\/(.+)$/gm)]
          .map(match => match[1] ?? match[3])).size : 0;
        const file = string(input.file_path) ?? string(input.filePath) ?? string(input.path);
        if (changed > 1) line = `Apply patch: ${changed} files`;
        else if (file && /(?:edit|write|patch|apply)/i.test(tool)) line = `${/write/i.test(tool) || /\*\*\* Add File:/.test(patch ?? "") ? "Write" : "Edit"}: ${relativeFile(file, value.cwd)}`;
        else if (changed === 1 && patch) {
          const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/m.exec(patch);
          line = match ? `${match[1] === "Add" ? "Write" : "Edit"}: ${relativeFile(match[2], value.cwd)}` : "Apply patch: 1 file";
        }
        if (line) requestKind = "edit";
        else {
          const primary = string(input.path) ?? string(input.file_path) ?? string(input.pattern) ?? string(input.query)
            ?? string(input.description) ?? string(input.question) ?? string(input.message) ?? value.message;
          if (primary && tool === "Question") { line = primary; requestKind = "question"; }
          else if (primary) {
            const argument = tool && primary.toLowerCase().startsWith(`${tool.toLowerCase()}:`) ? primary.slice(tool.length + 1).trimStart() : primary;
            line = `${tool && tool !== "action" ? tool : "Request"}: ${argument}`; requestKind = "tool";
          }
          else if (tool && tool !== "action") { line = tool; requestKind = "tool"; }
        }
      }
    }
  }
  const request = line ? shortApproval(line) : fallback;
  return { request: request || fallback, requestKind: line ? requestKind : "other" };
}
