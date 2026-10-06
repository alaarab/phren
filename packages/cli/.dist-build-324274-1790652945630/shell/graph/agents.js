/**
 * Live coding agents on the knowledge graph.
 *
 * Watch mode shows what phren's memory is doing; this shows who is doing it.
 * Agents are transient runtime state rather than memory, so they decorate the
 * project nodes they are working in instead of becoming graph nodes of their
 * own — the same shape `GraphWatch` uses, and it keeps `graph-core` (which is
 * bundled for the browser) untouched.
 */
import { execFileSync } from "child_process";
import { commandExists } from "../../hooks.js";
import { detectProject } from "../../shared/index.js";
import { debugLog } from "../../shared.js";
import { errorMessage } from "../../utils.js";
import { agentsEnabled, collectAgents, joinAgents, sortAgents } from "../../agents/registry.js";
import { createHerdrProvider } from "../../agents/providers/herdr.js";
import { createSpawnerProvider } from "../../agents/providers/spawner.js";
const DEFAULT_POLL_MS = 2000;
const FOCUS_TIMEOUT_MS = 5000;
/** Run a provider-supplied focus command. Never throws. */
export function runFocusCommand(argv) {
    if (!argv.length)
        return false;
    const [command, ...args] = argv;
    try {
        execFileSync(command, args, { stdio: ["ignore", "ignore", "ignore"], timeout: FOCUS_TIMEOUT_MS });
        return true;
    }
    catch (err) {
        debugLog(`agent focus: ${errorMessage(err)}`);
        return false;
    }
}
export class GraphAgents {
    phrenPath;
    profile;
    agents = [];
    /** Index into `agents`; -1 when nothing is highlighted. */
    highlighted = -1;
    enabled;
    timer = null;
    onUpdate = null;
    pollMs;
    collectFn;
    runFocus;
    constructor(phrenPath, profile, opts = {}) {
        this.phrenPath = phrenPath;
        this.profile = profile;
        this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
        this.runFocus = opts.runFocus ?? runFocusCommand;
        this.enabled = opts.enabled ?? agentsEnabled();
        this.collectFn = opts.collect ?? (() => {
            const providers = [createHerdrProvider(commandExists), createSpawnerProvider(phrenPath)];
            return joinAgents(collectAgents(providers), (cwd) => detectProject(phrenPath, cwd, profile));
        });
    }
    get running() {
        return this.timer !== null || this.polledOnce;
    }
    polledOnce = false;
    /**
     * Is there anything to show, without turning the overlay on? Used to offer
     * the feature when agents are actually running, rather than leaving it as a
     * key nobody presses.
     */
    hasSomethingToShow() {
        try {
            return this.collectFn().length > 0;
        }
        catch {
            return false;
        }
    }
    start(onUpdate) {
        if (!this.enabled || this.timer)
            return;
        this.onUpdate = onUpdate;
        this.poll();
        this.timer = setInterval(() => {
            const before = signature(this.agents);
            this.poll();
            if (signature(this.agents) !== before)
                this.onUpdate?.();
        }, this.pollMs);
        this.timer.unref?.();
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.onUpdate = null;
        this.polledOnce = false;
        this.agents = [];
        this.highlighted = -1;
    }
    toggle() {
        this.enabled = !this.enabled;
        if (!this.enabled) {
            this.stop();
            this.enabled = false;
        }
        return this.enabled;
    }
    /** Refresh the list. Never throws; a failing provider just yields nothing. */
    poll() {
        let next = [];
        try {
            next = sortAgents(this.collectFn());
        }
        catch (err) {
            debugLog(`graph agents poll: ${errorMessage(err)}`);
            next = [];
        }
        const previousId = this.highlighted >= 0 ? this.agents[this.highlighted]?.id : undefined;
        this.agents = next;
        this.polledOnce = true;
        // Keep the highlight on the same agent across a refresh where possible.
        this.highlighted = previousId ? next.findIndex((a) => a.id === previousId) : -1;
        return next;
    }
    /** Agents grouped by the project they are working in. */
    byProject() {
        const map = new Map();
        for (const agent of this.agents) {
            if (!agent.project)
                continue;
            const list = map.get(agent.project);
            if (list)
                list.push(agent);
            else
                map.set(agent.project, [agent]);
        }
        return map;
    }
    get current() {
        return this.highlighted >= 0 ? this.agents[this.highlighted] ?? null : null;
    }
    /** Move the highlight; wraps, and starts from the first agent. */
    cycle(delta) {
        if (!this.agents.length) {
            this.highlighted = -1;
            return null;
        }
        const next = this.highlighted < 0
            ? (delta >= 0 ? 0 : this.agents.length - 1)
            : (this.highlighted + delta + this.agents.length) % this.agents.length;
        this.highlighted = next;
        return this.agents[next] ?? null;
    }
    clearHighlight() {
        this.highlighted = -1;
    }
    /** Bring the highlighted agent to the front in whatever is hosting it. */
    focusCurrent() {
        const agent = this.current;
        if (!agent?.focus?.length)
            return null;
        return this.runFocus(agent.focus) ? agent : null;
    }
}
/** Cheap change detector, so a poll that found nothing new costs no repaint. */
function signature(agents) {
    return agents.map((a) => `${a.id}:${a.status}:${a.focused ? 1 : 0}:${a.project ?? ""}`).join("|");
}
