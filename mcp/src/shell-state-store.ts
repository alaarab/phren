import * as fs from "fs";
import * as path from "path";
import { phrenOk, type PhrenResult, shellStateFile } from "./shared.js";
import { withSafeLock } from "./shared-data-utils.js";
import { errorMessage } from "./utils.js";
import { logDebug } from "./logger.js";

export interface ShellState {
  version: number;
  view: "Projects" | "Tasks" | "Findings" | "Review Queue" | "Skills" | "Hooks" | "Machines/Profiles" | "Health";
  project?: string;
  filter?: string;
  page?: number;
  perPage?: number;
  introMode?: "always" | "once-per-version" | "off";
  introSeenVersion?: string;
}

const SHELL_STATE_VERSION = 3;
const VALID_VIEWS = new Set<ShellState["view"]>(["Projects", "Tasks", "Findings", "Review Queue", "Skills", "Hooks", "Machines/Profiles", "Health"]);

export function loadShellState(phrenPath: string): ShellState {
  const file = shellStateFile(phrenPath);
  const fallback: ShellState = {
    version: SHELL_STATE_VERSION,
    view: "Projects",
    page: 1,
    perPage: 40,
    introMode: "once-per-version",
  };

  if (!fs.existsSync(file)) return fallback;

  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ShellState>;
    const persistedView = VALID_VIEWS.has(raw.view as ShellState["view"])
      ? raw.view as ShellState["view"]
      : fallback.view;
    return {
      version: SHELL_STATE_VERSION,
      view: persistedView,
      project: raw.project,
      filter: raw.filter,
      page: Number.isFinite(raw.page) ? Number(raw.page) : fallback.page,
      perPage: Number.isFinite(raw.perPage) ? Number(raw.perPage) : fallback.perPage,
      introMode: raw.introMode === "always" || raw.introMode === "off" ? raw.introMode : "once-per-version",
      introSeenVersion: typeof raw.introSeenVersion === "string" ? raw.introSeenVersion : undefined,
    };
  } catch (err: unknown) {
    logDebug("loadShellState parse", errorMessage(err));
    return fallback;
  }
}

export function saveShellState(phrenPath: string, state: ShellState): void {
  const file = shellStateFile(phrenPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withSafeLock(file, () => {
    const out: ShellState = {
      version: SHELL_STATE_VERSION,
      view: state.view,
      project: state.project,
      filter: state.filter,
      page: state.page,
      perPage: state.perPage,
      introMode: state.introMode,
      introSeenVersion: state.introSeenVersion,
    };
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
    return phrenOk(undefined);
  });
}

export function resetShellState(phrenPath: string): PhrenResult<string> {
  const file = shellStateFile(phrenPath);
  return withSafeLock(file, () => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return phrenOk("Shell state reset.");
  });
}
