/**
 * Read-only rendering API for the shell views, consumable by external packages
 * (e.g. @phren/agent) via the "@phren/cli/shell/render-api" subpath export.
 *
 * Exposes renderMenuFrame (render a full shell view frame) and handleMenuKey
 * (pure navigation logic) without pulling in mutation or MCP dependencies.
 */
import type { ShellState } from "./state-store.js";
import { listProjectCards } from "../data/access.js";
import { renderShell, type ViewContext, type SubsectionsCache } from "./view.js";
import { getListItems } from "./input.js";
import type { DoctorResultLike } from "./types.js";

// ── Public types ────────────────────────────────────────────────────────────

export type MenuView = ShellState["view"];

export interface MenuState {
  view: MenuView;
  project?: string;
  filter?: string;
  cursor: number;
  scroll: number;
}

export interface MenuRenderResult {
  /** Full ANSI-rendered frame (multi-line string, no trailing newline) */
  output: string;
  /** Number of list items in the current view (for cursor clamping) */
  listCount: number;
}

// ── View cycling order (same as the shell tab bar) ──────────────────────────

const VIEW_ORDER: MenuView[] = [
  "Projects", "Tasks", "Findings", "Review Queue", "Skills", "Hooks",
];

// ── Render ──────────────────────────────────────────────────────────────────

/** Render a full shell frame for the given state. Read-only, no mutations. */
export async function renderMenuFrame(
  phrenPath: string,
  profile: string,
  state: MenuState,
): Promise<MenuRenderResult> {
  const shellState: ShellState = {
    version: 3,
    view: state.view,
    project: state.project,
    filter: state.filter,
  };

  const ctx: ViewContext = {
    phrenPath,
    profile,
    state: shellState,
    currentCursor: () => state.cursor,
    currentScroll: () => state.scroll,
    setScroll: () => {},
  };

  const stubDoctor: () => Promise<DoctorResultLike> = async () => ({
    ok: true,
    checks: [],
  });

  const output = await renderShell(
    ctx,
    "navigate",  // always navigate mode (no input mode in agent menu)
    "",           // no inputCtx
    "",           // no inputBuf
    false,        // no help
    "Tab: Chat  ←→: Views  ↑↓: Navigate  Enter: Select  /: Filter  Esc: Back",
    stubDoctor,
    null,         // subsectionsCache
    () => {},     // setHealthLineCount
    () => {},     // setSubsectionsCache
  );

  const listCount = getListItems(phrenPath, profile, shellState, 0).length;

  return { output, listCount };
}

// ── Navigation (pure function) ──────────────────────────────────────────────

/**
 * Apply a key to the menu state. Returns a new state, or null to signal
 * "exit menu mode" (Tab or Escape at top level).
 */
export function handleMenuKey(
  state: MenuState,
  keyName: string,
  listCount: number,
  phrenPath?: string,
  profile?: string,
): MenuState | null {
  switch (keyName) {
    // Exit menu
    case "tab":
    case "q":
      return null;

    // View cycling
    case "left": {
      const idx = VIEW_ORDER.indexOf(state.view);
      const next = idx <= 0 ? VIEW_ORDER[VIEW_ORDER.length - 1] : VIEW_ORDER[idx - 1];
      return { ...state, view: next, cursor: 0, scroll: 0, filter: undefined };
    }
    case "right": {
      const idx = VIEW_ORDER.indexOf(state.view);
      const next = idx >= VIEW_ORDER.length - 1 ? VIEW_ORDER[0] : VIEW_ORDER[idx + 1];
      return { ...state, view: next, cursor: 0, scroll: 0, filter: undefined };
    }

    // Cursor movement
    case "up":
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case "down":
      return { ...state, cursor: Math.min(Math.max(0, listCount - 1), state.cursor + 1) };

    // Enter: drill into project (Projects view only)
    case "return": {
      if (state.view === "Projects" && phrenPath && profile) {
        const cards = listProjectCards(phrenPath, profile);
        const filtered = state.filter
          ? cards.filter((c) =>
              `${c.name} ${c.summary} ${c.docs.join(" ")}`.toLowerCase().includes(state.filter!.toLowerCase()))
          : cards;
        const selected = filtered[state.cursor];
        if (selected) {
          return { ...state, view: "Tasks", project: selected.name, cursor: 0, scroll: 0 };
        }
      }
      // Escape from sub-view back to Projects
      if (state.view !== "Projects" && state.project) {
        return state; // no-op for non-projects views on enter
      }
      return state;
    }

    // Escape: clear filter, or go back to projects, or exit
    case "escape": {
      if (state.filter) return { ...state, filter: undefined, cursor: 0, scroll: 0 };
      if (state.view !== "Projects" && state.project) {
        return { ...state, view: "Projects", project: undefined, cursor: 0, scroll: 0 };
      }
      return null; // exit menu
    }

    // Health shortcut
    case "h":
      if (state.view === "Health") return { ...state, view: "Projects", cursor: 0, scroll: 0 };
      return { ...state, view: "Health", cursor: 0, scroll: 0 };

    default:
      return state;
  }
}
