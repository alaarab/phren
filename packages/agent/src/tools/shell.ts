import { execFileSync } from "child_process";
import type { AgentTool } from "./types.js";
import { checkShellSafety, scrubEnv } from "../permissions/shell-safety.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 100_000;

export const shellTool: AgentTool = {
  name: "shell",
  description: "Run a shell command via bash -c and return stdout + stderr. Use for: running tests, linters, build commands, git operations, and exploring the environment. Prefer specific tools (read_file, glob, grep) over shell equivalents when available.",
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
    const command = input.command as string;
    const cwd = (input.cwd as string) || process.cwd();
    const timeout = Math.min(MAX_TIMEOUT_MS, (input.timeout as number) || DEFAULT_TIMEOUT_MS);

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
    } catch (err: unknown) {
      if (err && typeof err === "object" && "stdout" in err) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        const combined = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
        return { output: `Exit code ${e.status ?? 1}\n${combined}`, is_error: true };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { output: msg, is_error: true };
    }
  },
};
