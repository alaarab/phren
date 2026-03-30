/**
 * Ink-based TUI entry point.
 * Bridges the agent loop (TurnHooks) to the React component tree.
 */
import React from "react";
import { render } from "ink";
import type { AgentConfig } from "../agent-loop.js";
import { createSession, runTurn, type AgentSession, type TurnHooks } from "../agent-loop.js";
import type { InputMode } from "../repl.js";
import { useSlashCommands } from "./hooks/useSlashCommands.js";
import type { AgentSpawner } from "../multi/spawner.js";
import { decodeDiffPayload, DIFF_MARKER } from "../multi/diff-renderer.js";
import { formatToolInput } from "./tool-render.js";
import * as os from "os";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { loadInputMode, saveInputMode, savePermissionMode } from "../settings.js";
import { nextPermissionMode } from "./ansi.js";
import { App, type AppState, type ActiveToolInfo, type CompletedMessage } from "./components/App.js";
import type { ToolCallProps } from "./components/ToolCall.js";
import type { AgentTab } from "./components/InputArea.js";
import { createRequire } from "node:module";
import { getTheme, type Theme } from "./themes.js";

const _require = createRequire(import.meta.url);
const AGENT_VERSION = (_require("../../package.json") as { version: string }).version;

export async function startInkTui(config: AgentConfig, spawner?: AgentSpawner): Promise<AgentSession> {
  const contextLimit = config.provider.contextWindow ?? 200_000;
  const session = createSession(contextLimit);
  const startTime = Date.now();

  let inputMode: InputMode = loadInputMode();
  let pendingInput: string | null = null;
  const steerQueueBuf: string[] = [];
  const inputHistory: string[] = [];
  let running = false;
  let verbose = false;
  let theme: Theme = getTheme();
  let msgCounter = 0;

  // Mutable render state — updated then pushed to React via rerender()
  const completedMessages: CompletedMessage[] = [];
  let streamingText = "";
  let thinking = false;
  let thinkStartTime = 0;
  let thinkElapsed: string | null = null;
  let currentToolCalls: ToolCallProps[] = [];
  let activeTool: ActiveToolInfo | null = null;

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
      version: AGENT_VERSION,
    };
  }

  // Re-render the Ink app with current state
  let rerender: ((node: React.ReactElement) => void) | null = null;

  function update() {
    if (!rerender) return;

    // If an agent tab is selected, show that agent's conversation
    const agentConvo = selectedAgentId ? agentConvos.get(selectedAgentId) : null;
    const displayMessages = agentConvo ? [...agentConvo.messages] : [...completedMessages];
    const displayStreaming = agentConvo ? agentConvo.streamingText : streamingText;
    const displayToolCalls = agentConvo ? [...agentConvo.toolCalls] : [...currentToolCalls];
    const displayActiveTool = agentConvo ? agentConvo.activeTool : activeTool;
    const displayThinking = agentConvo ? false : thinking;
    const displayRunning = agentConvo ? false : running;

    rerender(
      <App
        state={getAppState()}
        completedMessages={displayMessages}
        streamingText={displayStreaming}
        completedToolCalls={displayToolCalls}
        activeTool={displayActiveTool}
        thinking={displayThinking}
        thinkStartTime={thinkStartTime}
        thinkElapsed={agentConvo ? null : thinkElapsed}
        steerQueue={agentConvo ? [] : [...steerQueueBuf]}
        running={displayRunning}
        showBanner={!selectedAgentId}
        inputHistory={[...inputHistory]}
        verbose={verbose}
        theme={theme}
        onSubmit={handleSubmit}
        onPermissionCycle={handlePermissionCycle}
        onCancelTurn={handleCancelTurn}
        onExit={handleExit}
        agents={agentTabs.length > 0 ? [{ id: "__main__", name: "phren", status: running ? "running" : "idle" }, ...agentTabs] : undefined}
        selectedAgentId={selectedAgentId ?? (agentTabs.length > 0 ? "__main__" : undefined)}
        onSelectAgent={(id) => handleSelectAgent(id === "__main__" ? null : id)}
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

  function handleCancelTurn() {
    // Signal cancellation — the running turn will see this via steering
    pendingInput = null;
    steerQueueBuf.length = 0;
    update();
  }

  // Slash command handler — captures stderr and displays as status messages
  const slashCommands = useSlashCommands({
    commandContext: {
      session,
      contextLimit,
      undoStack: [],
      providerName: config.provider.name,
      currentModel: (config.provider as { model?: string }).model,
      currentReasoning: config.provider.reasoningEffort ?? null,
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
          const newProvider = resolveProvider(config.provider.name, result.model, undefined, result.reasoning ?? undefined);
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
    },
    onOutput: (text) => {
      completedMessages.push({ id: nextId(), kind: "status", text });
    },
  });

  function handleSubmit(input: string) {
    const line = input.trim();
    if (!line) return;

    // Track input history (skip duplicates of the last entry)
    if (inputHistory.length === 0 || inputHistory[inputHistory.length - 1] !== line) {
      inputHistory.push(line);
    }

    // Bash mode: ! prefix
    if (line.startsWith("!")) {
      const cmd = line.slice(1).trim();
      let output = "";
      if (cmd) {
        const cdMatch = cmd.match(/^cd\s+(.*)/);
        if (cdMatch) {
          try {
            const target = cdMatch[1].trim().replace(/^~/, os.homedir());
            process.chdir(path.resolve(process.cwd(), target));
            output = process.cwd();
          } catch (err: unknown) {
            output = (err as Error).message;
          }
        } else {
          try {
            output = execSync(cmd, { encoding: "utf-8", timeout: 30_000, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
          } catch (err: unknown) {
            const e = err as { stderr?: string; message?: string };
            output = e.stderr || e.message || "Command failed";
          }
        }
      }
      if (output) {
        completedMessages.push({ id: nextId(), kind: "status", text: output.replace(/\n$/, "") });
      }
      update();
      return;
    }

    // Slash commands
    if (line === "/mode") {
      inputMode = inputMode === "steering" ? "queue" : "steering";
      saveInputMode(inputMode);
      completedMessages.push({ id: nextId(), kind: "status", text: `Input mode: ${inputMode}` });
      update();
      return;
    }

    if (line === "/verbose") {
      verbose = !verbose;
      completedMessages.push({ id: nextId(), kind: "status", text: `Verbose: ${verbose ? "on" : "off"}` });
      update();
      return;
    }

    if (line === "/theme") {
      theme = getTheme(theme.name === "dark" ? "light" : "dark");
      completedMessages.push({ id: nextId(), kind: "status", text: `Theme: ${theme.name}` });
      update();
      return;
    }

    // /clear — also wipe Ink completed messages and clear screen
    if (line === "/clear") {
      completedMessages.length = 0;
      process.stdout.write("\x1b[2J\x1b[H");
      slashCommands.tryHandleCommand(line);
      update();
      return;
    }

    // Slash commands — capture stderr output and display as status message
    if (line.startsWith("/")) {
      if (slashCommands.tryHandleCommand(line)) {
        update();
        return;
      }
    }

    // If agent running, queue input for steering
    if (running) {
      if (inputMode === "steering") {
        steerQueueBuf.push(line);
      } else {
        pendingInput = line;
      }
      update();
      return;
    }

    // Normal user message — add to completed history and run agent turn
    completedMessages.push({ id: nextId(), kind: "user", text: line });
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
      // streaming complete — finalized in runAgentTurn
    },
    onTextBlock: (text) => {
      thinking = false;
      streamingText += text;
      update();
    },
    onToolStart: (name, input, _count) => {
      thinking = false;
      activeTool = { name, preview: formatToolInput(name, input) };
      update();
    },
    onToolEnd: (name, input, output, isError, dur) => {
      activeTool = null;
      const diffData = (name === "edit_file" || name === "write_file") ? decodeDiffPayload(output) : null;
      const cleanOutput = diffData ? output.slice(0, output.indexOf(DIFF_MARKER)) : output;
      currentToolCalls.push({ name, input, output: cleanOutput, isError, durationMs: dur });
      update();
    },
    getSteeringInput: () => {
      const result = (() => {
        if (steerQueueBuf.length > 0 && inputMode === "steering") {
          return steerQueueBuf.shift()!;
        }
        if (pendingInput && inputMode === "steering") {
          const steer = pendingInput;
          pendingInput = null;
          return steer;
        }
        return null;
      })();
      return result;
    },
  };

  async function runAgentTurn(userInput: string) {
    running = true;
    thinking = true;
    thinkStartTime = Date.now();
    thinkElapsed = null;
    streamingText = "";
    currentToolCalls = [];
    activeTool = null;
    update();

    try {
      await runTurn(userInput, session, config, tuiHooks);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      streamingText += `\nError: ${msg}`;
    }

    // Compute elapsed time
    const elapsed = ((Date.now() - thinkStartTime) / 1000).toFixed(1);

    // Finalize: move streaming content + tool calls to completed messages
    thinking = false;
    if (streamingText || currentToolCalls.length > 0) {
      completedMessages.push({
        id: nextId(),
        kind: "assistant",
        text: streamingText,
        toolCalls: currentToolCalls.length > 0 ? [...currentToolCalls] : undefined,
      });
    }
    streamingText = "";
    currentToolCalls = [];
    activeTool = null;
    running = false;
    thinkElapsed = elapsed;
    update();

    // Clear elapsed indicator after a brief display
    setTimeout(() => {
      thinkElapsed = null;
      update();
    }, 2000);

    // Process queued input — steer queue first, then pending
    if (steerQueueBuf.length > 0) {
      const queued = steerQueueBuf.shift()!;
      completedMessages.push({ id: nextId(), kind: "user", text: queued });
      update();
      runAgentTurn(queued);
    } else if (pendingInput) {
      const queued = pendingInput;
      pendingInput = null;
      completedMessages.push({ id: nextId(), kind: "user", text: queued });
      update();
      runAgentTurn(queued);
    }
  }

  // ── Multi-agent state ──────────────────────────────────────────────────
  // Per-agent conversation threads. null key = main orchestrator.
  interface AgentConvo {
    messages: CompletedMessage[];
    streamingText: string;
    toolCalls: ToolCallProps[];
    activeTool: ActiveToolInfo | null;
  }
  const agentConvos = new Map<string, AgentConvo>();
  let selectedAgentId: string | null = null; // null = main thread
  let agentTabs: AgentTab[] = [];

  function getOrCreateConvo(agentId: string): AgentConvo {
    let convo = agentConvos.get(agentId);
    if (!convo) {
      convo = { messages: [], streamingText: "", toolCalls: [], activeTool: null };
      agentConvos.set(agentId, convo);
    }
    return convo;
  }

  function rebuildAgentTabs() {
    if (!spawner) { agentTabs = []; return; }
    agentTabs = spawner.listAgents().map((a) => ({
      id: a.id,
      name: a.task.slice(0, 20),
      status: a.status as AgentTab["status"],
    }));
  }

  function handleSelectAgent(agentId: string | null) {
    selectedAgentId = agentId;
    update();
  }

  // Wire spawner events to per-agent conversations
  if (spawner) {
    spawner.on("text_delta", (agentId: string, text: string) => {
      const convo = getOrCreateConvo(agentId);
      convo.streamingText += text;
      rebuildAgentTabs();
      if (selectedAgentId === agentId) update();
    });

    spawner.on("text_block", (agentId: string, text: string) => {
      const convo = getOrCreateConvo(agentId);
      convo.streamingText += text;
      rebuildAgentTabs();
      if (selectedAgentId === agentId) update();
    });

    spawner.on("tool_start", (agentId: string, toolName: string, input: Record<string, unknown>) => {
      const convo = getOrCreateConvo(agentId);
      convo.activeTool = { name: toolName, preview: formatToolInput(toolName, input) };
      rebuildAgentTabs();
      if (selectedAgentId === agentId) update();
    });

    spawner.on("tool_end", (agentId: string, toolName: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number) => {
      const convo = getOrCreateConvo(agentId);
      convo.activeTool = null;
      convo.toolCalls.push({ name: toolName, input, output, isError, durationMs });
      rebuildAgentTabs();
      if (selectedAgentId === agentId) update();
    });

    spawner.on("done", (agentId: string, result: { finalText: string; turns: number; toolCalls: number; totalCost?: string }) => {
      const convo = getOrCreateConvo(agentId);
      // Finalize streaming into completed message
      if (convo.streamingText || convo.toolCalls.length > 0) {
        convo.messages.push({
          id: nextId(),
          kind: "assistant",
          text: convo.streamingText || result.finalText,
          toolCalls: convo.toolCalls.length > 0 ? [...convo.toolCalls] : undefined,
        });
      }
      convo.streamingText = "";
      convo.toolCalls = [];
      convo.activeTool = null;
      rebuildAgentTabs();
      update();
    });

    spawner.on("error", (agentId: string, error: string) => {
      const convo = getOrCreateConvo(agentId);
      convo.messages.push({ id: nextId(), kind: "status", text: `Error: ${error}` });
      convo.streamingText = "";
      convo.activeTool = null;
      rebuildAgentTabs();
      update();
    });

    spawner.on("idle", (agentId: string, reason: string) => {
      const convo = getOrCreateConvo(agentId);
      convo.messages.push({ id: nextId(), kind: "status", text: `Agent idle (${reason})` });
      rebuildAgentTabs();
      update();
    });

    spawner.on("exit", () => {
      rebuildAgentTabs();
      update();
    });
  }

  // Clear screen before initial render — start clean
  process.stdout.write("\x1b[2J\x1b[H");
  const projectName = config.phrenCtx?.project ?? "phren";
  process.title = "phren";
  process.stdout.write(`\x1b]0;phren \xb7 ${projectName}\x07`); // set terminal window title

  // Initial render
  const app = render(
    <App
      state={getAppState()}
      completedMessages={[]}
      streamingText=""
      completedToolCalls={[]}
      activeTool={null}
      thinking={false}
      thinkStartTime={0}
      thinkElapsed={null}
      steerQueue={[]}
      running={false}
      showBanner={true}
      inputHistory={[]}
      verbose={verbose}
      theme={theme}
      onSubmit={handleSubmit}
      onPermissionCycle={handlePermissionCycle}
      onCancelTurn={handleCancelTurn}
      onExit={handleExit}
      agents={undefined}
      selectedAgentId={undefined}
      onSelectAgent={handleSelectAgent}
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
