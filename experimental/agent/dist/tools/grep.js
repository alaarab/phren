import * as fs from "fs";
import * as path from "path";
import { validatePath } from "../permissions/sandbox.js";
function searchFile(filePath, regex, contextBefore, contextAfter) {
    let content;
    try {
        content = fs.readFileSync(filePath, "utf-8");
    }
    catch {
        return [];
    }
    const lines = content.split("\n");
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
            const start = Math.max(0, i - contextBefore);
            const end = Math.min(lines.length - 1, i + contextAfter);
            for (let j = start; j <= end; j++) {
                matches.push({ line: j + 1, text: lines[j] });
            }
            if (end < lines.length - 1)
                matches.push({ line: -1, text: "--" });
        }
    }
    return matches;
}
function searchFileMultiline(filePath, regex) {
    let content;
    try {
        content = fs.readFileSync(filePath, "utf-8");
    }
    catch {
        return [];
    }
    const matches = [];
    let match;
    while ((match = regex.exec(content)) !== null) {
        const beforeMatch = content.slice(0, match.index);
        const lineNo = beforeMatch.split("\n").length;
        matches.push({ line: lineNo, text: match[0].slice(0, 200) });
    }
    return matches;
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
const FILE_TYPE_EXTENSIONS = {
    js: [".js", ".jsx", ".mjs", ".cjs"],
    ts: [".ts", ".tsx", ".mts", ".cts"],
    py: [".py", ".pyw"],
    rust: [".rs"],
    go: [".go"],
    java: [".java"],
    rb: [".rb"],
    css: [".css", ".scss", ".sass", ".less"],
    html: [".html", ".htm"],
    json: [".json"],
    yaml: [".yaml", ".yml"],
    md: [".md", ".mdx"],
    sh: [".sh", ".bash", ".zsh"],
    sql: [".sql"],
};
export const grepTool = {
    name: "grep",
    description: "Search file contents by regex. Supports output modes (content, files_with_matches, count), context lines, multiline matching, file type filtering, and result pagination.",
    input_schema: {
        type: "object",
        properties: {
            pattern: { type: "string", description: "Regex pattern to search for." },
            path: { type: "string", description: "File or directory to search. Default: cwd." },
            context: { type: "number", description: "Lines of context around matches (-C). Default: 2." },
            "-A": { type: "number", description: "Lines to show after each match." },
            "-B": { type: "number", description: "Lines to show before each match." },
            glob: { type: "string", description: "File glob filter (e.g. '*.ts')." },
            type: { type: "string", description: "File type filter (e.g. 'js', 'py', 'ts', 'rust', 'go')." },
            output_mode: {
                type: "string",
                enum: ["content", "files_with_matches", "count"],
                description: "Output mode. 'content' shows lines, 'files_with_matches' shows paths only, 'count' shows match counts. Default: content.",
            },
            multiline: { type: "boolean", description: "Enable multiline matching (pattern can span lines). Default: false." },
            head_limit: { type: "number", description: "Max results to return. Default: 100." },
            offset: { type: "number", description: "Skip first N results before applying head_limit." },
            "-i": { type: "boolean", description: "Case insensitive search. Default: true." },
        },
        required: ["pattern"],
    },
    async execute(input) {
        const pattern = input.pattern;
        const searchPath = input.path || process.cwd();
        const contextC = input.context ?? input["-C"] ?? 2;
        const contextA = input["-A"] ?? contextC;
        const contextB = input["-B"] ?? contextC;
        const fileGlob = input.glob;
        const fileType = input.type;
        const outputMode = input.output_mode || "content";
        const multiline = input.multiline;
        const headLimit = input.head_limit ?? 100;
        const offset = input.offset ?? 0;
        const caseInsensitive = input["-i"] ?? true;
        const pathResult = validatePath(searchPath, process.cwd(), []);
        if (!pathResult.ok) {
            return { output: `Path outside sandbox: ${pathResult.error}`, is_error: true };
        }
        let regex;
        try {
            const flags = (caseInsensitive ? "i" : "") + (multiline ? "gs" : "");
            regex = new RegExp(pattern, flags || "i");
        }
        catch {
            return { output: `Invalid regex: ${pattern}`, is_error: true };
        }
        const stat = fs.statSync(searchPath, { throwIfNoEntry: false });
        if (!stat)
            return { output: `Path not found: ${searchPath}`, is_error: true };
        // Single file
        if (stat.isFile()) {
            const results = multiline
                ? searchFileMultiline(searchPath, regex)
                : searchFile(searchPath, regex, contextB, contextA);
            if (outputMode === "files_with_matches")
                return { output: results.length > 0 ? searchPath : "No matches." };
            if (outputMode === "count")
                return { output: `${results.filter((r) => r.line > 0).length}` };
            return { output: results.length > 0 ? `${searchPath}:\n${results.map((r) => r.line > 0 ? `${r.line}\t${r.text}` : r.text).join("\n")}` : "No matches." };
        }
        // Directory search
        const files = [];
        walkDir(searchPath, files, 5000);
        // File type filter
        if (fileType) {
            const exts = FILE_TYPE_EXTENSIONS[fileType] ?? [`.${fileType}`];
            const filtered = files.filter((f) => exts.some((ext) => f.endsWith(ext)));
            files.length = 0;
            files.push(...filtered);
        }
        // Glob filter
        if (fileGlob) {
            const globRegex = new RegExp(fileGlob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"));
            const filtered = files.filter((f) => globRegex.test(path.basename(f)));
            files.length = 0;
            files.push(...filtered);
        }
        const output = [];
        let totalMatches = 0;
        let skipped = 0;
        for (const file of files) {
            if (output.length >= headLimit + offset)
                break;
            const results = multiline
                ? searchFileMultiline(file, regex)
                : searchFile(file, regex, contextB, contextA);
            if (results.length === 0)
                continue;
            totalMatches++;
            if (skipped < offset) {
                skipped++;
                continue;
            }
            if (output.length >= headLimit)
                break;
            const rel = path.relative(searchPath, file);
            if (outputMode === "files_with_matches") {
                output.push(rel);
            }
            else if (outputMode === "count") {
                output.push(`${rel}: ${results.filter((r) => r.line > 0).length}`);
            }
            else {
                output.push(`${rel}:\n${results.map((r) => r.line > 0 ? `${r.line}\t${r.text}` : r.text).join("\n")}`);
            }
        }
        if (output.length === 0)
            return { output: "No matches." };
        return { output: output.join(outputMode === "content" ? "\n\n" : "\n") };
    },
};
