/**
 * Ink-based TUI entry point.
 * Bridges the agent loop (TurnHooks) to the React component tree.
 */
import React from "react";
import { render } from "ink";
import type { AgentConfig } from "../agent-loop.js";
import { createSession, runTurn, type AgentSession, type TurnHooks } from "../agent-loop.js";
import { emitHerdrHook, setHerdrHookSession } from "../herdr-hooks.js";
import type { InputMode } from "../repl.js";
import { useSlashCommands } from "./hooks/useSlashCommands.js";
import { resolveSkillGesture } from "../commands.js";
import type { AgentSpawner } from "../multi/spawner.js";
import { decodeDiffPayload, DIFF_MARKER, renderInlineDiff } from "../multi/diff-renderer.js";
import { formatToolInput } from "./tool-render.js";
import * as os from "os";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { loadInputMode, saveInputMode, savePermissionMode, loadTheme, saveTheme, loadInputHistory, saveInputHistory } from "../settings.js";
import { estimateMessageTokens } from "../context/token-counter.js";
import { READ_ONLY_TOOLS } from "../permissions/checker.js";
import type { ApprovalInfo } from "./components/ApprovalPanel.js";
import { nextPermissionMode } from "./ansi.js";
import { App, type AppState, type ActiveToolInfo, type CompletedMessage } from "./components/App.js";
import type { ToolCallProps } from "./components/ToolCall.js";
import type { AgentTab } from "./components/InputArea.js";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { persistFork } from "../session/persist.js";
import { getTheme, THEME_NAMES, type Theme } from "./themes.js";
import { getAvailableModels, type PickerResult } from "../multi/model-picker.js";
import { REASONING_LEVELS } from "../models.js";
import type { ModelPickerState } from "./components/ModelPicker.js";

const _require = createRequire(import.meta.url);
const AGENT_VERSION = (_require("../../package.json") as { version: string }).version;

export async function startInkTui(config: AgentConfig, spawner?: AgentSpawner): Promise<AgentSession> {
  const contextLimit = config.provider.contextWindow ?? 200_000;
  const session = createSession(contextLimit, { log: config.sessionLog });
  const startTime = Date.now();

  let inputMode: InputMode = loadInputMode();
  let pendingInput: string | null = null;
  const steerQueueBuf: string[] = [];
  const inputHistory: string[] = loadInputHistory();
  let running = false;
  let verbose = false;
  let theme: Theme = getTheme(loadTheme());
  let msgCounter = 0;
  // Autopilot (full-auto) requires --yolo flag to be cycleable via Shift+Tab
  const yoloEnabled = config.registry.permissionConfig.mode === "full-auto";

  // Permission prompt queue — multiple tool calls may need permission concurrently
  interface PermissionEntry {
    resolve: (allowed: boolean) => void;
    toolName: string;
    input: Record<string, unknown>;
    info: Omit<ApprovalInfo, "queueDepth">;
    timer?: ReturnType<typeof setTimeout>;
    addAllow: (t: string, i: Record<string, unknown>, s: "once" | "session" | "tool") => void;
  }
  const permissionQueue: PermissionEntry[] = [];
  let approvalInfo: ApprovalInfo | null = null;

  const PERMISSION_TIMEOUT_MS = (() => {
    const raw = Number(process.env.PHREN_PERMISSION_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 600_000;
  })();

  const READ_TOOLS = READ_ONLY_TOOLS;

  function capLines(text: string, max: number): string {
    const lines = text.split("\n");
    return lines.length > max ? lines.slice(0, max).join("\n") + "\n\u2026" : text;
  }

  function previewDiff(toolName: string, input: Record<string, unknown>): string | undefined {
    const filePath = input.path;
    if (typeof filePath !== "string" || !filePath) return undefined;
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    let oldContent = "";
    try {
      const stat = fs.statSync(abs);
      if (stat.size > 300_000) return "(file too large to preview)";
      oldContent = fs.readFileSync(abs, "utf-8");
    } catch { oldContent = ""; }
    let newContent: string | undefined;
    if (toolName === "write_file") {
      newContent = (input.content as string) ?? "";
    } else if (toolName === "edit_file") {
      const oldString = (input.old_string as string) ?? "";
      const newString = (input.new_string as string) ?? "";
      if (!oldString) return undefined;
      if (input.replace_all === true) newContent = oldContent.split(oldString).join(newString);
      else {
        const idx = oldContent.indexOf(oldString);
        if (idx < 0) return "(old_string not found in the current file)";
        newContent = oldContent.slice(0, idx) + newString + oldContent.slice(idx + oldString.length);
      }
    }
    if (newContent === undefined) return undefined;
    if (oldContent.split("\n").length > 3_000 || newContent.split("\n").length > 3_000) return "(diff too large to preview)";
    try {
      return capLines(renderInlineDiff(oldContent, newContent, abs, theme.diff), 24);
    } catch { return undefined; }
  }

  function describeApproval(toolName: string, input: Record<string, unknown>, reason: string): Omit<ApprovalInfo, "queueDepth"> {
    const risk: ApprovalInfo["risk"] = toolName === "shell" ? "dangerous" : READ_TOOLS.has(toolName) ? "read" : "write";
    if (toolName === "shell") {
      const command = String(input.command ?? "");
      const first = command.split("\n")[0].slice(0, 200);
      const detail = command.length > 200 || command.includes("\n") ? capLines(command, 20) : undefined;
      return { toolName, risk, reason, summary: first, detail };
    }
    if (toolName === "write_file" || toolName === "edit_file") {
      const target = String(input.path ?? "");
      return { toolName, risk, reason, summary: `${toolName === "write_file" ? "Write" : "Edit"} ${target}`, diff: previewDiff(toolName, input) };
    }
    const json = JSON.stringify(input, null, 2);
    return { toolName, risk, reason, summary: toolName, detail: json && json !== "{}" ? capLines(json, 20) : undefined };
  }

  function refreshApproval() {
    for (const entry of permissionQueue) {
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    }
    const front = permissionQueue[0];
    if (front) {
      front.timer = setTimeout(() => {
        const idx = permissionQueue.indexOf(front);
        if (idx < 0) return;
        permissionQueue.splice(idx, 1);
        completedMessages.push({ id: nextId(), kind: "status", text: `\x1b[31m\u2717 ${front.toolName} (no answer, denied)\x1b[0m` });
        refreshApproval();
        front.resolve(false);
        update();
      }, PERMISSION_TIMEOUT_MS);
    }
    approvalInfo = front ? { ...front.info, queueDepth: permissionQueue.length - 1 } : null;
  }

  // Ink-compatible askUser: shows an approval panel, queues for y/n in input
  config.registry.askUser = async (toolName, input, reason) => {
    const { addAllow } = await import("../permissions/allowlist.js");
    const entry: PermissionEntry = { resolve: () => {}, toolName, input, info: describeApproval(toolName, input, reason), addAllow };
    const allowed = new Promise<boolean>((resolve) => { entry.resolve = resolve; });
    permissionQueue.push(entry);
    refreshApproval();
    update();
    return allowed;
  };

  // Mutable render state — updated then pushed to React via rerender()
  const completedMessages: CompletedMessage[] = [];
  let streamingText = "";
  let reasoningText = "";
  let thinking = false;
  let thinkStartTime = 0;
  let thinkElapsed: string | null = null;
  let currentToolCalls: ToolCallProps[] = [];
  let activeTool: ActiveToolInfo | null = null;
  let modelPicker: ModelPickerState | null = null;
  let modelPickerResolve: ((result: PickerResult | null) => void) | null = null;
  const toolHistory: ToolCallProps[] = [];
  let toolDetailIndex: number | null = null;
  let planReview: string | null = null;
  let planReviewResolve: ((result: { approved: boolean; feedback?: string }) => void) | null = null;

  function nextId(): string {
    return `msg-${++msgCounter}`;
  }

  function getAppState(): AppState {
    const tracker = config.costTracker;
    const cost = tracker
      ? tracker.metered
        ? `$${tracker.totalCost < 0.01 ? tracker.totalCost.toFixed(4) : tracker.totalCost.toFixed(2)}`
        : `${tracker.totalInputTokens + tracker.totalOutputTokens} tok`
      : "";
    return {
      provider: config.provider.name,
      project: config.phrenCtx?.project ?? null,
      turns: session.turns,
      cost,
      permMode: config.registry.permissionConfig.mode,
      agentCount: spawner?.listAgents().length ?? 0,
      version: AGENT_VERSION,
      model: (config.provider as { model?: string }).model,
      contextWindow: contextLimit,
      contextTokens: currentContextTokens(),
      reasoningEffort: config.provider.reasoningEffort as string | undefined,
    };
  }

  let contextMemo = { count: -1, tokens: 0 };
  function currentContextTokens(): number {
    const count = session.messages.length;
    if (contextMemo.count !== count) {
      contextMemo = { count, tokens: estimateMessageTokens(session.messages) };
    }
    return contextMemo.tokens;
  }

  // Re-render the Ink app with current state
  let rerender: ((node: React.ReactElement) => void) | null = null;

  // Ink app instance — set after render(), used by closures for clear()
  let appInstance: { clear: () => void } | null = null;

  // Batched update for high-frequency events (streaming deltas)
  let updateScheduled = false;
  function scheduleUpdate() {
    if (updateScheduled) return;
    updateScheduled = true;
    queueMicrotask(() => {
      updateScheduled = false;
      update();
    });
  }

  function update() {
    if (!rerender) return;

    // Determine what to display based on selected view
    const agentConvo = selectedAgentId ? agentConvos.get(selectedAgentId) : null;
    // Prefix IDs so <Static> re-renders after agent tab switch
    const prefix = `v${viewSwitchCounter}-`;
    const rawMessages = agentConvo ? agentConvo.messages : completedMessages;
    const displayMessages = rawMessages.map((m) => ({ ...m, id: prefix + m.id }));

    const displayStreaming = agentConvo ? agentConvo.streamingText : streamingText;
    const displayToolCalls = agentConvo ? [...agentConvo.toolCalls] : [...currentToolCalls];
    const displayActiveTool = agentConvo ? agentConvo.activeTool : activeTool;
    const displayThinking = agentConvo ? false : thinking;
    const displayRunning = agentConvo ? (spawner?.getAgent(selectedAgentId!)?.status === "running" || false) : running;

    rerender(
      <App
        state={getAppState()}
        completedMessages={displayMessages}
        streamingText={displayStreaming}
        reasoningText={agentConvo ? "" : reasoningText}
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
        agents={agentTabs.length > 0 ? [{ id: "__main__", name: "phren", status: running ? "running" as const : "idle" as const, color: "magentaBright" }, ...agentTabs] : undefined}
        selectedAgentId={selectedAgentId ?? (agentTabs.length > 0 ? "__main__" : undefined)}
        onCancelAgent={handleCancelAgent}
        onSelectAgent={(id) => handleSelectAgent(id === "__main__" ? null : id)}
        approval={approvalInfo}
        modelPicker={modelPicker}
        onModelPickerMove={moveModelPicker}
        onModelPickerReasoning={adjustModelReasoning}
        onModelPickerSelect={selectModelPicker}
        onModelPickerCancel={() => closeModelPicker(null)}
        onInspectTool={openToolDetail}
        toolDetail={toolDetailIndex !== null ? { call: toolHistory[toolDetailIndex], index: toolDetailIndex, total: toolHistory.length } : null}
        onToolDetailMove={moveToolDetail}
        onToolDetailClose={closeToolDetail}
        planReview={planReview}
      />
    );
  }

  function openModelPicker(): Promise<PickerResult | null> {
    const providerName = config.provider.name;
    if (!providerName) return Promise.resolve(null);
    const currentModel = (config.provider as { model?: string }).model;
    const models = getAvailableModels(providerName, currentModel);
    if (models.length === 0) return Promise.resolve(null);
    let cursor = models.findIndex((m) => m.id === currentModel);
    if (cursor < 0) cursor = 0;
    const reasoning = models.map((m) => m.id === currentModel ? (config.provider.reasoningEffort ?? m.reasoning) : m.reasoning);
    modelPicker = { models, cursor, reasoning };
    update();
    return new Promise((resolve) => { modelPickerResolve = resolve; });
  }

  function closeModelPicker(result: PickerResult | null) {
    modelPicker = null;
    const resolve = modelPickerResolve;
    modelPickerResolve = null;
    update();
    resolve?.(result);
  }

  function moveModelPicker(delta: number) {
    if (!modelPicker) return;
    const count = modelPicker.models.length;
    modelPicker = { ...modelPicker, cursor: (modelPicker.cursor + delta + count) % count };
    update();
  }

  function adjustModelReasoning(delta: number) {
    if (!modelPicker) return;
    const model = modelPicker.models[modelPicker.cursor];
    if (model.reasoningRange.length === 0) return;
    const current = modelPicker.reasoning[modelPicker.cursor];
    const index = current ? REASONING_LEVELS.indexOf(current) : -1;
    const rangeIndices = model.reasoningRange.map((level) => REASONING_LEVELS.indexOf(level!));
    const candidate = delta > 0
      ? rangeIndices.find((ri) => ri > index)
      : [...rangeIndices].reverse().find((ri) => ri < index);
    if (candidate === undefined) return;
    const reasoning = [...modelPicker.reasoning];
    reasoning[modelPicker.cursor] = REASONING_LEVELS[candidate];
    modelPicker = { ...modelPicker, reasoning };
    update();
  }

  function selectModelPicker() {
    if (!modelPicker) return;
    const model = modelPicker.models[modelPicker.cursor];
    const result: PickerResult = { model: model.id, reasoning: modelPicker.reasoning[modelPicker.cursor] };
    closeModelPicker(result);
  }

  function openToolDetail() {
    if (toolHistory.length === 0) return;
    toolDetailIndex = toolHistory.length - 1;
    update();
  }

  function moveToolDetail(delta: number) {
    if (toolDetailIndex === null) return;
    toolDetailIndex = (toolDetailIndex + delta + toolHistory.length) % toolHistory.length;
    update();
  }

  function closeToolDetail() {
    toolDetailIndex = null;
    update();
  }

  function handlePermissionCycle() {
    const next = nextPermissionMode(config.registry.permissionConfig.mode, yoloEnabled);
    config.registry.setPermissions({ ...config.registry.permissionConfig, mode: next });
    config.plan = next === "plan";
    savePermissionMode(next);
    update();
  }

  let resolveSession: ((session: AgentSession) => void) | null = null;

  function handleExit() {
    if (resolveSession) resolveSession(session);
  }

  let turnAbort: AbortController | null = null;
  function handleCancelTurn() {
    if (turnAbort) {
      turnAbort.abort();
      turnAbort = null;
    }
    pendingInput = null;
    steerQueueBuf.length = 0;
    for (const entry of permissionQueue.splice(0)) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(false);
    }
    if (planReviewResolve) {
      const resolve = planReviewResolve;
      planReview = null;
      planReviewResolve = null;
      resolve({ approved: false });
    }
    refreshApproval();
    update();
  }

  // Slash command handler — captures stderr and displays as status messages
  const slashCommands = useSlashCommands({
    commandContext: {
      session,
      contextLimit,
      undoStack: [],
      costTracker: config.costTracker,
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
      forkSession: () => {
        if (!config.phrenCtx?.phrenPath || !config.sessionId) return { ok: false, message: "Fork needs a phren store." };
        try {
          const childId = randomUUID();
          const child = persistFork(config.phrenCtx.phrenPath, session.log, childId);
          session.log = child;
          config.sessionId = childId;
          setHerdrHookSession(childId);
          return { ok: true, sessionId: childId, message: `Forked to ${childId.slice(0, 8)}` };
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : String(err) };
        }
      },
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
      pickModel: openModelPicker,
    },
    onOutput: (text) => {
      completedMessages.push({ id: nextId(), kind: "status", text });
    },
  });

  function handleSubmit(input: string) {
    let line = input.trim();
    if (!line) return;

    // Plan review active — y approves, n aborts, anything else is feedback
    if (planReview !== null) {
      const key = line.toLowerCase();
      const resolve = planReviewResolve;
      planReview = null;
      planReviewResolve = null;
      if (key === "y" || key === "yes") {
        completedMessages.push({ id: nextId(), kind: "status", text: "\x1b[32m\u2713 plan approved\x1b[0m" });
        update();
        resolve?.({ approved: true });
      } else if (key === "n" || key === "no") {
        completedMessages.push({ id: nextId(), kind: "status", text: "\x1b[31m\u2717 plan rejected\x1b[0m" });
        update();
        resolve?.({ approved: false });
      } else {
        completedMessages.push({ id: nextId(), kind: "status", text: `\x1b[33m\u21ba revising: "${line}"\x1b[0m` });
        update();
        resolve?.({ approved: false, feedback: line });
      }
      return;
    }

    // Permission prompt active — intercept y/n/a/s (process next in queue)
    if (permissionQueue.length > 0) {
      const entry = permissionQueue.shift()!;
      if (entry.timer) clearTimeout(entry.timer);
      const key = line.toLowerCase();
      if (key === "y" || key === "yes") {
        completedMessages.push({ id: nextId(), kind: "status", text: `\x1b[32m\u2713 ${entry.toolName}\x1b[0m` });
        entry.resolve(true);
      } else if (key === "a") {
        completedMessages.push({ id: nextId(), kind: "status", text: `\x1b[32m\u2713 ${entry.toolName} (always)\x1b[0m` });
        entry.addAllow(entry.toolName, entry.input, "tool");
        entry.resolve(true);
      } else if (key === "s") {
        completedMessages.push({ id: nextId(), kind: "status", text: `\x1b[32m\u2713 ${entry.toolName} (session)\x1b[0m` });
        entry.addAllow(entry.toolName, entry.input, "session");
        entry.resolve(true);
      } else {
        // Deny with feedback: if the input is more than a single n/no, treat it as a redirect message
        const isSilentDeny = key === "n" || key === "no";
        if (!isSilentDeny && line.length > 1) {
          completedMessages.push({ id: nextId(), kind: "status", text: `\x1b[31m\u2717 ${entry.toolName} \x1b[2m\u2014 redirecting: "${line}"\x1b[0m` });
          steerQueueBuf.push(line);
        } else {
          completedMessages.push({ id: nextId(), kind: "status", text: `\x1b[31m\u2717 ${entry.toolName}\x1b[0m` });
        }
        entry.resolve(false);
      }
      refreshApproval();
      update();
      return;
    }

    // Track input history (skip duplicates of the last entry)
    if (inputHistory.length === 0 || inputHistory[inputHistory.length - 1] !== line) {
      inputHistory.push(line);
      saveInputHistory(inputHistory);
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

    // /agent <name> — switch to an agent's conversation, /agent (no args) — back to main
    if (line.startsWith("/agent")) {
      const arg = line.slice(6).trim();
      if (!arg || arg === "main" || arg === "phren") {
        handleSelectAgent(null);
        return;
      }
      // /agents — list all agents
      if (arg === "s") {
        const agents = spawner?.listAgents() ?? [];
        if (agents.length === 0) {
          completedMessages.push({ id: nextId(), kind: "status", text: "No agents spawned." });
        } else {
          const lines = agents.map((a) => `  ${a.displayName || a.id} [${a.status}]`).join("\n");
          completedMessages.push({ id: nextId(), kind: "status", text: `Agents:\n${lines}` });
        }
        update();
        return;
      }
      // Find agent by name or id
      const agents = spawner?.listAgents() ?? [];
      const match = agents.find((a) => a.displayName === arg || a.id === arg || a.displayName?.includes(arg));
      if (match) {
        handleSelectAgent(match.id);
      } else {
        completedMessages.push({ id: nextId(), kind: "status", text: `Agent "${arg}" not found. Use /agents to list.` });
        update();
      }
      return;
    }

    if (line === "/verbose") {
      verbose = !verbose;
      completedMessages.push({ id: nextId(), kind: "status", text: `Verbose: ${verbose ? "on" : "off"}` });
      update();
      return;
    }

    if (line === "/theme") {
      const idx = THEME_NAMES.indexOf(theme.name);
      const next = THEME_NAMES[(idx + 1) % THEME_NAMES.length];
      theme = getTheme(next);
      saveTheme(theme.name);
      completedMessages.push({ id: nextId(), kind: "status", text: `Theme: ${theme.name} (${THEME_NAMES.join(", ")})` });
      update();
      return;
    }

    // /clear — also wipe Ink completed messages and clear screen
    if (line === "/clear") {
      completedMessages.length = 0;
      if (appInstance) appInstance.clear();
      else process.stdout.write("\x1b[2J\x1b[H");
      slashCommands.tryHandleCommand(line);
      update();
      return;
    }

    // Slash commands — capture stderr output and display as status message
    if (line.startsWith("/")) {
      // /skill-name gesture: rewrite into a run_skill task and fall through
      const skillTask = resolveSkillGesture(line, config.phrenCtx);
      if (skillTask) {
        completedMessages.push({ id: nextId(), kind: "status", text: `↳ running skill via ${line.split(/\s+/)[0]}` });
        line = skillTask;
      } else if (slashCommands.tryHandleCommand(line)) {
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

    // Normal user message — defer static push to next tick so dynamic area is clean
    update(); // flush clean state first (empty input)
    setImmediate(() => {
      completedMessages.push({ id: nextId(), kind: "user", text: line });
      update();
      runAgentTurn(line);
    });
  }

  // TurnHooks bridge — updates mutable state, calls update()
  const tuiHooks: TurnHooks = {
    onTextDelta: (text) => {
      thinking = false;
      streamingText += text;
      scheduleUpdate();
    },
    onReasoningDelta: (text) => {
      reasoningText += text;
      scheduleUpdate();
    },
    onTextDone: () => {
      // streaming complete — finalized in runAgentTurn
    },
    onTextBlock: (text) => {
      thinking = false;
      streamingText += text;
      scheduleUpdate();
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
      const diffRendered = diffData ? renderInlineDiff(diffData.oldContent, diffData.newContent, diffData.filePath, theme.diff) : undefined;
      const call = { name, input, output: cleanOutput, isError, durationMs: dur, diffRendered };
      currentToolCalls.push(call);
      toolHistory.push(call);
      update();
    },
    // Plan mode review happens in the TUI: show the plan and let the person
    // approve, abort, or type feedback to revise before tools re-enable.
    onPlanApproval: () => new Promise((resolve) => {
      planReview = streamingText.trim() || "(empty plan)";
      planReviewResolve = resolve;
      update();
    }),
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

  // Phren's past-tense verbs for turn summaries
  const PAST_VERBS = ["Recalled", "Reasoned", "Connected", "Synthesized", "Reflected", "Distilled", "Threaded", "Mapped"];

  async function runAgentTurn(userInput: string) {
    running = true;
    thinking = true;
    turnAbort = new AbortController();
    thinkStartTime = Date.now();
    thinkElapsed = null;
    streamingText = "";
    reasoningText = "";
    currentToolCalls = [];
    activeTool = null;
    const pastVerb = PAST_VERBS[Math.floor(Math.random() * PAST_VERBS.length)];
    update();

    emitHerdrHook("UserPromptSubmit");
    try {
      await runTurn(userInput, session, config, { ...tuiHooks, signal: turnAbort?.signal });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(msg)) streamingText += `\nError: ${msg}`;
    } finally {
      emitHerdrHook("Stop");
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
    reasoningText = "";
    currentToolCalls = [];
    activeTool = null;
    running = false;
    thinkElapsed = `${pastVerb} for ${elapsed}s`;
    process.stdout.write("\x07"); // terminal bell on completion
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
  // TeamAgents: each gets their OWN conversation (separate from main stream).
  // Switch between them with /agent <name>. Clear screen + re-render on switch.
  let selectedAgentId: string | null = null; // null = main orchestrator
  let agentTabs: AgentTab[] = [];
  const TAB_COLORS = ["cyan", "magenta", "yellow", "green", "blue", "red", "white", "cyanBright"];

  // Per-agent conversation state — each agent has its own message history
  interface AgentConvo {
    messages: CompletedMessage[];
    streamingText: string;
    toolCalls: ToolCallProps[];
    activeTool: ActiveToolInfo | null;
  }
  const agentConvos = new Map<string, AgentConvo>();

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
    agentTabs = spawner.listAgents().map((a, i) => ({
      id: a.id,
      name: a.displayName || a.task.slice(0, 20),
      status: a.status as AgentTab["status"],
      color: TAB_COLORS[i % TAB_COLORS.length],
    }));
  }

  // Switch views: clear screen so <Static> re-renders with fresh IDs
  let viewSwitchCounter = 0;
  function handleSelectAgent(agentId: string | null) {
    if (agentId === selectedAgentId) return;
    selectedAgentId = agentId;
    viewSwitchCounter++;
    if (appInstance) appInstance.clear();
    else process.stdout.write("\x1b[2J\x1b[H");
    update();
  }

  function handleCancelAgent() {
    if (selectedAgentId && selectedAgentId !== "__main__" && spawner) {
      const agent = spawner.getAgent(selectedAgentId);
      if (agent && (agent.status === "running" || agent.status === "starting")) {
        spawner.cancel(selectedAgentId);
        const convo = getOrCreateConvo(selectedAgentId);
        convo.messages.push({ id: nextId(), kind: "status", text: "Cancelled" });
        update();
        return;
      }
    }
    handleCancelTurn();
  }

  // Wire spawner events — each agent's output goes to its OWN conversation
  if (spawner) {
    spawner.on("text_delta", (agentId: string, text: string) => {
      const convo = getOrCreateConvo(agentId);
      convo.streamingText += text;
      // Only update if this agent is currently selected
      if (selectedAgentId === agentId) update();
    });

    spawner.on("text_block", (agentId: string, text: string) => {
      const convo = getOrCreateConvo(agentId);
      convo.streamingText += text;
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
      const diffData = (toolName === "edit_file" || toolName === "write_file") ? decodeDiffPayload(output) : null;
      const cleanOutput = diffData ? output.slice(0, output.indexOf(DIFF_MARKER)) : output;
      const diffRendered = diffData ? renderInlineDiff(diffData.oldContent, diffData.newContent, diffData.filePath, theme.diff) : undefined;
      const call = { name: toolName, input, output: cleanOutput, isError, durationMs, diffRendered };
      convo.toolCalls.push(call);
      toolHistory.push(call);
      rebuildAgentTabs();
      if (selectedAgentId === agentId) update();
    });

    spawner.on("done", (agentId: string, result: { finalText: string; turns: number; toolCalls: number; totalCost?: string }) => {
      const convo = getOrCreateConvo(agentId);
      if (convo.streamingText || convo.toolCalls.length > 0) {
        convo.messages.push({
          id: nextId(),
          kind: "assistant",
          text: convo.streamingText || result.finalText,
          toolCalls: convo.toolCalls.length > 0 ? [...convo.toolCalls] : undefined,
        });
      } else if (result.finalText) {
        convo.messages.push({ id: nextId(), kind: "assistant", text: result.finalText });
      }
      convo.streamingText = "";
      convo.toolCalls = [];
      convo.activeTool = null;
      rebuildAgentTabs();
      // Notify main stream that an agent completed
      completedMessages.push({
        id: nextId(),
        kind: "status",
        text: `\x1b[2m${spawner!.getAgent(agentId)?.displayName || agentId} completed (${result.turns} turns, ${result.toolCalls} tools)\x1b[0m`,
      });
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
      convo.messages.push({ id: nextId(), kind: "status", text: `idle (${reason})` });
      rebuildAgentTabs();
      update();
    });

    spawner.on("status", (agentId: string, message: string) => {
      const convo = getOrCreateConvo(agentId);
      convo.messages.push({ id: nextId(), kind: "status", text: message });
      if (selectedAgentId === agentId) update();
    });

    spawner.on("message", (from: string, to: string, content: string) => {
      // Show DM notification in main stream
      const preview = content.length > 80 ? content.slice(0, 80) + "..." : content;
      completedMessages.push({
        id: nextId(),
        kind: "status",
        text: `\x1b[2m${from} → ${to}: ${preview}\x1b[0m`,
      });
      update();
    });

    spawner.on("exit", () => {
      rebuildAgentTabs();
      update();
    });
  }

  // Set terminal title
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
      onCancelAgent={handleCancelAgent}
      onSelectAgent={handleSelectAgent}
      approval={null}
      modelPicker={null}
      toolDetail={null}
      planReview={null}
    />,
    { exitOnCtrlC: false },
  );
  rerender = app.rerender;
  appInstance = app;

  const done = new Promise<AgentSession>((r) => { resolveSession = r; });

  app.waitUntilExit().then(() => {
    if (resolveSession) resolveSession(session);
  });

  return done;
}
