import { moduleEnabled } from "../modules/runtime.js";
// Projects is level 0 (the home screen); these sub-views are level 1 (drill-down into a project)
// Health is NOT a sub-view — it's a global overlay accessible from anywhere via [h]
export const SUB_VIEWS = ["Tasks", "Findings", "Review Queue", "Skills", "Hooks"];
export const TAB_ICONS = {
    Projects: "◉",
    Tasks: "▤",
    Findings: "✦",
    "Review Queue": "◈",
    Skills: "◆",
    Hooks: "⚡",
    Health: "♡",
    Graph: "❖",
};
export const MAX_UNDO_STACK = 10;
export function enabledSubViews(store, profile) {
    return moduleEnabled(store, "tasks", profile) ? SUB_VIEWS : SUB_VIEWS.filter(view => view !== "Tasks");
}
