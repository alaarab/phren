import * as fs from "fs";
import * as path from "path";
import { cortexErr, CortexError, cortexOk, type CortexResult } from "./shared.js";
import { getRuntimeHealth, withFileLock as withFileLockRaw } from "./shared-governance.js";
import { errorMessage } from "./utils.js";

function withSafeLock<T>(filePath: string, fn: () => CortexResult<T>): CortexResult<T> {
  try {
    return withFileLockRaw(filePath, fn);
  } catch (err: unknown) {
    const msg = errorMessage(err);
    if (msg.includes("could not acquire lock")) {
      return cortexErr(`Could not acquire write lock for "${path.basename(filePath)}". Another write may be in progress; please retry.`, CortexError.LOCK_TIMEOUT);
    }
    throw err;
  }
}

export interface ShellState {
  version: number;
  view: "Projects" | "Backlog" | "Findings" | "Review Queue" | "Skills" | "Hooks" | "Machines/Profiles" | "Health";
  project?: string;
  filter?: string;
  page?: number;
  perPage?: number;
}

const SHELL_STATE_VERSION = 1;

function shellStatePath(cortexPath: string): string {
  return path.join(cortexPath, ".governance", "shell-state.json");
}

export function loadShellState(cortexPath: string): ShellState {
  const file = shellStatePath(cortexPath);
  const fallback: ShellState = {
    version: SHELL_STATE_VERSION,
    view: "Projects",
    page: 1,
    perPage: 40,
  };

  if (!fs.existsSync(file)) return fallback;

  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ShellState> & { lastView?: ShellState["view"] };
    const migratedView = raw.view || raw.lastView || fallback.view;
    return {
      version: SHELL_STATE_VERSION,
      view: migratedView,
      project: raw.project,
      filter: raw.filter,
      page: Number.isFinite(raw.page) ? Number(raw.page) : fallback.page,
      perPage: Number.isFinite(raw.perPage) ? Number(raw.perPage) : fallback.perPage,
    };
  } catch (err: unknown) {
    if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] loadShellState parse: ${errorMessage(err)}\n`);
    return fallback;
  }
}

export function saveShellState(cortexPath: string, state: ShellState): void {
  const file = shellStatePath(cortexPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withSafeLock(file, () => {
    const out: ShellState = {
      version: SHELL_STATE_VERSION,
      view: state.view,
      project: state.project,
      filter: state.filter,
      page: state.page,
      perPage: state.perPage,
    };
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
    return cortexOk(undefined);
  });
}

export function resetShellState(cortexPath: string): CortexResult<string> {
  const file = shellStatePath(cortexPath);
  return withSafeLock(file, () => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return cortexOk("Shell state reset.");
  });
}

export function readRuntimeHealth(cortexPath: string) {
  return getRuntimeHealth(cortexPath);
}
