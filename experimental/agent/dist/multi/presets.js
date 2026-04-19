/**
 * Agent config presets — save/load provider+model+permissions combos.
 *
 * User presets stored at ~/.phren-agent/presets.json.
 * Built-in presets are always available and cannot be overwritten.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
// ── Built-in presets ────────────────────────────────────────────────────
const BUILTIN_PRESETS = {
    fast: {
        provider: "ollama",
        permissions: "auto-confirm",
        maxTurns: 20,
    },
    careful: {
        provider: "anthropic",
        permissions: "suggest",
        plan: true,
    },
    yolo: {
        provider: "openrouter",
        permissions: "full-auto",
        maxTurns: 100,
        budget: null,
    },
};
const BUILTIN_NAMES = new Set(Object.keys(BUILTIN_PRESETS));
// ── File path ───────────────────────────────────────────────────────────
const PRESETS_PATH = path.join(os.homedir(), ".phren-agent", "presets.json");
// ── File I/O ────────────────────────────────────────────────────────────
function readFile() {
    try {
        const raw = fs.readFileSync(PRESETS_PATH, "utf-8");
        return JSON.parse(raw);
    }
    catch {
        return { presets: {} };
    }
}
function writeFile(data) {
    const dir = path.dirname(PRESETS_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PRESETS_PATH, JSON.stringify(data, null, 2) + "\n");
}
// ── Public API ──────────────────────────────────────────────────────────
/** Save a user preset. Cannot overwrite built-in names. */
export function savePreset(name, config) {
    if (BUILTIN_NAMES.has(name)) {
        throw new Error(`Cannot overwrite built-in preset "${name}".`);
    }
    const data = readFile();
    data.presets[name] = config;
    writeFile(data);
}
/** Load a preset by name. Checks built-ins first, then user presets. */
export function loadPreset(name) {
    if (BUILTIN_PRESETS[name]) {
        return { ...BUILTIN_PRESETS[name] };
    }
    const data = readFile();
    const preset = data.presets[name];
    return preset ? { ...preset } : null;
}
/** Delete a user preset. Cannot delete built-in presets. */
export function deletePreset(name) {
    if (BUILTIN_NAMES.has(name)) {
        throw new Error(`Cannot delete built-in preset "${name}".`);
    }
    const data = readFile();
    if (!(name in data.presets))
        return false;
    delete data.presets[name];
    writeFile(data);
    return true;
}
/** List all presets: built-in + user. */
export function listPresets() {
    const results = [];
    for (const [name, preset] of Object.entries(BUILTIN_PRESETS)) {
        results.push({ name, preset, builtin: true });
    }
    const data = readFile();
    for (const [name, preset] of Object.entries(data.presets)) {
        results.push({ name, preset, builtin: false });
    }
    return results;
}
/** Format a preset for display. */
export function formatPreset(name, preset, builtin) {
    const parts = [];
    if (preset.provider)
        parts.push(`provider=${preset.provider}`);
    if (preset.model)
        parts.push(`model=${preset.model}`);
    if (preset.permissions)
        parts.push(`perms=${preset.permissions}`);
    if (preset.maxTurns !== undefined)
        parts.push(`turns=${preset.maxTurns}`);
    if (preset.budget !== undefined)
        parts.push(preset.budget === null ? "no-budget" : `budget=$${preset.budget}`);
    if (preset.plan)
        parts.push("plan");
    const tag = builtin ? " (built-in)" : "";
    return `${name}${tag}: ${parts.join(", ")}`;
}
