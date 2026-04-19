import { createPane, appendToPane, flushPartial } from "./pane.js";
import { s, statusColor } from "./multi-render.js";
function resolveAgentTarget(target, agentOrder, panes, spawner) {
    // Try numeric index (1-based)
    const idx = parseInt(target, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= agentOrder.length) {
        return agentOrder[idx - 1];
    }
    // Try name match
    for (const [id, pane] of panes) {
        if (pane.name === target)
            return id;
    }
    // Try agent ID
    if (spawner.getAgent(target))
        return target;
    return null;
}
function appendToSystem(ctx, text) {
    if (!ctx.selectedId || !ctx.panes.has(ctx.selectedId)) {
        // Create a virtual system pane
        const pane = createPane("_system", "system");
        ctx.panes.set("_system", pane);
        if (!ctx.agentOrder.includes("_system"))
            ctx.agentOrder.push("_system");
        ctx.setSelectedId("_system");
        appendToPane(pane, text + "\n");
    }
    else {
        const pane = ctx.panes.get(ctx.selectedId);
        flushPartial(pane);
        appendToPane(pane, text + "\n");
    }
    ctx.render();
}
export function handleSlashCommand(line, ctx) {
    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    if (cmd === "/spawn") {
        const name = parts[1];
        const task = parts.slice(2).join(" ");
        if (!name || !task) {
            appendToSystem(ctx, "Usage: /spawn <name> <task>");
            return true;
        }
        const opts = {
            task,
            cwd: process.cwd(),
            provider: ctx.config.provider.name,
            permissions: "auto-confirm",
            verbose: ctx.config.verbose,
        };
        const agentId = ctx.spawner.spawn(opts);
        const pane = ctx.getOrCreatePane(agentId);
        pane.name = name;
        appendToPane(pane, s.cyan(`Spawned agent "${name}" (${agentId}): ${task}`) + "\n");
        ctx.setSelectedId(agentId);
        ctx.render();
        return true;
    }
    if (cmd === "/list") {
        const agents = ctx.spawner.listAgents();
        if (agents.length === 0) {
            appendToSystem(ctx, "No agents.");
        }
        else {
            const lines = ["Agents:"];
            for (let i = 0; i < agents.length; i++) {
                const a = agents[i];
                const pane = ctx.panes.get(a.id);
                const name = pane?.name ?? a.id;
                const color = statusColor(a.status);
                const elapsed = a.finishedAt
                    ? `${((a.finishedAt - a.startedAt) / 1000).toFixed(1)}s`
                    : `${((Date.now() - a.startedAt) / 1000).toFixed(0)}s`;
                lines.push(`  ${i + 1}. ${name} [${color(a.status)}] ${s.dim(elapsed)} — ${a.task.slice(0, 50)}`);
            }
            appendToSystem(ctx, lines.join("\n"));
        }
        return true;
    }
    if (cmd === "/kill") {
        const target = parts[1];
        if (!target) {
            appendToSystem(ctx, "Usage: /kill <name|index>");
            return true;
        }
        const agentId = resolveAgentTarget(target, ctx.agentOrder, ctx.panes, ctx.spawner);
        if (!agentId) {
            appendToSystem(ctx, `Agent "${target}" not found.`);
            return true;
        }
        const ok = ctx.spawner.cancel(agentId);
        const pane = ctx.getOrCreatePane(agentId);
        if (ok) {
            appendToPane(pane, s.yellow("\n--- Cancelled ---\n"));
        }
        else {
            appendToSystem(ctx, `Agent "${target}" is not running.`);
        }
        ctx.render();
        return true;
    }
    if (cmd === "/broadcast") {
        const msg = parts.slice(1).join(" ");
        if (!msg) {
            appendToSystem(ctx, "Usage: /broadcast <message>");
            return true;
        }
        const agents = ctx.spawner.listAgents();
        let sent = 0;
        for (const a of agents) {
            if (a.status === "running") {
                const pane = ctx.getOrCreatePane(a.id);
                appendToPane(pane, s.yellow(`[broadcast] ${msg}`) + "\n");
                sent++;
            }
        }
        appendToSystem(ctx, `Broadcast sent to ${sent} running agent(s).`);
        return true;
    }
    if (cmd === "/msg") {
        const target = parts[1];
        const msg = parts.slice(2).join(" ");
        if (!target || !msg) {
            appendToSystem(ctx, "Usage: /msg <agent> <text>");
            return true;
        }
        const agentId = resolveAgentTarget(target, ctx.agentOrder, ctx.panes, ctx.spawner);
        if (!agentId) {
            appendToSystem(ctx, `Agent "${target}" not found.`);
            return true;
        }
        const ok = ctx.spawner.sendToAgent(agentId, msg, "user");
        if (ok) {
            const recipientPane = ctx.getOrCreatePane(agentId);
            flushPartial(recipientPane);
            appendToPane(recipientPane, s.yellow(`[user -> ${recipientPane.name}] ${msg}`) + "\n");
            if (ctx.selectedId && ctx.selectedId !== agentId && ctx.panes.has(ctx.selectedId)) {
                const curPane = ctx.panes.get(ctx.selectedId);
                flushPartial(curPane);
                appendToPane(curPane, s.yellow(`[user -> ${recipientPane.name}] ${msg}`) + "\n");
            }
        }
        else {
            appendToSystem(ctx, `Agent "${target}" is not running.`);
        }
        ctx.render();
        return true;
    }
    if (cmd === "/help") {
        appendToSystem(ctx, [
            "Commands:",
            "  /spawn <name> <task>  — Spawn a new agent",
            "  /list                 — List all agents",
            "  /kill <name|index>    — Terminate an agent",
            "  /msg <agent> <text>   — Send direct message to an agent",
            "  /broadcast <msg>      — Send to all running agents",
            "  /help                 — Show this help",
            "",
            "Keys:",
            "  1-9                   — Select agent by number",
            "  Ctrl+Left/Right       — Cycle agents",
            "  PageUp/PageDown       — Scroll output",
            "  Ctrl+D                — Exit (kills all)",
        ].join("\n"));
        return true;
    }
    return false;
}
