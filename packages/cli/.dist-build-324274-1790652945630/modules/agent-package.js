import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
/**
 * `phren agent` launches phren's coding agent, which ships separately as
 * `@phren/agent` (it brings ink and React, which the CLI must not carry). Like
 * `@phren/code` it is optional: nothing here is imported until the command
 * runs, and a missing package is a one-line hint, not a stack trace.
 */
export const AGENT_PACKAGE_HINT = "phren agent needs @phren/agent: run npm install -g @phren/agent";
function readManifest(directory) {
    try {
        return JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    }
    catch {
        return undefined;
    }
}
/** The installed package in `directory`, if it is @phren/agent and its binary is built. */
export function agentPackageAt(directory, source) {
    const manifest = readManifest(directory);
    if (manifest?.name !== "@phren/agent")
        return undefined;
    const relative = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["phren-agent"];
    if (!relative)
        return undefined;
    const bin = path.join(directory, relative);
    return fs.existsSync(bin) ? { directory, bin, version: manifest.version, source } : undefined;
}
/** This repository checked out as a workspace, if its packages/agent is present. */
function workspaceDirectory() {
    let directory = path.dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth++) {
        const candidate = path.join(directory, "packages", "agent");
        if (fs.existsSync(path.join(candidate, "package.json")))
            return candidate;
        const parent = path.dirname(directory);
        if (parent === directory)
            break;
        directory = parent;
    }
    return undefined;
}
function resolvedDirectory() {
    try {
        return path.dirname(createRequire(import.meta.url).resolve("@phren/agent/package.json"));
    }
    catch {
        return undefined;
    }
}
function globalDirectory() {
    try {
        const options = { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] };
        const root = (process.platform === "win32"
            ? execFileSync("npm.cmd", ["root", "-g"], { ...options, shell: true })
            : execFileSync("npm", ["root", "-g"], options)).trim();
        return root ? path.join(root, "@phren", "agent") : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Resolution order, first hit wins: an explicit directory
 * (`PHREN_AGENT_PACKAGE`), a package Node resolves next to this CLI, this
 * repository's own packages/agent in a workspace checkout, then npm's global
 * root. `global: false` skips the npm call for quick probes such as init's.
 */
export function findAgentPackage(options = {}) {
    const candidates = [
        [() => process.env.PHREN_AGENT_PACKAGE, "PHREN_AGENT_PACKAGE"],
        [resolvedDirectory, "@phren/agent"],
        [workspaceDirectory, "workspace"],
    ];
    if (options.global !== false)
        candidates.push([globalDirectory, "npm global"]);
    for (const [locate, source] of candidates) {
        const directory = locate();
        const found = directory ? agentPackageAt(directory, source) : undefined;
        if (found)
            return found;
    }
    return undefined;
}
/** Whether the agent can start here, from a local package or a `phren-agent`
 * on PATH. Cheap enough for init's summary: no npm call. */
export function agentInstalled() {
    if (findAgentPackage({ global: false }))
        return true;
    try {
        execFileSync(process.platform === "win32" ? "where.exe" : "which", ["phren-agent"], { stdio: "ignore", timeout: 5_000 });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Run the agent in a child process with this terminal. The child's argv[0] is
 * `phren-agent`, so the tmux provider and anything else that reads the process
 * table sees the same agent whichever entry point started it; the environment
 * (HERDR_PANE_ID, PHREN_PATH) passes through unchanged, which is what binds a
 * Herdr pane to the session's event log.
 */
export async function runAgentCommand(args) {
    const agent = findAgentPackage();
    if (!agent) {
        console.error(AGENT_PACKAGE_HINT);
        return 1;
    }
    const child = spawn(process.execPath, [agent.bin, ...args], { stdio: "inherit", argv0: "phren-agent", env: process.env });
    // The terminal delivers Ctrl-C to the whole foreground group; the child
    // decides what it means. This process only waits and relays its exit.
    const forward = (signal) => () => { if (!child.killed)
        child.kill(signal); };
    const onTerm = forward("SIGTERM"), onHup = forward("SIGHUP"), onInt = () => { };
    process.on("SIGINT", onInt).on("SIGTERM", onTerm).on("SIGHUP", onHup);
    try {
        return await new Promise((resolve) => {
            child.on("error", (error) => { console.error(`phren agent: ${error.message}`); resolve(1); });
            child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 + (signalNumber(signal) ?? 1) : 1)));
        });
    }
    finally {
        process.off("SIGINT", onInt).off("SIGTERM", onTerm).off("SIGHUP", onHup);
    }
}
function signalNumber(signal) {
    return { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }[signal];
}
