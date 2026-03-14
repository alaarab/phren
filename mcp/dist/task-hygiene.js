import * as fs from "fs";
import * as path from "path";
import { isTaskFileName, readTasks } from "./data-tasks.js";
import { STOP_WORDS, extractKeywords, errorMessage } from "./utils.js";
const TEXT_EXTENSIONS = new Set([
    ".cjs",
    ".css",
    ".go",
    ".html",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".kt",
    ".md",
    ".mjs",
    ".py",
    ".rb",
    ".rs",
    ".scss",
    ".sh",
    ".sql",
    ".swift",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
]);
const SKIP_DIRS = new Set([
    ".git",
    ".next",
    ".turbo",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
]);
const GENERIC_TASK_TERMS = new Set([
    "add",
    "audit",
    "task",
    "check",
    "checks",
    "coverage",
    "doctor",
    "docs",
    "environment",
    "environments",
    "finish",
    "fix",
    "harness",
    "improve",
    "install",
    "installs",
    "integration",
    "item",
    "items",
    "maintain",
    "message",
    "messages",
    "next",
    "pass",
    "project",
    "projects",
    "queue",
    "queued",
    "refactor",
    "repo",
    "search",
    "setup",
    "stability",
    "support",
    "test",
    "tests",
    "workflow",
]);
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_FILES_PER_ROOT = 400;
function uniqueValues(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed))
            continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}
function uniqueTerms(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        const trimmed = value.trim().toLowerCase();
        if (!trimmed || seen.has(trimmed))
            continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}
function isLikelyTextFile(filePath) {
    return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
function collectCorpus(root) {
    if (!root || !fs.existsSync(root))
        return [];
    const texts = [];
    const stack = [root];
    let filesSeen = 0;
    while (stack.length > 0 && filesSeen < MAX_FILES_PER_ROOT) {
        const current = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name))
                    stack.push(fullPath);
                continue;
            }
            if (!entry.isFile())
                continue;
            if (isTaskFileName(entry.name))
                continue;
            filesSeen += 1;
            const rel = path.relative(root, fullPath).replace(/\\/g, "/").toLowerCase();
            texts.push(rel);
            if (!isLikelyTextFile(fullPath))
                continue;
            try {
                texts.push(fs.readFileSync(fullPath, "utf8").slice(0, MAX_TEXT_BYTES).toLowerCase());
            }
            catch (err) {
                if ((process.env.PHREN_DEBUG || process.env.PHREN_DEBUG))
                    process.stderr.write(`[phren] task hygiene read ${fullPath}: ${errorMessage(err)}\n`);
            }
            if (filesSeen >= MAX_FILES_PER_ROOT)
                break;
        }
    }
    return texts;
}
function corpusHas(corpus, term) {
    const needle = term.trim().toLowerCase();
    if (!needle)
        return false;
    return corpus.some((entry) => entry.includes(needle));
}
function extractAnchors(line) {
    const anchors = [];
    const backticks = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    for (const raw of backticks) {
        anchors.push(raw);
        const base = path.basename(raw);
        if (base && base !== raw)
            anchors.push(base);
    }
    for (const match of line.matchAll(/([A-Za-z0-9_.-]+\.(?:cjs|css|go|html|java|js|json|jsx|kt|md|mjs|py|rb|rs|scss|sh|sql|swift|toml|ts|tsx|txt|yaml|yml))/g)) {
        anchors.push(match[1]);
    }
    for (const match of line.matchAll(/\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\b/g)) {
        anchors.push(match[0]);
        anchors.push(path.basename(match[0]));
    }
    for (const match of line.matchAll(/\b[A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+\b/g)) {
        anchors.push(match[0]);
    }
    return uniqueTerms(anchors.filter((term) => term.length >= 3));
}
function extractDistinctiveKeywords(line) {
    const clean = line
        .replace(/<!--.*?-->/g, " ")
        .replace(/`[^`]+`/g, " ")
        .replace(/\[(?:high|medium|low|pinned)\]/gi, " ");
    const rawTerms = extractKeywords(clean).split(/\s+/).filter(Boolean);
    return uniqueTerms(rawTerms.filter((term) => {
        if (term.length < 4)
            return false;
        if (STOP_WORDS.has(term))
            return false;
        if (GENERIC_TASK_TERMS.has(term))
            return false;
        return true;
    })).slice(0, 6);
}
function formatDetail(issues, roots) {
    if (roots.length === 0)
        return "skipped: no project repo/docs roots available for task hygiene scan";
    if (issues.length === 0)
        return `ok across ${roots.length} root${roots.length === 1 ? "" : "s"}`;
    const preview = issues
        .slice(0, 3)
        .map((issue) => `${issue.id} ${issue.reason === "anchors-missing" ? "missing anchors" : "missing keywords"} (${issue.evidence.join(", ")})`)
        .join("; ");
    return `${issues.length} suspect task(s): ${preview}`;
}
export function inspectTaskHygiene(phrenPath, project, repoPath) {
    const parsed = readTasks(phrenPath, project);
    if (!parsed.ok) {
        return { ok: true, detail: "skipped: tasks unavailable", issues: [] };
    }
    const roots = uniqueValues([
        path.join(phrenPath, project),
        repoPath || "",
    ].filter((candidate) => candidate && fs.existsSync(candidate)));
    const corpus = roots.flatMap((root) => collectCorpus(root));
    const issues = [];
    const items = [...parsed.data.items.Active, ...parsed.data.items.Queue];
    for (const item of items) {
        const anchors = extractAnchors(item.line);
        if (anchors.length > 0) {
            const matched = anchors.filter((term) => corpusHas(corpus, term));
            if (matched.length === 0) {
                issues.push({
                    id: item.id,
                    line: item.line,
                    reason: "anchors-missing",
                    evidence: anchors.slice(0, 3),
                });
            }
            continue;
        }
        const keywords = extractDistinctiveKeywords(item.line);
        if (keywords.length < 2)
            continue;
        const matched = keywords.filter((term) => corpusHas(corpus, term));
        if (matched.length === 0) {
            issues.push({
                id: item.id,
                line: item.line,
                reason: "keywords-missing",
                evidence: keywords.slice(0, 3),
            });
        }
    }
    return {
        ok: issues.length === 0,
        detail: formatDetail(issues, roots),
        issues,
    };
}
