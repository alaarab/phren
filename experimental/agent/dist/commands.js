// Sub-module handlers
import { helpCommand, turnsCommand, clearCommand, cwdCommand, filesCommand, costCommand, planCommand, undoCommand, contextCommand } from "./commands/info.js";
import { sessionCommand, historyCommand, compactCommand, diffCommand, gitCommand, resumeCommand } from "./commands/session.js";
import { memCommand, askCommand } from "./commands/memory.js";
import { modelCommand, providerCommand, presetCommand } from "./commands/model.js";
import { configCommand } from "./commands/config.js";
import { loadInputMode, saveInputMode, savePermissionMode } from "./settings.js";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
export function createCommandContext(session, contextLimit) {
    return {
        session,
        contextLimit,
        undoStack: [],
    };
}
/**
 * All slash commands available in the agent, including TUI-only commands.
 * Used for tab completion in the TUI.
 */
export const COMMAND_NAMES = [
    "/help", "/turns", "/clear", "/cwd", "/files", "/cost", "/plan", "/undo",
    "/context", "/model", "/provider", "/preset", "/session", "/history",
    "/compact", "/diff", "/git", "/mem", "/ask", "/resume", "/config", "/spawn", "/agents",
    "/mode", "/permissions", "/verbose", "/theme", "/agent",
    "/exit", "/quit", "/q",
];
/**
 * Try to handle a slash command. Returns true if the input was a command.
 * Returns a Promise<boolean> for async commands like /ask.
 */
export function handleCommand(input, ctx) {
    const parts = input.trim().split(/\s+/);
    const name = parts[0];
    switch (name) {
        case "/help": return helpCommand(parts, ctx);
        case "/turns": return turnsCommand(parts, ctx);
        case "/clear": return clearCommand(parts, ctx);
        case "/cwd": return cwdCommand(parts, ctx);
        case "/files": return filesCommand(parts, ctx);
        case "/cost": return costCommand(parts, ctx);
        case "/plan": return planCommand(parts, ctx);
        case "/undo": return undoCommand(parts, ctx);
        case "/context": return contextCommand(parts, ctx);
        case "/model": return modelCommand(parts, ctx);
        case "/provider": return providerCommand(parts, ctx);
        case "/preset": return presetCommand(parts, ctx);
        case "/session": return sessionCommand(parts, ctx);
        case "/history": return historyCommand(parts, ctx);
        case "/compact": return compactCommand(parts, ctx);
        case "/diff": return diffCommand(parts, ctx);
        case "/git": return gitCommand(parts, ctx);
        case "/mem": return memCommand(parts, ctx);
        case "/ask": return askCommand(parts, ctx);
        case "/resume": return resumeCommand(parts, ctx);
        case "/config": return configCommand(parts, ctx);
        case "/mode": {
            const current = loadInputMode();
            const newMode = current === "steering" ? "queue" : "steering";
            saveInputMode(newMode);
            process.stderr.write(`${DIM}Input mode: ${newMode}${RESET}\n`);
            return true;
        }
        case "/permissions": {
            const VALID_MODES = ["suggest", "auto-confirm", "full-auto"];
            const arg = parts[1];
            if (!ctx.registry || !arg || !VALID_MODES.includes(arg)) {
                const current = ctx.registry?.permissionConfig.mode ?? "unknown";
                process.stderr.write(`${DIM}Permission mode: ${current}${RESET}\n`);
                process.stderr.write(`${DIM}Usage: /permissions <suggest|auto-confirm|full-auto>${RESET}\n`);
            }
            else {
                ctx.registry.setPermissions({ ...ctx.registry.permissionConfig, mode: arg });
                savePermissionMode(arg);
                process.stderr.write(`${DIM}Permission mode: ${arg}${RESET}\n`);
            }
            return true;
        }
        case "/spawn": {
            if (!ctx.spawner) {
                process.stderr.write(`${DIM}Spawner not available. Start with --multi or --team to enable.${RESET}\n`);
                return true;
            }
            const spawnName = parts[1];
            const spawnTask = parts.slice(2).join(" ");
            if (!spawnName || !spawnTask) {
                process.stderr.write(`${DIM}Usage: /spawn <name> <task>${RESET}\n`);
                return true;
            }
            const agentId = ctx.spawner.spawn({ task: spawnTask, cwd: process.cwd() });
            process.stderr.write(`${DIM}Spawned agent "${spawnName}" (${agentId}): ${spawnTask}${RESET}\n`);
            return true;
        }
        case "/agents": {
            if (!ctx.spawner) {
                process.stderr.write(`${DIM}No spawner available. Start with --multi or --team to enable.${RESET}\n`);
                return true;
            }
            const agents = ctx.spawner.listAgents();
            if (agents.length === 0) {
                process.stderr.write(`${DIM}No agents running.${RESET}\n`);
            }
            else {
                const lines = agents.map((a) => {
                    const elapsed = a.finishedAt
                        ? `${((a.finishedAt - a.startedAt) / 1000).toFixed(1)}s`
                        : `${((Date.now() - a.startedAt) / 1000).toFixed(0)}s`;
                    return `  ${a.id} [${a.status}] ${elapsed} — ${a.task.slice(0, 60)}`;
                });
                process.stderr.write(`${DIM}Agents (${agents.length}):\n${lines.join("\n")}${RESET}\n`);
            }
            return true;
        }
        case "/exit":
        case "/quit":
        case "/q":
            process.exit(0);
        default:
            if (input.startsWith("/")) {
                process.stderr.write(`${DIM}Unknown command: ${name}. Type /help for commands.${RESET}\n`);
                return true;
            }
            return false;
    }
}
