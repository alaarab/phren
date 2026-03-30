import { describe, it, expect } from "vitest";
import { runAgent } from "../agent-loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { readFileTool } from "../tools/read-file.js";
import { writeFileTool } from "../tools/write-file.js";
import { editFileTool } from "../tools/edit-file.js";
import { shellTool } from "../tools/shell.js";
import { globTool } from "../tools/glob.js";
import { grepTool } from "../tools/grep.js";
import { createWebFetchTool } from "../tools/web-fetch.js";
import { createWebSearchTool } from "../tools/web-search.js";
import { gitStatusTool, gitDiffTool, gitCommitTool } from "../tools/git.js";
import { createPhrenSearchTool } from "../tools/phren-search.js";
import { createPhrenFindingTool } from "../tools/phren-finding.js";
import { createPhrenGetTasksTool, createPhrenCompleteTaskTool } from "../tools/phren-tasks.js";
import { createPhrenAddTaskTool } from "../tools/phren-add-task.js";
import { buildPhrenContext } from "../memory/context.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { resolveProvider } from "../providers/resolve.js";
import { hasCodexToken } from "../providers/codex-auth.js";
import type { AgentConfig } from "../agent-loop.js";

/**
 * Build a full AgentConfig using the Codex provider and real tools.
 * Mirrors the setup in index.ts but without CLI arg parsing.
 */
async function buildTestConfig(overrides?: Partial<AgentConfig>): Promise<AgentConfig> {
  const provider = resolveProvider("openai-codex");

  const phrenCtx = await buildPhrenContext("phren");
  const systemPrompt = buildSystemPrompt("", null, {
    name: provider.name,
    model: (provider as { model?: string }).model,
  });

  const registry = new ToolRegistry();
  registry.setPermissions({
    mode: "full-auto",
    allowedPaths: [],
    projectRoot: process.cwd(),
  });

  // Core tools
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(shellTool);
  registry.register(globTool);
  registry.register(grepTool);
  registry.register(createWebFetchTool());
  registry.register(createWebSearchTool());
  registry.register(gitStatusTool);
  registry.register(gitDiffTool);
  registry.register(gitCommitTool);

  // Phren memory tools
  if (phrenCtx) {
    registry.register(createPhrenSearchTool(phrenCtx));
    registry.register(createPhrenFindingTool(phrenCtx, null));
    registry.register(createPhrenGetTasksTool(phrenCtx));
    registry.register(createPhrenCompleteTaskTool(phrenCtx, null));
    registry.register(createPhrenAddTaskTool(phrenCtx, null));
  }

  return {
    provider,
    registry,
    systemPrompt,
    maxTurns: 3,
    verbose: false,
    phrenCtx,
    // Suppress stdout/stderr output during tests
    hooks: {
      onTextDelta: () => {},
      onTextDone: () => {},
      onTextBlock: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onStatus: () => {},
    },
    ...overrides,
  };
}

describe("integration", () => {
  // Skip the entire suite if no Codex token is available
  const canRun = hasCodexToken();
  const testFn = canRun ? it : it.skip;

  testFn("simple text response", async () => {
    const config = await buildTestConfig();
    const result = await runAgent("say hello in exactly 3 words", config);

    expect(result.finalText).toBeTruthy();
    expect(result.finalText.length).toBeGreaterThan(0);
    expect(result.turns).toBeGreaterThanOrEqual(1);
  }, 60_000);

  testFn("tool calling — read_file", async () => {
    const config = await buildTestConfig();
    const result = await runAgent(
      "what is in the file package.json in this directory? read it",
      config,
    );

    expect(result.finalText).toBeTruthy();
    expect(result.turns).toBeGreaterThanOrEqual(1);

    // Verify read_file was actually called
    const toolUseBlocks = result.messages
      .filter((m) => m.role === "assistant" && Array.isArray(m.content))
      .flatMap((m) => (m.content as Array<{ type: string; name?: string }>))
      .filter((b) => b.type === "tool_use");

    const readFileCalls = toolUseBlocks.filter((b) => b.name === "read_file");
    expect(readFileCalls.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  testFn("memory search — phren_search", async () => {
    const config = await buildTestConfig();
    const result = await runAgent(
      "search phren for recent findings",
      config,
    );

    expect(result.finalText).toBeTruthy();
    expect(result.turns).toBeGreaterThanOrEqual(1);

    // Verify phren_search was called
    const toolUseBlocks = result.messages
      .filter((m) => m.role === "assistant" && Array.isArray(m.content))
      .flatMap((m) => (m.content as Array<{ type: string; name?: string }>))
      .filter((b) => b.type === "tool_use");

    const searchCalls = toolUseBlocks.filter((b) => b.name === "phren_search");
    expect(searchCalls.length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
