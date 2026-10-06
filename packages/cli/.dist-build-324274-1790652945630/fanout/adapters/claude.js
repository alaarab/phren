import { uuid } from "./types.js";
// `claude -p` asks nothing headless: a build worker accepts edits, and a
// command the brief needs comes through `--extra --allowedTools`. A manifest
// model of "default" means the configured one, so no --model is passed.
export const claude = {
    command: "claude",
    argv: o => ["-p", "--output-format", "stream-json", "--verbose", ...(o.model && o.model !== "default" ? ["--model", o.model] : []),
        "--permission-mode", o.review ? "plan" : "acceptEdits", ...(o.resume ? ["--resume", o.resume] : []), ...(o.extra ?? [])],
    session: event => uuid(event.session_id),
    // It exits 0 after refusing a tool; the result row lists what it refused.
    refusal: event => {
        const denials = event.type === "result" && Array.isArray(event.permission_denials) ? event.permission_denials : [];
        const first = denials[0] && typeof denials[0] === "object" ? denials[0] : undefined;
        if (!first)
            return undefined;
        const tool = String(first.tool_name ?? "tool").slice(0, 200), input = (first.tool_input && typeof first.tool_input === "object" ? first.tool_input : {});
        const target = String(input.command ?? input.file_path ?? input.path ?? "").slice(0, 500);
        return { type: "permission", pattern: `${tool} ${target}`.trim(), message: `${denials.length} tool call(s) refused; first: ${tool}` };
    },
};
