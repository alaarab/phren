/** Multiplexed TUI for multi-agent orchestration. */
import * as readline from "node:readline";
import type { AgentSpawner } from "./spawner.js";
import type { AgentConfig } from "../agent-loop/index.js";

import type { Pane } from "./pane.js";
import { MAX_SCROLLBACK, createPane, appendToPane } from "./pane.js";
import { ESC, s, render } from "./multi-render.js";
import { handleSlashCommand, type CommandContext } from "./multi-commands.js";
import { wireSpawnerEvents } from "./multi-events.js";

// ── Main TUI ─────────────────────────────────────────────────────────────────

export async function startMultiTui(
  spawner: AgentSpawner,
  config: AgentConfig,
): Promise<void> {
  const w = process.stdout;
  const panes = new Map<string, Pane>();
  let selectedId: string | null = null;
  let inputLine = "";
  let scrollOffset = 0;

  // Ordered list of agent IDs for tab navigation
  const agentOrder: string[] = [];

  // ── Pane management ────────────────────────────────────────────────────

  function getOrCreatePane(agentId: string): Pane {
    let pane = panes.get(agentId);
    if (!pane) {
      const agent = spawner.getAgent(agentId);
      const name = agent?.task.slice(0, 20) ?? agentId;
      pane = createPane(agentId, name);
      panes.set(agentId, pane);
      if (!agentOrder.includes(agentId)) {
        agentOrder.push(agentId);
      }
      // Auto-select first agent
      if (!selectedId) {
        selectedId = agentId;
      }
    }
    return pane;
  }

  function selectAgent(agentId: string): void {
    if (panes.has(agentId)) {
      selectedId = agentId;
      scrollOffset = 0;
      doRender();
    }
  }

  function selectByIndex(index: number): void {
    if (index >= 0 && index < agentOrder.length) {
      selectAgent(agentOrder[index]);
    }
  }

  function cycleAgent(direction: number): void {
    if (agentOrder.length === 0) return;
    const currentIdx = selectedId ? agentOrder.indexOf(selectedId) : -1;
    let next = currentIdx + direction;
    if (next < 0) next = agentOrder.length - 1;
    if (next >= agentOrder.length) next = 0;
    selectAgent(agentOrder[next]);
  }

  function doRender(): void {
    render(w, spawner, panes, selectedId, scrollOffset, inputLine);
  }

  // ── Command context for slash commands ────────────────────────────────

  function getCmdCtx(): CommandContext {
    return {
      spawner,
      config,
      panes,
      agentOrder,
      selectedId,
      setSelectedId: (id) => { selectedId = id; },
      getOrCreatePane,
      render: doRender,
    };
  }

  // ── Spawner event wiring ───────────────────────────────────────────────

  wireSpawnerEvents(spawner, {
    panes,
    getOrCreatePane,
    getSelectedId: () => selectedId,
    render: doRender,
  });

  // ── Terminal setup ─────────────────────────────────────────────────────

  // Enter alternate screen
  w.write("\x1b[?1049h");

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
  }

  function cleanup(): void {
    w.write("\x1b[?1049l"); // leave alternate screen
    w.write(`${ESC}?25h`);  // show cursor
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
  }

  // ── Promise-based lifecycle ────────────────────────────────────────────

  return new Promise<void>((resolve) => {
    async function shutdown(): Promise<void> {
      cleanup();
      w.write(s.dim("Shutting down agents...\n"));
      await spawner.shutdown();
      w.write(s.dim("All agents stopped.\n"));
      resolve();
    }

    // ── Keypress handler ─────────────────────────────────────────────────

    process.stdin.on("keypress", (_ch: string | undefined, key: readline.Key) => {
      if (!key) return;

      // Ctrl+D — exit
      if (key.ctrl && key.name === "d") {
        shutdown();
        return;
      }

      // Ctrl+C — clear input or exit if empty
      if (key.ctrl && key.name === "c") {
        if (inputLine.length > 0) {
          inputLine = "";
          doRender();
        } else {
          shutdown();
        }
        return;
      }

      // Number keys 1-9 — select agent
      if (!key.ctrl && !key.meta && key.sequence && /^[1-9]$/.test(key.sequence) && inputLine.length === 0) {
        selectByIndex(parseInt(key.sequence, 10) - 1);
        return;
      }

      // Ctrl+Left/Right — cycle agents
      if (key.ctrl && key.name === "left") {
        cycleAgent(-1);
        return;
      }
      if (key.ctrl && key.name === "right") {
        cycleAgent(1);
        return;
      }

      // Page Up/Down — scroll
      if (key.name === "pageup") {
        const availRows = (process.stdout.rows || 24) - 3;
        scrollOffset = Math.min(scrollOffset + Math.floor(availRows / 2), MAX_SCROLLBACK);
        doRender();
        return;
      }
      if (key.name === "pagedown") {
        const availRows = (process.stdout.rows || 24) - 3;
        scrollOffset = Math.max(0, scrollOffset - Math.floor(availRows / 2));
        doRender();
        return;
      }

      // Enter — submit input
      if (key.name === "return") {
        const line = inputLine.trim();
        inputLine = "";

        if (!line) {
          doRender();
          return;
        }

        if (line.startsWith("/")) {
          if (handleSlashCommand(line, getCmdCtx())) {
            doRender();
            return;
          }
        }

        // Send as text to currently selected agent's pane
        if (selectedId && panes.has(selectedId)) {
          const pane = panes.get(selectedId)!;
          appendToPane(pane, s.cyan(`> ${line}`) + "\n");
        }

        doRender();
        return;
      }

      // Backspace
      if (key.name === "backspace") {
        if (inputLine.length > 0) {
          inputLine = inputLine.slice(0, -1);
          doRender();
        }
        return;
      }

      // Regular character input
      if (key.sequence && !key.ctrl && !key.meta) {
        inputLine += key.sequence;
        doRender();
      }
    });

    // Handle terminal resize
    process.stdout.on("resize", () => doRender());

    // Register panes for any agents that already exist
    for (const agent of spawner.listAgents()) {
      getOrCreatePane(agent.id);
    }
    if (agentOrder.length > 0) {
      selectedId = agentOrder[0];
    }
    doRender();
  });
}
