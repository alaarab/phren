// What the Hook needs from the terminal multiplexer its agents run in: Herdr
// (terminal-herdr.ts) and tmux (terminal-tmux.ts), including both on one computer.
// Nothing Herdr- or tmux-specific may leak past a provider's own file.
//
// Identity (which conversation a pane runs) and agent status are not the
// provider's job. A multiplexer that knows them reports them as `hints`; one
// that does not leaves them out and the Hook falls back to lifecycle hooks
// and process logs.
import { existsSync } from "node:fs";
import { herdrPaneFromEnv, herdrSocketPath } from "./herdr.js";
import { BridgeError } from "./protocol.js";
import { herdrTerminal } from "./terminal-herdr.js";
import { tmuxPaneFromEnv, tmuxSocketName, tmuxTerminal } from "./terminal-tmux.js";
/** The pane this process runs in, from the variables its multiplexer sets:
 * inside Herdr only Herdr's pane counts, elsewhere a tmux pane does. */
export async function terminalPaneFromEnv(env = process.env) {
    if (env.HERDR_ENV === "1")
        return env.HERDR_SOCKET_PATH ? herdrPaneFromEnv(env) : undefined;
    return tmuxPaneFromEnv(env);
}
/** Which multiplexer a Hook server name belongs to: "tmux" and "tmux-<socket>"
 * are tmux servers unless Herdr has a session of that name; every other name
 * is a Herdr server, exactly as before tmux support. */
export function terminalKind(server) {
    if (!tmuxSocketName(server))
        return "herdr";
    try {
        return existsSync(herdrSocketPath(server)) ? "herdr" : "tmux";
    }
    catch {
        return "tmux";
    }
}
/** The multiplexer's name as the phone shows it in messages. */
export function terminalName(server) { return terminalKind(server) === "tmux" ? "tmux" : "Herdr"; }
/** Stable source identity for overview/pane replies; agent source remains its harness. */
export function terminalMux(server) {
    const kind = terminalKind(server);
    return { id: `${kind}:${server}`, kind, session: server };
}
const route = (server) => terminalKind(server) === "tmux" ? tmuxTerminal : herdrTerminal;
/** The provider for each server by its name: Herdr's or tmux's. */
export const routedTerminal = {
    kind: "routed",
    ping: server => route(server).ping(server),
    snapshot: server => route(server).snapshot(server),
    listPanes: server => route(server).listPanes(server),
    processes: (server, pane) => route(server).processes(server, pane),
    readScreen: (server, pane, read) => route(server).readScreen(server, pane, read),
    sendKeys: (server, pane, keys) => route(server).sendKeys(server, pane, keys),
    prompt: (server, pane, text, signal) => route(server).prompt(server, pane, text, signal),
    create: (server, placement) => route(server).create(server, placement),
    startAgent: (server, pane, agent) => route(server).startAgent(server, pane, agent),
    paneEnv: (server, place) => route(server).paneEnv?.(server, place),
    focusPane: (server, pane) => route(server).focusPane(server, pane),
    groupAction: (server, operation, group, label) => route(server).groupAction(server, operation, group, label),
};
/** True when a start or prompt was refused because the agent is still
 * starting (a folder-trust or login screen holds it). Herdr says so with its
 * own error code; another provider with `code`. */
export function agentNotReady(error) {
    return error instanceof BridgeError && (error.details?.code === "agent_not_ready" || error.details?.herdrCode === "agent_not_ready");
}
let current = routedTerminal;
/** The multiplexer the Hook drives: each call goes to its server's provider. */
export function terminalProvider() { return current; }
/** For tests: drive the Hook through `provider`; the returned function restores the previous one. */
export function setTerminalProvider(provider) {
    const previous = current;
    current = provider;
    return () => { current = previous; };
}
