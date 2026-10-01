/**
 * MCP prompts as slash commands, the way Claude Code offers them:
 * `/mcp__<server>__<prompt> [args]` fetches the prompt from its server and
 * sends what it returns as the next message.
 *
 * Arguments are positional, in the order the prompt declares them; the last
 * one takes the rest of the line, so a single free-text argument needs no
 * quoting.
 */
import { mcpRegistry, type McpPromptListing } from "./mcp-client.js";

const PREFIX = "/mcp__";

let known: McpPromptListing[] = [];

/** Ask every connected server for its prompts; a server without prompts is skipped. */
export async function loadMcpPrompts(): Promise<McpPromptListing[]> {
  const out: McpPromptListing[] = [];
  for (const server of mcpRegistry.listServers()) {
    try {
      out.push(...await mcpRegistry.listPrompts(server));
    } catch {
      // Prompts are optional in MCP; "method not found" is normal.
    }
  }
  known = out;
  return out;
}

export function mcpPromptCommandName(prompt: Pick<McpPromptListing, "server" | "name">): string {
  return `${PREFIX}${prompt.server}__${prompt.name}`;
}

/** Slash command names for the prompts found by loadMcpPrompts, for completion and help. */
export function mcpPromptCommandNames(): string[] {
  return known.map(mcpPromptCommandName);
}

export function isMcpPromptCommand(input: string): boolean {
  return input.startsWith(PREFIX);
}

/** Map the words after the command onto the prompt's declared arguments. */
export function promptArguments(prompt: Pick<McpPromptListing, "arguments">, rest: string): Record<string, string> {
  const names = (prompt.arguments ?? []).map((a) => a.name);
  const args: Record<string, string> = {};
  let remaining = rest.trim();
  names.forEach((name, i) => {
    if (!remaining) return;
    if (i === names.length - 1) {
      args[name] = remaining;
      remaining = "";
      return;
    }
    const match = /^(\S+)\s*([\s\S]*)$/.exec(remaining)!;
    args[name] = match[1];
    remaining = match[2];
  });
  return args;
}

type PromptContent = { type?: string; text?: string; resource?: { text?: string; uri?: string } };

function contentText(content: PromptContent | PromptContent[]): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((b) => (typeof b.text === "string" ? b.text : b.resource?.text ?? (b.resource?.uri ? `[resource ${b.resource.uri}]` : "")))
    .filter(Boolean)
    .join("\n");
}

/**
 * The message an `/mcp__server__prompt …` line becomes. Throws with a message
 * fit for the user when the prompt is unknown, an argument is missing, or the
 * server fails.
 */
export async function resolveMcpPromptCommand(input: string): Promise<string> {
  const trimmed = input.trim();
  const command = trimmed.split(/\s+/, 1)[0];
  const rest = trimmed.slice(command.length);
  const prompt = known.find((p) => mcpPromptCommandName(p) === command);
  if (!prompt) throw new Error(`No MCP prompt ${command}.${known.length > 0 ? ` Known: ${mcpPromptCommandNames().join(", ")}` : " No connected server offers prompts."}`);
  const args = promptArguments(prompt, rest);
  const missing = (prompt.arguments ?? []).filter((a) => a.required && !args[a.name]).map((a) => a.name);
  if (missing.length > 0) throw new Error(`${command} needs: ${(prompt.arguments ?? []).map((a) => (a.required ? a.name : `[${a.name}]`)).join(" ")}`);
  const result = await mcpRegistry.getPrompt(prompt.server, prompt.name, args);
  const text = (result.messages ?? [])
    .map((m) => {
      const body = contentText(m.content as PromptContent | PromptContent[]);
      return m.role === "assistant" && body ? `(assistant) ${body}` : body;
    })
    .filter(Boolean)
    .join("\n\n");
  if (!text) throw new Error(`${command} returned no text.`);
  return text;
}

/** Test seam. */
export function setMcpPrompts(prompts: McpPromptListing[]): void {
  known = prompts;
}
