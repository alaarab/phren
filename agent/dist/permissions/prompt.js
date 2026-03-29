import * as readline from "readline";
/**
 * Ask the user on stderr whether to allow a tool call.
 * Returns true if user approves, false otherwise.
 */
export async function askUser(toolName, input, reason) {
    const preview = JSON.stringify(input).slice(0, 300);
    const more = JSON.stringify(input).length > 300 ? "..." : "";
    process.stderr.write(`\n⚠  Permission required: ${toolName}\n`);
    process.stderr.write(`   Reason: ${reason}\n`);
    process.stderr.write(`   Input:  ${preview}${more}\n`);
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
    });
    return new Promise((resolve) => {
        rl.question("   Allow? [y/N] ", (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === "y");
        });
    });
}
