import { moduleEnabled } from "./modules/runtime.js";
/**
 * How much text a store carries, by kind. None of the tidying phren does stays
 * done unless the weight is visible, so `phren status` prints this and doctor
 * warns when the parts an agent pays for every session have grown.
 */
import * as fs from "fs";
import * as path from "path";
import { getProjectDirs, homePath } from "./phren-paths.js";
function words(file) {
    try {
        return fs.readFileSync(file, "utf8").split(/\s+/).filter(Boolean).length;
    }
    catch {
        return 0;
    }
}
function walkWords(dir, match) {
    let total = 0;
    const stack = [dir];
    while (stack.length) {
        const current = stack.pop();
        let entries = [];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const e of entries) {
            if (e.name === ".git" || e.name === "node_modules")
                continue;
            const full = path.join(current, e.name);
            if (e.isDirectory())
                stack.push(full);
            else if (e.isFile() && match(e.name))
                total += words(full);
        }
    }
    return total;
}
export function storeWeight(phrenPath, profile = "") {
    const projectDirs = getProjectDirs(phrenPath, profile).filter((d) => path.basename(d) !== "global");
    const w = { projects: projectDirs.length, findings: 0, reference: 0, tasks: 0, skills: 0, globalClaude: words(path.join(phrenPath, "global", "AGENTS.md")) };
    for (const dir of projectDirs) {
        w.findings += words(path.join(dir, "FINDINGS.md"));
        if (moduleEnabled(phrenPath, "tasks", profile))
            w.tasks += words(path.join(dir, "tasks.md"));
        w.reference += walkWords(path.join(dir, "reference"), (n) => n.endsWith(".md"));
        w.skills += walkWords(path.join(dir, "skills"), (n) => n.endsWith(".md"));
    }
    w.skills += walkWords(path.join(phrenPath, "global", "skills"), (n) => n.endsWith(".md"));
    return w;
}
/** Median tokens the prompt hook injected per prompt, from the live lookup log's hook events. */
export function medianHookInjectionTokens(phrenPath, lastPrompts = 100) {
    const log = path.join(phrenPath, ".runtime", "lookup-events.jsonl");
    let lines = [];
    try {
        lines = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    }
    catch {
        return { prompts: 0, medianTokens: 0 };
    }
    const perPrompt = new Map();
    for (const line of lines.slice(-2000)) {
        try {
            const e = JSON.parse(line);
            if (e.source !== "hook" || !e.at)
                continue;
            const key = `${e.session ?? ""}@${e.at}`;
            perPrompt.set(key, (perPrompt.get(key) ?? 0) + Math.ceil(((e.snippet ?? "").length + 40) / 4));
        }
        catch { /* skip a torn line */ }
    }
    const sizes = [...perPrompt.values()].slice(-lastPrompts).sort((a, b) => a - b);
    if (!sizes.length)
        return { prompts: 0, medianTokens: 0 };
    return { prompts: sizes.length, medianTokens: sizes[Math.floor(sizes.length / 2)] };
}
export const CONTEXT_COST_LIMITS = { globalClaudeWords: 600, medianInjectionTokens: 1500 };
export { homePath };
