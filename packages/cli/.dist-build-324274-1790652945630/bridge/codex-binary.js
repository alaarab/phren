import { accessSync, closeSync, constants, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
/** The `codex` the Hook runs for its own helper calls (`codex queue`, `codex
 * app-server`). `phren init` can put a session wrapper at ~/.local/bin/codex
 * that runs phren's session-start hook before the real binary for every
 * subcommand except a bare --help. That takes seconds (about 8 s on the Linux
 * box), longer than the Hook's 5 s `codex queue --help` probe, so Codex async
 * questions were reported as terminal-only, and each call opened a phren
 * session. The Hook skips its own wrapper and runs the binary it names. */
export function codexExecutable(env = process.env) {
    if (process.platform === "win32")
        return "codex";
    for (const directory of (env.PATH ?? "").split(path.delimiter)) {
        if (!path.isAbsolute(directory))
            continue;
        const candidate = path.join(directory, "codex");
        if (!executable(candidate))
            continue;
        const wrapped = phrenWrapperTarget(candidate);
        if (wrapped === undefined)
            return candidate;
        if (wrapped && executable(wrapped))
            return wrapped;
    }
    return "codex";
}
function executable(file) {
    try {
        return statSync(file).isFile() && (accessSync(file, constants.X_OK), true);
    }
    catch {
        return false;
    }
}
/** The real binary a phren session wrapper names, "" for a phren wrapper
 * whose target cannot be read, undefined for anything else. */
export function phrenWrapperTarget(file) {
    let head = "";
    try {
        const fd = openSync(file, "r");
        try {
            const buffer = Buffer.alloc(4096);
            head = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return undefined;
    }
    if (!head.startsWith("#!/bin/sh") || !head.includes("phren wrapper error:"))
        return undefined;
    // shellEscape in hooks.ts: single quotes, an embedded quote written '\''.
    const match = /^REAL_BIN='((?:[^']|'\\'')*)'$/m.exec(head);
    const target = match?.[1].replace(/'\\''/g, "'");
    return target && path.isAbsolute(target) ? target : "";
}
