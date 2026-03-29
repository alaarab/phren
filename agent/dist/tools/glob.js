import * as fs from "fs";
import * as path from "path";
/** Simple glob matching without external dependencies. Supports * and ** patterns. */
function matchGlob(pattern, filePath) {
    const regex = pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "{{GLOBSTAR}}")
        .replace(/\*/g, "[^/]*")
        .replace(/{{GLOBSTAR}}/g, ".*");
    return new RegExp(`^${regex}$`).test(filePath);
}
function walkDir(dir, base, results, maxResults) {
    if (results.length >= maxResults)
        return;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (results.length >= maxResults)
            return;
        if (entry.name.startsWith(".") || entry.name === "node_modules")
            continue;
        const full = path.join(dir, entry.name);
        const rel = path.relative(base, full);
        if (entry.isDirectory()) {
            walkDir(full, base, results, maxResults);
        }
        else {
            results.push(rel);
        }
    }
}
export const globTool = {
    name: "glob",
    description: "Find files matching a glob pattern (e.g. '**/*.ts', 'src/**/*.test.js'). Returns matching file paths.",
    input_schema: {
        type: "object",
        properties: {
            pattern: { type: "string", description: "Glob pattern to match." },
            path: { type: "string", description: "Directory to search in. Default: cwd." },
        },
        required: ["pattern"],
    },
    async execute(input) {
        const pattern = input.pattern;
        const searchPath = input.path || process.cwd();
        const maxResults = 500;
        const allFiles = [];
        walkDir(searchPath, searchPath, allFiles, 10000);
        const matches = allFiles.filter((f) => matchGlob(pattern, f)).slice(0, maxResults);
        if (matches.length === 0)
            return { output: "No files found." };
        return { output: matches.join("\n") };
    },
};
