import { estimateMessageTokens } from "./context/token-counter.js";
import { pruneMessages } from "./context/pruner.js";
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
 * Try to handle a slash command. Returns true if the input was a command.
 */
export function handleCommand(input, ctx) {
    const parts = input.trim().split(/\s+/);
    const name = parts[0];
    switch (name) {
        case "/help":
            process.stderr.write(`${DIM}Commands:
  /help       Show this help
  /turns      Show turn and tool call counts
  /clear      Clear conversation history
  /cost       Show token usage and estimated cost
  /plan       Show conversation plan (tool calls so far)
  /undo       Undo last user message and response
  /history    Show conversation message count and token estimate
  /compact    Compact conversation to save context space
  /mode       Toggle input mode (steering ↔ queue)
  /exit       Exit the REPL${RESET}\n`);
            return true;
        case "/turns":
            process.stderr.write(`${DIM}Turns: ${ctx.session.turns}  Tool calls: ${ctx.session.toolCalls}  Messages: ${ctx.session.messages.length}${RESET}\n`);
            return true;
        case "/clear":
            ctx.session.messages.length = 0;
            ctx.session.turns = 0;
            ctx.session.toolCalls = 0;
            ctx.undoStack.length = 0;
            process.stderr.write(`${DIM}Conversation cleared.${RESET}\n`);
            return true;
        case "/cost": {
            const ct = ctx.costTracker;
            if (ct) {
                process.stderr.write(`${DIM}Tokens — input: ${ct.inputTokens}  output: ${ct.outputTokens}  est. cost: $${ct.totalCost.toFixed(4)}${RESET}\n`);
            }
            else {
                process.stderr.write(`${DIM}Cost tracking not available.${RESET}\n`);
            }
            return true;
        }
        case "/plan": {
            const tools = [];
            for (const msg of ctx.session.messages) {
                if (typeof msg.content !== "string") {
                    for (const block of msg.content) {
                        if (block.type === "tool_use") {
                            tools.push(block.name);
                        }
                    }
                }
            }
            if (tools.length === 0) {
                process.stderr.write(`${DIM}No tool calls yet.${RESET}\n`);
            }
            else {
                process.stderr.write(`${DIM}Tool calls (${tools.length}): ${tools.join(" → ")}${RESET}\n`);
            }
            return true;
        }
        case "/undo": {
            if (ctx.session.messages.length < 2) {
                process.stderr.write(`${DIM}Nothing to undo.${RESET}\n`);
                return true;
            }
            // Remove messages back to the previous user message
            let removed = 0;
            while (ctx.session.messages.length > 0) {
                const last = ctx.session.messages.pop();
                removed++;
                if (last?.role === "user" && typeof last.content === "string")
                    break;
            }
            process.stderr.write(`${DIM}Undid ${removed} messages.${RESET}\n`);
            return true;
        }
        case "/history": {
            const tokens = estimateMessageTokens(ctx.session.messages);
            const pct = ctx.contextLimit > 0 ? ((tokens / ctx.contextLimit) * 100).toFixed(1) : "?";
            process.stderr.write(`${DIM}Messages: ${ctx.session.messages.length}  Est. tokens: ${tokens}  Context: ${pct}%${RESET}\n`);
            return true;
        }
        case "/compact": {
            const before = ctx.session.messages.length;
            ctx.session.messages = pruneMessages(ctx.session.messages, { contextLimit: ctx.contextLimit, keepRecentTurns: 4 });
            const after = ctx.session.messages.length;
            process.stderr.write(`${DIM}Compacted: ${before} → ${after} messages.${RESET}\n`);
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
