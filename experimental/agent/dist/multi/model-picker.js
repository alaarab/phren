import { getBuiltinModels, normalizeProviderId, REASONING_LEVELS } from "../models.js";
const ESC = "\x1b[";
const s = {
    bold: (t) => `${ESC}1m${t}${ESC}0m`,
    dim: (t) => `${ESC}2m${t}${ESC}0m`,
    cyan: (t) => `${ESC}36m${t}${ESC}0m`,
    green: (t) => `${ESC}32m${t}${ESC}0m`,
    yellow: (t) => `${ESC}33m${t}${ESC}0m`,
    magenta: (t) => `${ESC}35m${t}${ESC}0m`,
    gray: (t) => `${ESC}90m${t}${ESC}0m`,
};
/** Models available per provider. Extend as needed. */
export function getAvailableModels(provider, currentModel) {
    const normalizedProvider = normalizeProviderId(provider) ?? "openrouter";
    const models = getBuiltinModels(normalizedProvider).map((model) => ({
        id: model.id,
        provider: model.provider,
        label: model.label,
        reasoning: model.reasoningDefault,
        reasoningRange: [...model.reasoningRange],
        contextWindow: model.contextWindow,
    }));
    // If user has a custom model not in the list, add it
    if (currentModel && !models.some((m) => m.id === currentModel)) {
        models.unshift({
            id: currentModel,
            provider: provider,
            label: currentModel,
            reasoning: null,
            reasoningRange: [],
            contextWindow: 200_000,
        });
    }
    return models;
}
// ── Reasoning meter rendering ───────────────────────────────────────────────
function renderReasoningMeter(level, range) {
    if (range.length === 0 || level === null)
        return s.dim("─────");
    const maxSlots = 5;
    const levelIdx = REASONING_LEVELS.indexOf(level);
    const filled = levelIdx < 0 ? 0 : Math.min(levelIdx + 1, maxSlots);
    let meter = "";
    for (let i = 0; i < maxSlots; i++) {
        meter += i < filled ? "●" : "○";
    }
    const color = filled >= 4 ? s.magenta : filled >= 3 ? s.yellow : filled >= 2 ? s.green : s.cyan;
    const label = level ?? "n/a";
    return `${color(meter)} ${s.dim(label)}`;
}
/**
 * Show interactive model picker. Returns selected model + reasoning, or null on cancel.
 * Works in raw mode — caller must be in raw mode already (TUI) or we'll set it.
 */
export function showModelPicker(provider, currentModel, currentReasoning, w) {
    const models = getAvailableModels(provider, currentModel);
    if (models.length === 0) {
        w.write(s.dim("  No models available for this provider.\n"));
        return Promise.resolve(null);
    }
    let cursor = models.findIndex((m) => m.id === currentModel);
    if (cursor < 0)
        cursor = 0;
    // Clone reasoning levels so we can adjust them
    const reasoningState = models.map((m) => m.id === currentModel ? currentReasoning ?? m.reasoning : m.reasoning);
    function render() {
        // Clear previous render (move up by model count + header + footer + blank)
        const totalLines = models.length + 4;
        w.write(`${ESC}${totalLines}A${ESC}J`);
        drawPicker();
    }
    function drawPicker() {
        const maxLabel = Math.max(...models.map((m) => m.label.length));
        w.write(`\n  ${s.bold("Select model")} ${s.dim("(↑↓ navigate, ←→ reasoning, enter select, esc cancel)")}\n\n`);
        for (let i = 0; i < models.length; i++) {
            const m = models[i];
            const selected = i === cursor;
            const arrow = selected ? s.cyan("▸") : " ";
            const padded = m.label + " ".repeat(maxLabel - m.label.length);
            const labelStr = selected ? s.bold(padded) : s.dim(padded);
            const meter = renderReasoningMeter(reasoningState[i], m.reasoningRange);
            const ctx = s.dim(`${(m.contextWindow / 1000).toFixed(0)}k`);
            w.write(`  ${arrow} ${labelStr}  ${meter}  ${ctx}\n`);
        }
        w.write(`\n`);
    }
    // Initial draw
    drawPicker();
    return new Promise((resolve) => {
        function onKey(_ch, key) {
            if (!key)
                return;
            if (key.name === "escape" || (key.ctrl && key.name === "c")) {
                cleanup();
                resolve(null);
                return;
            }
            if (key.name === "return") {
                const m = models[cursor];
                cleanup();
                resolve({ model: m.id, reasoning: reasoningState[cursor] });
                return;
            }
            if (key.name === "up") {
                cursor = (cursor - 1 + models.length) % models.length;
                render();
                return;
            }
            if (key.name === "down") {
                cursor = (cursor + 1) % models.length;
                render();
                return;
            }
            // Left/Right: adjust reasoning level
            if (key.name === "left" || key.name === "right") {
                const m = models[cursor];
                if (m.reasoningRange.length === 0)
                    return; // no reasoning for this model
                const current = reasoningState[cursor];
                const idx = current ? REASONING_LEVELS.indexOf(current) : -1;
                const rangeIndices = m.reasoningRange.map((r) => REASONING_LEVELS.indexOf(r));
                if (key.name === "right") {
                    // Go higher
                    const next = rangeIndices.find((ri) => ri > idx);
                    if (next !== undefined)
                        reasoningState[cursor] = REASONING_LEVELS[next];
                }
                else {
                    // Go lower
                    const prev = [...rangeIndices].reverse().find((ri) => ri < idx);
                    if (prev !== undefined)
                        reasoningState[cursor] = REASONING_LEVELS[prev];
                }
                render();
                return;
            }
        }
        function cleanup() {
            process.stdin.removeListener("keypress", onKey);
        }
        process.stdin.on("keypress", onKey);
    });
}
