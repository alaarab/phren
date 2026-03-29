import { execFileSync } from "child_process";
import { checkShellSafety, scrubEnv } from "../permissions/shell-safety.js";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 100_000;
export const shellTool = {
    name: "shell",
    description: "Run a shell command and return stdout + stderr. Commands are run via bash -c.",
    input_schema: {
        type: "object",
        properties: {
            command: { type: "string", description: "Shell command to execute." },
            cwd: { type: "string", description: "Working directory. Defaults to process cwd." },
            timeout: { type: "number", description: "Timeout in ms. Default: 30000, max: 120000." },
        },
        required: ["command"],
    },
    async execute(input) {
        const command = input.command;
        const cwd = input.cwd || process.cwd();
        const timeout = Math.min(MAX_TIMEOUT_MS, input.timeout || DEFAULT_TIMEOUT_MS);
        // Block dangerous commands immediately
        const safety = checkShellSafety(command);
        if (!safety.safe && safety.severity === "block") {
            return { output: `Blocked: ${safety.reason}`, is_error: true };
        }
        try {
            const output = execFileSync("bash", ["-c", command], {
                cwd,
                encoding: "utf-8",
                timeout,
                maxBuffer: MAX_OUTPUT_BYTES,
                stdio: ["ignore", "pipe", "pipe"],
                env: scrubEnv(),
            });
            return { output: output.trim() || "(no output)" };
        }
        catch (err) {
            if (err && typeof err === "object" && "stdout" in err) {
                const e = err;
                const combined = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
                return { output: `Exit code ${e.status ?? 1}\n${combined}`, is_error: true };
            }
            const msg = err instanceof Error ? err.message : String(err);
            return { output: msg, is_error: true };
        }
    },
};
