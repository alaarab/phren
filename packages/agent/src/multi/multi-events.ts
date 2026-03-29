import type { AgentSpawner } from "./spawner.js";
import type { Pane } from "./pane.js";
import { appendToPane, flushPartial } from "./pane.js";
import { getAgentStyle } from "./agent-colors.js";
import { decodeDiffPayload, renderInlineDiff, DIFF_MARKER } from "./diff-renderer.js";
import { s, formatToolStart, formatToolEnd } from "./multi-render.js";

export interface EventContext {
  panes: Map<string, Pane>;
  getOrCreatePane: (agentId: string) => Pane;
  getSelectedId: () => string | null;
  render: () => void;
}

export function wireSpawnerEvents(spawner: AgentSpawner, ctx: EventContext): void {
  spawner.on("text_delta", (agentId: string, text: string) => {
    const pane = ctx.getOrCreatePane(agentId);
    appendToPane(pane, text);
    if (agentId === ctx.getSelectedId()) ctx.render();
  });

  spawner.on("text_block", (agentId: string, text: string) => {
    const pane = ctx.getOrCreatePane(agentId);
    appendToPane(pane, text + "\n");
    if (agentId === ctx.getSelectedId()) ctx.render();
  });

  spawner.on("tool_start", (agentId: string, toolName: string, input: Record<string, unknown>) => {
    const pane = ctx.getOrCreatePane(agentId);
    flushPartial(pane);
    appendToPane(pane, formatToolStart(toolName, input) + "\n");
    if (agentId === ctx.getSelectedId()) ctx.render();
  });

  spawner.on("tool_end", (agentId: string, toolName: string, input: Record<string, unknown>, output: string, isError: boolean, durationMs: number) => {
    const pane = ctx.getOrCreatePane(agentId);
    flushPartial(pane);
    const diffData = (toolName === "edit_file" || toolName === "write_file") ? decodeDiffPayload(output) : null;
    const cleanOutput = diffData ? output.slice(0, output.indexOf(DIFF_MARKER)) : output;
    appendToPane(pane, formatToolEnd(toolName, input, cleanOutput, isError, durationMs) + "\n");
    if (diffData) {
      appendToPane(pane, renderInlineDiff(diffData.oldContent, diffData.newContent, diffData.filePath) + "\n");
    }
    if (agentId === ctx.getSelectedId()) ctx.render();
  });

  spawner.on("status", (agentId: string, message: string) => {
    const pane = ctx.getOrCreatePane(agentId);
    appendToPane(pane, s.dim(message) + "\n");
    if (agentId === ctx.getSelectedId()) ctx.render();
  });

  spawner.on("done", (agentId: string, result: { finalText: string; turns: number; toolCalls: number; totalCost?: string }) => {
    const pane = ctx.getOrCreatePane(agentId);
    flushPartial(pane);
    const style = getAgentStyle(pane.index);
    appendToPane(pane, "\n" + style.color(`--- ${style.icon} Agent completed ---`) + "\n");
    appendToPane(pane, s.dim(`  Turns: ${result.turns}  Tool calls: ${result.toolCalls}${result.totalCost ? `  Cost: ${result.totalCost}` : ""}`) + "\n");
    ctx.render();
  });

  spawner.on("error", (agentId: string, error: string) => {
    const pane = ctx.getOrCreatePane(agentId);
    flushPartial(pane);
    const style = getAgentStyle(pane.index);
    appendToPane(pane, "\n" + style.color(`--- ${style.icon} Error: ${error} ---`) + "\n");
    ctx.render();
  });

  spawner.on("exit", (agentId: string, code: number | null) => {
    const pane = ctx.getOrCreatePane(agentId);
    if (code !== null && code !== 0) {
      appendToPane(pane, s.dim(`  Process exited with code ${code}`) + "\n");
    }
    ctx.render();
  });

  spawner.on("message", (from: string, to: string, content: string) => {
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
    if (from === ctx.getSelectedId() || to === ctx.getSelectedId()) ctx.render();
  });
}
