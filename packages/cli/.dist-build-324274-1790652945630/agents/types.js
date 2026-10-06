/**
 * What phren knows about a coding agent running on this machine.
 *
 * phren does not spawn or supervise these; it discovers them from whatever is
 * already managing them — a Herdr workspace, phren-agent's own multi-agent
 * spawner, a tmux session — and joins them onto the knowledge graph by the
 * directory they are working in.
 *
 * The contract is deliberately small and host-agnostic. Anything that can
 * print this shape is a provider, which is why a tmux or Zellij user needs a
 * few lines of shell rather than a change to phren.
 */
const STATUSES = new Set(["working", "idle", "done", "error"]);
/**
 * Structural guard for records that arrive from outside phren. These drive a
 * command invocation, so a malformed entry is dropped rather than trusted —
 * the same posture governance takes with its on-disk JSON.
 */
export function isAgentRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const rec = value;
    if (typeof rec.id !== "string" || !rec.id)
        return false;
    if (typeof rec.label !== "string")
        return false;
    if (typeof rec.cwd !== "string" || !rec.cwd)
        return false;
    if (typeof rec.status !== "string" || !STATUSES.has(rec.status))
        return false;
    if (rec.kind !== undefined && typeof rec.kind !== "string")
        return false;
    if (rec.focused !== undefined && typeof rec.focused !== "boolean")
        return false;
    if (rec.focus !== undefined) {
        if (!Array.isArray(rec.focus) || rec.focus.length === 0)
            return false;
        if (!rec.focus.every((part) => typeof part === "string" && part.length > 0))
            return false;
    }
    return true;
}
