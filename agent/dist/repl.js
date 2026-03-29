/** Interactive REPL for the phren agent with steering/queue input modes. */
import * as readline from "node:readline/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createSession, runTurn } from "./agent-loop.js";
import { handleCommand } from "./commands.js";
const HISTORY_DIR = path.join(os.homedir(), ".phren-agent");
const HISTORY_FILE = path.join(HISTORY_DIR, "repl-history.txt");
const SETTINGS_FILE = path.join(HISTORY_DIR, "settings.json");
const MAX_HISTORY = 500;
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
function loadHistory() {
    try {
        const data = fs.readFileSync(HISTORY_FILE, "utf-8");
        return data.split("\n").filter(Boolean).slice(-MAX_HISTORY);
    }
    catch {
        return [];
    }
}
function saveHistory(lines) {
    try {
        fs.mkdirSync(HISTORY_DIR, { recursive: true });
        fs.writeFileSync(HISTORY_FILE, lines.slice(-MAX_HISTORY).join("\n") + "\n");
    }
    catch { /* ignore */ }
}
function loadInputMode() {
    try {
        const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
        if (data.inputMode === "queue")
            return "queue";
    }
    catch { /* ignore */ }
    return "steering";
}
function saveInputMode(mode) {
    try {
        fs.mkdirSync(HISTORY_DIR, { recursive: true });
        let data = {};
        try {
            data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
        }
        catch { /* fresh */ }
        data.inputMode = mode;
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2) + "\n");
    }
    catch { /* ignore */ }
}
export async function startRepl(config) {
    const contextLimit = config.provider.contextWindow ?? 200_000;
    const session = createSession(contextLimit);
    const history = loadHistory();
    let inputMode = loadInputMode();
    // Queued/steering input buffer — collects input typed while agent is running
    let pendingInput = null;
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
    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) {
            rl.prompt();
            continue;
        }
        allHistory.push(trimmed);
        // Handle slash commands
        if (trimmed === "/mode") {
            const newMode = inputMode === "steering" ? "queue" : "steering";
            inputMode = newMode;
            saveInputMode(newMode);
            process.stderr.write(`${YELLOW}Input mode: ${newMode}${RESET}\n`);
            rl.prompt();
            continue;
        }
        if (handleCommand(trimmed, { session, contextLimit, undoStack: [] })) {
            rl.prompt();
            continue;
        }
        // If agent is already running, buffer the input
        if (agentRunning) {
            pendingInput = trimmed;
            if (inputMode === "steering") {
                process.stderr.write(`${DIM}↳ steering: "${trimmed.slice(0, 60)}${trimmed.length > 60 ? "..." : ""}" will be injected${RESET}\n`);
            }
            else {
                process.stderr.write(`${DIM}↳ queued: "${trimmed.slice(0, 60)}${trimmed.length > 60 ? "..." : ""}"${RESET}\n`);
            }
            continue;
        }
        agentRunning = true;
        try {
            await runTurn(trimmed, session, config);
        }
        catch (err) {
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
                if (queued === "/mode") {
                    inputMode = inputMode === "steering" ? "queue" : "steering";
                    saveInputMode(inputMode);
                    process.stderr.write(`${YELLOW}Input mode: ${inputMode}${RESET}\n`);
                }
                else {
                    handleCommand(queued, { session, contextLimit, undoStack: [] });
                }
                break;
            }
            agentRunning = true;
            try {
                if (inputMode === "steering") {
                    // Steering: inject as a correction/redirect
                    process.stderr.write(`${YELLOW}↳ steering with: ${queued.slice(0, 80)}${RESET}\n`);
                }
                await runTurn(queued, session, config);
            }
            catch (err) {
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
