import * as fs from "fs";
import * as path from "path";
function searchFile(filePath, regex, context) {
    let content;
    try {
        content = fs.readFileSync(filePath, "utf-8");
    }
    catch {
        return [];
    }
    const lines = content.split("\n");
    const results = [];
    for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
            const start = Math.max(0, i - context);
            const end = Math.min(lines.length - 1, i + context);
            for (let j = start; j <= end; j++) {
                results.push(`${j + 1}\t${lines[j]}`);
            }
            if (end < lines.length - 1)
                results.push("--");
        }
    }
    return results;
}
function walkDir(dir, results, maxFiles) {
    if (results.length >= maxFiles)
        return;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (results.length >= maxFiles)
            return;
        if (entry.name.startsWith(".") || entry.name === "node_modules")
            continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory())
            walkDir(full, results, maxFiles);
        else
            results.push(full);
    }
}
export const grepTool = {
    name: "grep",
    description: "Search file contents for a regex pattern. Returns matching lines with context.",
    input_schema: {
        type: "object",
        properties: {
            pattern: { type: "string", description: "Regex pattern to search for." },
            path: { type: "string", description: "File or directory to search. Default: cwd." },
            context: { type: "number", description: "Lines of context around matches. Default: 2." },
            glob: { type: "string", description: "File glob filter (e.g. '*.ts'). Default: all files." },
        },
        required: ["pattern"],
    },
    async execute(input) {
        const pattern = input.pattern;
        const searchPath = input.path || process.cwd();
        const context = input.context ?? 2;
        const fileGlob = input.glob;
        let regex;
        try {
            regex = new RegExp(pattern, "i");
        }
        catch {
            return { output: `Invalid regex: ${pattern}`, is_error: true };
        }
        const stat = fs.statSync(searchPath, { throwIfNoEntry: false });
        if (!stat)
            return { output: `Path not found: ${searchPath}`, is_error: true };
        if (stat.isFile()) {
            const results = searchFile(searchPath, regex, context);
            return { output: results.length > 0 ? `${searchPath}:\n${results.join("\n")}` : "No matches." };
        }
        const files = [];
        walkDir(searchPath, files, 5000);
        if (fileGlob) {
            const globRegex = new RegExp(fileGlob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"));
            const filtered = files.filter((f) => globRegex.test(path.basename(f)));
            files.length = 0;
            files.push(...filtered);
        }
        const output = [];
        let matchCount = 0;
        for (const file of files) {
            if (matchCount > 100)
                break;
            const results = searchFile(file, regex, context);
            if (results.length > 0) {
                const rel = path.relative(searchPath, file);
                output.push(`${rel}:\n${results.join("\n")}`);
                matchCount++;
            }
        }
        return { output: output.length > 0 ? output.join("\n\n") : "No matches." };
    },
};
