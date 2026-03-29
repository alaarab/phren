/**
 * Ink-based TUI entry point.
 * Bridges the agent loop (TurnHooks) to the React component tree.
 */
import React from "react";
import { render } from "ink";
import type { AgentConfig } from "../agent-loop.js";
import { createSession, runTurn, type AgentSession, type TurnHooks } from "../agent-loop.js";
import { handleCommand } from "../commands.js";
import type { InputMode } from "../repl.js";
import type { AgentSpawner } from "../multi/spawner.js";
import { renderMarkdown } from "../multi/markdown.js";
import { decodeDiffPayload, renderInlineDiff, DIFF_MARKER } from "../multi/diff-renderer.js";
import * as os from "os";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { loadInputMode, saveInputMode, savePermissionMode } from "../settings.js";
import { nextPermissionMode } from "./ansi.js";
import { formatToolInput, renderToolCall } from "./tool-render.js";
import { App, type AppState, type AppProps } from "./components/App.js";
import type { ChatMessageProps, ToolCallEntry } from "./components/ChatMessage.js";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const AGENT_VERSION = (_require("../../package.json") as { version: string }).version;

export async function startInkTui(config: AgentConfig, spawner?: AgentSpawner): Promise<AgentSession> {
  const contextLimit = config.provider.contextWindow ?? 200_000;
  const session = createSession(contextLimit);
  const startTime = Date.now();

  let inputMode: InputMode = loadInputMode();
  let pendingInput: string | null = null;
  const steerQueueBuf: string[] = [];
  let running = false;
  let msgCounter = 0;

  // Mutable render state — updated then pushed to React via re-render
  const completedMessages: ChatMessageProps[] = [];
  let streamingText = "";
  let thinking = false;
  let thinkStartTime = 0;
  let currentToolCalls: ToolCallEntry[] = [];

  function nextId(): string {
    return `msg-${++msgCounter}`;
  }

  function getAppState(): AppState {
    return {
      provider: config.provider.name,
      project: config.phrenCtx?.project ?? null,
      turns: session.turns,
      cost: "",
      permMode: config.registry.permissionConfig.mode,
      agentCount: spawner?.listAgents().length ?? 0,
    };
  }

  // Re-render the Ink app with current state
  let rerender: ((node: React.ReactElement) => void) | null = null;

  function update() {
    if (!rerender) return;
    rerender(
      <App
        state={getAppState()}
        completedMessages={[...completedMessages]}
        streamingText={streamingText}
        thinking={thinking}
        thinkStartTime={thinkStartTime}
        steerQueue={[...steerQueueBuf]}
        running={running}
        onSubmit={handleSubmit}
        onPermissionCycle={handlePermissionCycle}
        onExit={handleExit}
      />
    );
  }

  function handlePermissionCycle() {
    const next = nextPermissionMode(config.registry.permissionConfig.mode);
    config.registry.setPermissions({ ...config.registry.permissionConfig, mode: next });
    savePermissionMode(next);
    update();
  }

  let resolveSession: ((session: AgentSession) => void) | null = null;

  function handleExit() {
    if (resolveSession) resolveSession(session);
  }

  function handleSubmit(input: string) {
    const line = input.trim();
    if (!line) return;

    // Bash mode: ! prefix
    if (line.startsWith("!")) {
      const cmd = line.slice(1).trim();
      if (cmd) {
        const cdMatch = cmd.match(/^cd\s+(.*)/);
        if (cdMatch) {
          try {
            const target = cdMatch[1].trim().replace(/^~/, os.homedir());
            process.chdir(path.resolve(process.cwd(), target));
          } catch { /* ignore */ }
        } else {
          try {
            execSync(cmd, { encoding: "utf-8", timeout: 30_000, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
          } catch { /* ignore */ }
        }
      }
      update();
      return;
    }

    // Slash commands
    if (line === "/mode") {
      inputMode = inputMode === "steering" ? "queue" : "steering";
      saveInputMode(inputMode);
      update();
      return;
    }

    const cmdResult = handleCommand(line, {
      session,
      contextLimit,
      undoStack: [],
      providerName: config.provider.name,
      currentModel: (config.provider as { model?: string }).model,
      provider: config.provider,
      systemPrompt: config.systemPrompt,
      spawner,
      sessionId: config.sessionId,
      startTime,
      phrenPath: config.phrenCtx?.phrenPath,
      phrenCtx: config.phrenCtx,
      onModelChange: async (result) => {
        try {
          const { resolveProvider } = await import("../providers/resolve.js") as typeof import("../providers/resolve.js");
          const newProvider = resolveProvider(config.provider.name, result.model);
          config.provider = newProvider;
          const { buildSystemPrompt } = await import("../system-prompt.js") as typeof import("../system-prompt.js");
          config.systemPrompt = buildSystemPrompt(
            config.systemPrompt.split("\n## Last session")[0],
            null,
            { name: newProvider.name, model: result.model },
          );
          update();
        } catch { /* keep current provider */ }
      },
    });
    if (cmdResult === true || (typeof cmdResult === "object" && cmdResult instanceof Promise)) {
      update();
      return;
    }

    // If agent running, queue input
    if (running) {
      if (inputMode === "steering") {
        steerQueueBuf.push(line);
      } else {
        pendingInput = line;
      }
      update();
      return;
    }

    // Normal user message — add to history and run agent
    completedMessages.push({ id: nextId(), role: "user", text: line });
    update();
    runAgentTurn(line);
  }

  // TurnHooks bridge — updates mutable state, calls update()
  const tuiHooks: TurnHooks = {
    onTextDelta: (text) => {
      thinking = false;
      streamingText += text;
      update();
    },
    onTextDone: () => {
      // streaming complete — move to completed
    },
    onTextBlock: (text) => {
      thinking = false;
      streamingText += text;
      update();
    },
    onToolStart: (name, input, count) => {
      thinking = false;
      update();
    },
    onToolEnd: (name, input, output, isError, dur) => {
      const diffData = (name === "edit_file" || name === "write_file") ? decodeDiffPayload(output) : null;
      const cleanOutput = diffData ? output.slice(0, output.indexOf(DIFF_MARKER)) : output;
      currentToolCalls.push({ name, input, output: cleanOutput, isError, durationMs: dur });
      update();
    },
    onStatus: () => { update(); },
    getSteeringInput: () => {
      if (steerQueueBuf.length > 0 && inputMode === "steering") {
        return steerQueueBuf.shift()!;
      }
      if (pendingInput && inputMode === "steering") {
        const steer = pendingInput;
        pendingInput = null;
        return steer;
      }
      return null;
    },
  };

  async function runAgentTurn(userInput: string) {
    running = true;
    thinking = true;
    thinkStartTime = Date.now();
    streamingText = "";
    currentToolCalls = [];
    update();

    try {
      await runTurn(userInput, session, config, tuiHooks);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      streamingText += `\nError: ${msg}`;
    }

    // Finalize: move streaming content to completed messages
    thinking = false;
    if (streamingText || currentToolCalls.length > 0) {
      completedMessages.push({
        id: nextId(),
        role: "assistant",
        text: streamingText,
        toolCalls: currentToolCalls.length > 0 ? [...currentToolCalls] : undefined,
      });
    }
    streamingText = "";
    currentToolCalls = [];
    running = false;
    update();

    // Process queued input
    if (steerQueueBuf.length > 0) {
      const queued = steerQueueBuf.shift()!;
      completedMessages.push({ id: nextId(), role: "user", text: queued });
      update();
      runAgentTurn(queued);
    } else if (pendingInput) {
      const queued = pendingInput;
      pendingInput = null;
      completedMessages.push({ id: nextId(), role: "user", text: queued });
      update();
      runAgentTurn(queued);
    }
  }

  // Render the Ink app
  const app = render(
    <App
      state={getAppState()}
      completedMessages={[]}
      streamingText=""
      thinking={false}
      thinkStartTime={0}
      steerQueue={[]}
      running={false}
      onSubmit={handleSubmit}
      onPermissionCycle={handlePermissionCycle}
      onExit={handleExit}
    />,
    { exitOnCtrlC: false },
  );
  rerender = app.rerender;

  const done = new Promise<AgentSession>((r) => { resolveSession = r; });

  app.waitUntilExit().then(() => {
    if (resolveSession) resolveSession(session);
  });

  return done;
}
