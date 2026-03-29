import { execFileSync } from "child_process";
function git(args, cwd) {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf-8",
        timeout: 30_000,
        maxBuffer: 200_000,
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}
export const gitStatusTool = {
    name: "git_status",
    description: "Show the working tree status (git status --short).",
    input_schema: {
        type: "object",
        properties: {
            cwd: { type: "string", description: "Working directory. Defaults to process cwd." },
        },
        required: [],
    },
    async execute(input) {
        const cwd = input.cwd || process.cwd();
        try {
            const output = git(["status", "--short"], cwd);
            return { output: output || "(working tree clean)" };
        }
        catch (err) {
            return { output: err instanceof Error ? err.message : String(err), is_error: true };
        }
    },
};
export const gitDiffTool = {
    name: "git_diff",
    description: "Show file changes (git diff). Use cached=true for staged changes.",
    input_schema: {
        type: "object",
        properties: {
            cwd: { type: "string", description: "Working directory. Defaults to process cwd." },
            cached: { type: "boolean", description: "Show staged changes (--cached)." },
            path: { type: "string", description: "Limit diff to a specific file path." },
        },
        required: [],
    },
    async execute(input) {
        const cwd = input.cwd || process.cwd();
        const args = ["diff"];
        if (input.cached)
            args.push("--cached");
        if (input.path)
            args.push("--", input.path);
        try {
            const output = git(args, cwd);
            return { output: output || "(no changes)" };
        }
        catch (err) {
            return { output: err instanceof Error ? err.message : String(err), is_error: true };
        }
    },
};
export const gitCommitTool = {
    name: "git_commit",
    description: "Stage files and commit with a message. Returns the commit hash.",
    input_schema: {
        type: "object",
        properties: {
            cwd: { type: "string", description: "Working directory. Defaults to process cwd." },
            message: { type: "string", description: "Commit message." },
            files: {
                type: "array",
                items: { type: "string" },
                description: "Files to stage. If empty, stages all changed files.",
            },
        },
        required: ["message"],
    },
    async execute(input) {
        const cwd = input.cwd || process.cwd();
        const message = input.message;
        const files = input.files || [];
        try {
            // Stage files
            if (files.length > 0) {
                git(["add", ...files], cwd);
            }
            else {
                git(["add", "-A"], cwd);
            }
            // Commit
            git(["commit", "-m", message], cwd);
            // Return the hash
            const hash = git(["rev-parse", "--short", "HEAD"], cwd);
            return { output: `Committed: ${hash}` };
        }
        catch (err) {
            return { output: err instanceof Error ? err.message : String(err), is_error: true };
        }
    },
};
