/**
 * Agent type system — built-in and custom agent type definitions.
 *
 * Agent types restrict or configure child agents by limiting their tool set
 * and injecting role-specific system prompt prefixes.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
// ── Built-in agent types ───────────────────────────────────────────────────
export const BUILTIN_AGENT_TYPES = new Map([
    [
        "explore",
        {
            name: "explore",
            description: "Read-only exploration agent for searching and reading code.",
            allowedTools: [
                "read_file",
                "glob",
                "grep",
                "phren_search",
                "git_status",
                "git_diff",
            ],
            systemPromptPrefix: "You are a read-only exploration agent. You can search and read code but cannot modify files.",
        },
    ],
    [
        "plan",
        {
            name: "plan",
            description: "Research and planning agent that can read code and capture findings.",
            allowedTools: [
                "read_file",
                "glob",
                "grep",
                "phren_search",
                "phren_add_finding",
                "git_status",
                "git_diff",
            ],
            systemPromptPrefix: "You are a planning agent. Research the codebase and create a detailed implementation plan.",
        },
    ],
    [
        "general",
        {
            name: "general",
            description: "General-purpose agent with access to all tools.",
        },
    ],
]);
// ── Custom agent types from filesystem ─────────────────────────────────────
const DEFAULT_AGENT_TYPES_DIR = join(homedir(), ".phren-agent", "agents");
/**
 * Load custom agent types from .md files in the given directory.
 * Each file should have YAML frontmatter between --- delimiters.
 * Custom types override builtins with the same name.
 */
export function loadCustomAgentTypes(dir) {
    const merged = new Map(BUILTIN_AGENT_TYPES);
    const agentDir = dir ?? DEFAULT_AGENT_TYPES_DIR;
    if (!existsSync(agentDir))
        return merged;
    let files;
    try {
        files = readdirSync(agentDir).filter((f) => f.endsWith(".md"));
    }
    catch {
        return merged;
    }
    for (const file of files) {
        try {
            const content = readFileSync(join(agentDir, file), "utf-8");
            const parsed = parseFrontmatter(content);
            if (parsed && parsed.name) {
                merged.set(parsed.name, parsed);
            }
        }
        catch {
            // Skip malformed files
        }
    }
    return merged;
}
/**
 * Parse YAML-like frontmatter from a markdown file.
 * Expects content between --- delimiters with key: value lines.
 */
function parseFrontmatter(content) {
    const lines = content.split("\n");
    if (lines[0]?.trim() !== "---")
        return null;
    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === "---") {
            endIdx = i;
            break;
        }
    }
    if (endIdx === -1)
        return null;
    const frontmatterLines = lines.slice(1, endIdx);
    const raw = {};
    for (const line of frontmatterLines) {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1)
            continue;
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        if (key && value) {
            raw[key] = value;
        }
    }
    if (!raw["name"])
        return null;
    const def = {
        name: raw["name"],
        description: raw["description"] ?? "",
    };
    if (raw["model"])
        def.model = raw["model"];
    if (raw["maxTurns"])
        def.maxTurns = parseInt(raw["maxTurns"], 10);
    if (raw["allowedTools"]) {
        def.allowedTools = raw["allowedTools"]
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
    }
    if (raw["disallowedTools"]) {
        def.disallowedTools = raw["disallowedTools"]
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
    }
    if (raw["systemPromptPrefix"]) {
        def.systemPromptPrefix = raw["systemPromptPrefix"];
    }
    return def;
}
// ── Lookup ─────────────────────────────────────────────────────────────────
/**
 * Look up an agent type by name from builtins + custom types.
 */
export function getAgentType(name) {
    const all = loadCustomAgentTypes();
    return all.get(name) ?? null;
}
// ── Apply to registry ──────────────────────────────────────────────────────
/**
 * Apply an agent type's tool restrictions to a ToolRegistry.
 * - If allowedTools is set, remove all tools not in the list.
 * - If disallowedTools is set, remove those tools.
 */
export function applyAgentType(registry, agentType) {
    if (agentType.allowedTools) {
        const allowed = new Set(agentType.allowedTools);
        for (const name of registry.toolNames()) {
            if (!allowed.has(name)) {
                registry.remove(name);
            }
        }
    }
    if (agentType.disallowedTools) {
        for (const name of agentType.disallowedTools) {
            registry.remove(name);
        }
    }
}
