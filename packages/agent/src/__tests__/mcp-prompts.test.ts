import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { connectMcpServers } from "../mcp-client.js";
import { isMcpPromptCommand, loadMcpPrompts, mcpPromptCommandNames, promptArguments, resolveMcpPromptCommand } from "../mcp-prompts.js";

/** A stdio MCP server with one tool and two prompts, speaking newline-delimited JSON-RPC. */
const SERVER = `
import * as readline from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize") return reply(msg.id, { protocolVersion: "2025-11-25", capabilities: { tools: {}, prompts: {} }, serverInfo: { name: "fake", version: "1" } });
  if (msg.method === "tools/list") return reply(msg.id, { tools: [{ name: "noop", inputSchema: { type: "object" } }] });
  if (msg.method === "prompts/list") return reply(msg.id, { prompts: [
    { name: "review", description: "Review a file", arguments: [{ name: "file", required: true }, { name: "focus" }] },
    { name: "standup" },
  ] });
  if (msg.method === "prompts/get") {
    const a = msg.params.arguments ?? {};
    const text = msg.params.name === "review" ? "Review " + a.file + (a.focus ? " for " + a.focus : "") : "Write today's standup.";
    return reply(msg.id, { messages: [{ role: "user", content: { type: "text", text } }] });
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }) + "\\n");
});
`;

describe("MCP prompts as slash commands", () => {
  let dir: string;
  let cleanup: () => void = () => {};
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-prompts-"));
    fs.writeFileSync(path.join(dir, "server.mjs"), SERVER);
    const connected = await connectMcpServers({ fake: { command: process.execPath, args: [path.join(dir, "server.mjs")] } });
    cleanup = connected.cleanup;
    await loadMcpPrompts();
  }, 30_000);
  afterAll(() => {
    cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists each server's prompts as /mcp__server__prompt", () => {
    expect(mcpPromptCommandNames()).toEqual(["/mcp__fake__review", "/mcp__fake__standup"]);
    expect(isMcpPromptCommand("/mcp__fake__review x")).toBe(true);
    expect(isMcpPromptCommand("/compact")).toBe(false);
  });

  it("fetches the prompt with positional arguments, the last taking the rest of the line", async () => {
    expect(await resolveMcpPromptCommand("/mcp__fake__review src/a.ts error handling and retries"))
      .toBe("Review src/a.ts for error handling and retries");
    expect(await resolveMcpPromptCommand("/mcp__fake__standup")).toBe("Write today's standup.");
  });

  it("says what's missing or unknown", async () => {
    await expect(resolveMcpPromptCommand("/mcp__fake__review")).rejects.toThrow("needs: file [focus]");
    await expect(resolveMcpPromptCommand("/mcp__fake__nope")).rejects.toThrow("No MCP prompt /mcp__fake__nope");
  });

  it("maps words onto declared arguments", () => {
    const prompt = { arguments: [{ name: "a" }, { name: "b" }, { name: "c" }] };
    expect(promptArguments(prompt, " one two three four ")).toEqual({ a: "one", b: "two", c: "three four" });
    expect(promptArguments(prompt, "one")).toEqual({ a: "one" });
    expect(promptArguments({}, "ignored")).toEqual({});
  });
});
