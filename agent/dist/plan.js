/** Plan mode — ask the LLM for a plan before allowing tool use. */
import * as readline from "readline";
const PLAN_SUFFIX = `

## Plan mode

Before executing any tools, first describe your plan:
1. What you understand about the task
2. What files you'll need to read or modify
3. What approach you'll take
4. Any risks or uncertainties

Do NOT call any tools yet. Just describe your plan.`;
/** Append plan instruction to the system prompt. */
export function injectPlanPrompt(systemPrompt) {
    return systemPrompt + PLAN_SUFFIX;
}
/** Ask the user to approve the plan. Returns true if approved. */
export async function requestPlanApproval() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    return new Promise((resolve) => {
        rl.question("\n\x1b[1mApprove this plan? [Y/n/edit] \x1b[0m", (answer) => {
            rl.close();
            const trimmed = answer.trim().toLowerCase();
            if (trimmed === "n" || trimmed === "no") {
                resolve({ approved: false });
            }
            else if (trimmed.startsWith("edit") || trimmed.length > 3) {
                // Anything longer than "yes" is treated as feedback
                const feedback = trimmed.startsWith("edit") ? trimmed.slice(4).trim() || "Please revise the plan." : trimmed;
                resolve({ approved: false, feedback });
            }
            else {
                resolve({ approved: true });
            }
        });
    });
}
