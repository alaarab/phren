/** Interactive REPL for the phren agent with steering/queue input modes. */

import * as readline from "node:readline/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentConfig } from "./agent-loop.js";
import { createSession, runTurn, type AgentSession } from "./agent-loop.js";
import { handleCommand } from "./commands.js";
import { resolveProvider } from "./providers/resolve.js";
import { loadInputMode } from "./settings.js";

const HISTORY_DIR = path.join(os.homedir(), ".phren-agent");
const HISTORY_FILE = path.join(HISTORY_DIR, "repl-history.txt");
const MAX_HISTORY = 500;

const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

export type InputMode = "steering" | "queue";

function loadHistory(): string[] {
  try {
    const data = fs.readFileSync(HISTORY_FILE, "utf-8");
    return data.split("\n").filter(Boolean).slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

function saveHistory(lines: string[]): void {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, lines.slice(-MAX_HISTORY).join("\n") + "\n");
  } catch { /* ignore */ }
}

export async function startRepl(config: AgentConfig): Promise<AgentSession> {
  const contextLimit = config.provider.contextWindow ?? 200_000;
  const session = createSession(contextLimit);
  const history = loadHistory();
  let inputMode = loadInputMode();

  // Queued/steering input buffer — collects input typed while agent is running
  let pendingInput: string | null = null;
  let agentRunning = false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: `${CYAN}phren>${RESET} `,
    terminal: process.stdin.isTTY ?? false,
    history,
    historySize: MAX_HISTORY,
  });

  const modeLabel = inputMode === "steering" ? "steering" : "queue";
  process.stderr.write(`${DIM}phren-agent interactive mode (${modeLabel}). Type /help for commands, Ctrl+D to exit.${RESET}\n`);
  rl.prompt();

  const allHistory = [...history];
  const buildCommandContext = () => ({
    session,
    contextLimit,
    undoStack: [],
    phrenCtx: config.phrenCtx,
    providerName: config.provider.name,
    currentModel: (config.provider as { model?: string }).model,
    currentReasoning: config.provider.reasoningEffort ?? null,
    provider: config.provider,
    systemPrompt: config.systemPrompt,
    registry: config.registry,
    onModelChange: (result: import("./multi/model-picker.js").PickerResult) => {
      config.provider = resolveProvider(config.provider.name, result.model, undefined, result.reasoning ?? undefined);
    },
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }

    allHistory.push(trimmed);

    // Handle slash commands
    if (handleCommand(trimmed, buildCommandContext())) {
      rl.prompt();
      continue;
    }

    // If agent is already running, buffer the input
    if (agentRunning) {
      pendingInput = trimmed;
      if (inputMode === "steering") {
        process.stderr.write(`${DIM}↳ steering: "${trimmed.slice(0, 60)}${trimmed.length > 60 ? "..." : ""}" will be injected${RESET}\n`);
      } else {
        process.stderr.write(`${DIM}↳ queued: "${trimmed.slice(0, 60)}${trimmed.length > 60 ? "..." : ""}"${RESET}\n`);
      }
      continue;
    }

    agentRunning = true;

    try {
      await runTurn(trimmed, session, config);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${RED}Error: ${msg}${RESET}\n`);
    }

    agentRunning = false;

    // Process any input that came in while the agent was working
    while (pendingInput !== null) {
      const queued = pendingInput;
      pendingInput = null;
      allHistory.push(queued);

      if (queued.startsWith("/")) {
        handleCommand(queued, buildCommandContext());
        break;
      }

      agentRunning = true;
      try {
        if (inputMode === "steering") {
          // Steering: inject as a correction/redirect
          process.stderr.write(`${YELLOW}↳ steering with: ${queued.slice(0, 80)}${RESET}\n`);
        }
        await runTurn(queued, session, config);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${RED}Error: ${msg}${RESET}\n`);
      }
      agentRunning = false;
    }

    rl.prompt();
  }

  // EOF (Ctrl+D) — clean exit
  saveHistory(allHistory);
  process.stderr.write(`\n${DIM}Session ended. ${session.turns} turns, ${session.toolCalls} tool calls.${RESET}\n`);
  return session;
}
