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

  // Permission prompt state — when set, input field captures y/n/a/s
  let permissionResolve: ((allowed: boolean) => void) | null = null;

  // Ink-compatible askUser: shows prompt in chat, waits for y/n in input
  config.registry.askUser = async (toolName, input, reason) => {
    const { addAllow } = await import("../permissions/allowlist.js");
    const summary = Object.keys(input).length > 0
      ? `${toolName}(${Object.entries(input).map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 40)}`).join(", ")})`
      : toolName;

    completedMessages.push({
      id: nextId(),
      kind: "status",
      text: `\x1b[1m\x1b[33m[PERMISSION]\x1b[0m ${toolName}\n  ${reason}\n  ${summary}\n  \x1b[2m[y]es  [n]o  [a]llow-tool  [s]ession-allow\x1b[0m`,
    });
    update();

    return new Promise<boolean>((resolve) => {
      permissionResolve = (allowed) => {
        permissionResolve = null;
        resolve(allowed);
      };
      // Store the addAllow function for a/s responses
      (permissionResolve as unknown as { toolName: string; input: Record<string, unknown>; addAllow: typeof addAllow }).toolName = toolName;
      (permissionResolve as unknown as { toolName: string; input: Record<string, unknown>; addAllow: typeof addAllow }).input = input;
      (permissionResolve as unknown as { toolName: string; input: Record<string, unknown>; addAllow: typeof addAllow }).addAllow = addAllow;
    });
  };

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
    rerender(
      <App
        state={getAppState()}
        completedMessages={[...completedMessages]}
        streamingText={streamingText}
        completedToolCalls={[...currentToolCalls]}
        activeTool={activeTool}
        thinking={thinking}
        thinkStartTime={thinkStartTime}
        thinkElapsed={thinkElapsed}
        steerQueue={[...steerQueueBuf]}
        running={running}
        showBanner={true}
        inputHistory={[...inputHistory]}
        verbose={verbose}
        theme={theme}
        onSubmit={handleSubmit}
        onPermissionCycle={handlePermissionCycle}
        onCancelTurn={handleCancelTurn}
        onExit={handleExit}
        agents={agentTabs.length > 0 ? [{ id: "__main__", name: "phren", status: running ? "running" as const : "idle" as const, color: "magentaBright" }, ...agentTabs] : undefined}
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

    // Permission prompt active — intercept y/n/a/s
    if (permissionResolve) {
      const key = line.toLowerCase();
      const meta = permissionResolve as unknown as { toolName: string; input: Record<string, unknown>; addAllow: (t: string, i: Record<string, unknown>, s: string) => void };
      if (key === "y" || key === "yes") {
        completedMessages.push({ id: nextId(), kind: "status", text: "\x1b[32m✓ Allowed\x1b[0m" });
        permissionResolve(true);
      } else if (key === "a") {
        completedMessages.push({ id: nextId(), kind: "status", text: "\x1b[32m✓ Allowed (tool for session)\x1b[0m" });
        meta.addAllow(meta.toolName, meta.input, "tool");
        permissionResolve(true);
      } else if (key === "s") {
        completedMessages.push({ id: nextId(), kind: "status", text: "\x1b[32m✓ Allowed (session)\x1b[0m" });
        meta.addAllow(meta.toolName, meta.input, "session");
        permissionResolve(true);
      } else {
        completedMessages.push({ id: nextId(), kind: "status", text: "\x1b[31m✗ Denied\x1b[0m" });
        permissionResolve(false);
      }
      update();
      return;
    }

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

    // If a spawned agent is selected, send input to THAT agent
    if (selectedAgentId && selectedAgentId !== "__main__" && spawner) {
      const agent = spawner.getAgent(selectedAgentId);
      const agentName = agent?.displayName || selectedAgentId;
      completedMessages.push({ id: nextId(), kind: "user", text: `[→ ${agentName}] ${line}` });

      if (agent?.status === "idle") {
        spawner.wakeAgent(selectedAgentId, { message: line, from: "user" });
      } else {
        spawner.sendToAgent(selectedAgentId, line, "user");
      }
      update();
      return;
    }

    // Normal user message — add to completed history and run main agent turn
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
  // Single chat stream — all agent output goes into completedMessages.
  // Tabs just control INPUT routing — who you're talking to.
  let selectedAgentId: string | null = null; // null = main orchestrator
  let agentTabs: AgentTab[] = [];
  const TAB_COLORS = ["cyan", "magenta", "yellow", "green", "blue", "red", "white", "cyanBright"];

  function getAgentLabel(agentId: string): string {
    const agent = spawner?.getAgent(agentId);
    const name = agent?.displayName || agentId;
    const agents = spawner?.listAgents() ?? [];
    const idx = agents.findIndex((a) => a.id === agentId);
    const color = TAB_COLORS[idx >= 0 ? idx % TAB_COLORS.length : 0];
    return `\x1b[1m\x1b[${color === "cyan" ? "36" : color === "magenta" ? "35" : color === "yellow" ? "33" : color === "green" ? "32" : color === "blue" ? "34" : color === "red" ? "31" : "37"}m[${name}]\x1b[0m`;
  }

  function rebuildAgentTabs() {
    if (!spawner) { agentTabs = []; return; }
    agentTabs = spawner.listAgents().map((a, i) => ({
      id: a.id,
      name: a.displayName || a.task.slice(0, 20),
      status: a.status as AgentTab["status"],
      color: TAB_COLORS[i % TAB_COLORS.length],
    }));
  }

  function handleSelectAgent(agentId: string | null) {
    selectedAgentId = agentId;
    // Add a status message showing the switch
    if (agentId && agentId !== "__main__") {
      const agent = spawner?.getAgent(agentId);
      const name = agent?.displayName || agentId;
      completedMessages.push({ id: nextId(), kind: "status", text: `Switched to ${name} — your messages now go to this agent` });
    } else {
      completedMessages.push({ id: nextId(), kind: "status", text: "Switched to main — your messages now go to the orchestrator" });
    }
    update();
  }

  // Wire spawner events — ALL output goes into the ONE main chat stream
  if (spawner) {
    spawner.on("text_delta", (agentId: string, text: string) => {
      // Show agent streaming in the main stream (only if it's the active agent or no agent selected)
      streamingText += text;
      rebuildAgentTabs();
      update();
    });

    spawner.on("text_block", (agentId: string, text: string) => {
      const label = getAgentLabel(agentId);
      completedMessages.push({ id: nextId(), kind: "status", text: `${label} ${text}` });
      rebuildAgentTabs();
      update();
    });

    spawner.on("tool_start", (agentId: string, toolName: string, input: Record<string, unknown>) => {
      const label = getAgentLabel(agentId);
      activeTool = { name: `${label} ${toolName}`, preview: formatToolInput(toolName, input) };
      rebuildAgentTabs();
      update();
    });

    spawner.on("tool_end", (agentId: string, toolName: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number) => {
      activeTool = null;
      currentToolCalls.push({ name: toolName, input, output, isError, durationMs });
      rebuildAgentTabs();
      update();
    });

    spawner.on("done", (agentId: string, result: { finalText: string; turns: number; toolCalls: number; totalCost?: string }) => {
      const label = getAgentLabel(agentId);
      // Finalize any streaming text + tool calls into a completed message
      if (streamingText || currentToolCalls.length > 0) {
        completedMessages.push({
          id: nextId(),
          kind: "assistant",
          text: `${label} ${streamingText || result.finalText}`,
          toolCalls: currentToolCalls.length > 0 ? [...currentToolCalls] : undefined,
        });
        streamingText = "";
        currentToolCalls = [];
      } else if (result.finalText) {
        completedMessages.push({
          id: nextId(),
          kind: "assistant",
          text: `${label} ${result.finalText}`,
        });
      }
      activeTool = null;
      rebuildAgentTabs();
      update();
    });

    spawner.on("error", (agentId: string, error: string) => {
      const label = getAgentLabel(agentId);
      completedMessages.push({ id: nextId(), kind: "status", text: `${label} Error: ${error}` });
      rebuildAgentTabs();
      update();
    });

    spawner.on("idle", (agentId: string, reason: string) => {
      const label = getAgentLabel(agentId);
      completedMessages.push({ id: nextId(), kind: "status", text: `${label} idle (${reason})` });
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
