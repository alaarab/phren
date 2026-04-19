import { appendToPane, flushPartial } from "./pane.js";
import { getAgentStyle } from "./agent-colors.js";
import { decodeDiffPayload, renderInlineDiff, DIFF_MARKER } from "./diff-renderer.js";
import { s, formatToolStart, formatToolEnd } from "./multi-render.js";
export function wireSpawnerEvents(spawner, ctx) {
    spawner.on("text_delta", (agentId, text) => {
        const pane = ctx.getOrCreatePane(agentId);
        appendToPane(pane, text);
        if (agentId === ctx.getSelectedId())
            ctx.render();
    });
    spawner.on("text_block", (agentId, text) => {
        const pane = ctx.getOrCreatePane(agentId);
        appendToPane(pane, text + "\n");
        if (agentId === ctx.getSelectedId())
            ctx.render();
    });
    spawner.on("tool_start", (agentId, toolName, input) => {
        const pane = ctx.getOrCreatePane(agentId);
        flushPartial(pane);
        appendToPane(pane, formatToolStart(toolName, input) + "\n");
        if (agentId === ctx.getSelectedId())
            ctx.render();
    });
    spawner.on("tool_end", (agentId, toolName, input, output, isError, durationMs) => {
        const pane = ctx.getOrCreatePane(agentId);
        flushPartial(pane);
        const diffData = (toolName === "edit_file" || toolName === "write_file") ? decodeDiffPayload(output) : null;
        const cleanOutput = diffData ? output.slice(0, output.indexOf(DIFF_MARKER)) : output;
        appendToPane(pane, formatToolEnd(toolName, input, cleanOutput, isError, durationMs) + "\n");
        if (diffData) {
            appendToPane(pane, renderInlineDiff(diffData.oldContent, diffData.newContent, diffData.filePath) + "\n");
        }
        if (agentId === ctx.getSelectedId())
            ctx.render();
    });
    spawner.on("status", (agentId, message) => {
        const pane = ctx.getOrCreatePane(agentId);
        appendToPane(pane, s.dim(message) + "\n");
        if (agentId === ctx.getSelectedId())
            ctx.render();
    });
    spawner.on("done", (agentId, result) => {
        const pane = ctx.getOrCreatePane(agentId);
        flushPartial(pane);
        const style = getAgentStyle(pane.index);
        appendToPane(pane, "\n" + style.color(`--- ${style.icon} Agent completed ---`) + "\n");
        appendToPane(pane, s.dim(`  Turns: ${result.turns}  Tool calls: ${result.toolCalls}${result.totalCost ? `  Cost: ${result.totalCost}` : ""}`) + "\n");
        ctx.render();
    });
    spawner.on("error", (agentId, error) => {
        const pane = ctx.getOrCreatePane(agentId);
        flushPartial(pane);
        const style = getAgentStyle(pane.index);
        appendToPane(pane, "\n" + style.color(`--- ${style.icon} Error: ${error} ---`) + "\n");
        ctx.render();
    });
    spawner.on("exit", (agentId, code) => {
        const pane = ctx.getOrCreatePane(agentId);
        if (code !== null && code !== 0) {
            appendToPane(pane, s.dim(`  Process exited with code ${code}`) + "\n");
        }
        ctx.render();
    });
    spawner.on("idle", (agentId, reason, dmSummaries) => {
        const pane = ctx.getOrCreatePane(agentId);
        const style = getAgentStyle(pane.index);
        appendToPane(pane, s.dim(`  ${style.icon} Agent idle (${reason})`) + "\n");
        if (dmSummaries && dmSummaries.length > 0) {
            appendToPane(pane, s.dim("  Messages received while running:") + "\n");
            for (const dm of dmSummaries) {
                appendToPane(pane, s.yellow(`    [${dm.from}] ${dm.content.slice(0, 100)}`) + "\n");
            }
        }
        ctx.render();
    });
    spawner.on("shutdown_approved", (agentId) => {
        const pane = ctx.getOrCreatePane(agentId);
        appendToPane(pane, s.dim("  Agent shut down gracefully.") + "\n");
        ctx.render();
    });
    spawner.on("message", (from, to, content) => {
        const senderPane = ctx.panes.get(from);
        if (senderPane) {
            flushPartial(senderPane);
            const toName = ctx.panes.get(to)?.name ?? to;
            appendToPane(senderPane, s.yellow(`[${senderPane.name} -> ${toName}] ${content}`) + "\n");
        }
        const recipientPane = ctx.panes.get(to);
        if (recipientPane) {
            flushPartial(recipientPane);
            const fromName = senderPane?.name ?? from;
            appendToPane(recipientPane, s.yellow(`[${fromName} -> ${recipientPane.name}] ${content}`) + "\n");
        }
        if (from === ctx.getSelectedId() || to === ctx.getSelectedId())
            ctx.render();
    });
}
