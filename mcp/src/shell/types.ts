import type { ShellState } from "../data/access.js";
import type { runDoctor } from "../link/link.js";

// Projects is level 0 (the home screen); these sub-views are level 1 (drill-down into a project)
// Health is NOT a sub-view — it's a global overlay accessible from anywhere via [h]
export const SUB_VIEWS = ["Tasks", "Findings", "Review Queue", "Skills", "Hooks"] as const;
export const TAB_ICONS: Record<string, string> = {
  Projects:      "◉",
  Tasks:         "▤",
  Findings:      "✦",
  "Review Queue": "◈",
  Skills:        "◆",
  Hooks:         "⚡",
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
  runRelink: (phrenPath: string) => Promise<string>;
  runHooks:  (phrenPath: string) => Promise<string>;
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
