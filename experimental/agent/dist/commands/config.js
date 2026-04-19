const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
export function configCommand(parts, ctx) {
    void parts; // no sub-commands yet — display-only
    process.stderr.write(`\n${BOLD}Configuration${RESET}\n`);
    process.stderr.write(`${DIM}  Provider:    ${ctx.providerName ?? "unknown"}${RESET}\n`);
    process.stderr.write(`${DIM}  Model:       ${ctx.currentModel ?? "default"}${RESET}\n`);
    process.stderr.write(`${DIM}  Reasoning:   ${ctx.currentReasoning ?? "default"}${RESET}\n`);
    process.stderr.write(`${DIM}  Project:     ${ctx.phrenCtx?.project ?? "none"}${RESET}\n`);
    process.stderr.write(`\n`);
    return true;
}
