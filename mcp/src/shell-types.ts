import type { ShellState } from "./data-access.js";
import type { runDoctor } from "./link.js";

// Projects is level 0 (the home screen); these sub-views are level 1 (drill-down into a project)
// Health is NOT a sub-view — it's a global overlay accessible from anywhere via [h]
export const SUB_VIEWS = ["Backlog", "Findings", "Review Queue"] as const;
export const TAB_ICONS: Record<string, string> = {
  Projects:      "◉",
  Backlog:       "▤",
  Findings:      "✦",
  "Review Queue": "◈",
  Health:        "♡",
};

export interface UndoEntry {
  label: string;
  file: string;
  content: string;
}

export const MAX_UNDO_STACK = 10;

export type ShellView = ShellState["view"];

export interface ShellDeps {
  runDoctor: typeof runDoctor;
  runRelink: (cortexPath: string) => Promise<string>;
  runHooks:  (cortexPath: string) => Promise<string>;
  runUpdate: () => Promise<string>;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorResultLike {
  ok: boolean;
  machine?: string;
  profile?: string;
  checks: DoctorCheck[];
}
