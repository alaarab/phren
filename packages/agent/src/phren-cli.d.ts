/**
 * Type declarations for @phren/cli subpath exports consumed by the agent.
 * These match the actual function signatures the agent code calls.
 */

// biome-lint: these are ambient declarations, not unused imports

declare module "@phren/cli/paths" {
  export function findPhrenPath(startDir?: string): string | null;
  export function getProjectDirs(phrenPath: string, profile?: string): string[];
}

declare module "@phren/cli/runtime-profile" {
  export function resolveRuntimeProfile(phrenPath: string, requestedProfile?: string): string;
}

declare module "@phren/cli/shared" {
  interface PhrenDb {
    query(sql: string, params?: unknown[]): unknown[];
  }
  export function buildIndex(
    phrenPath: string,
    profileFilter?: string,
  ): Promise<PhrenDb>;
}

declare module "@phren/cli/shared/retrieval" {
  interface DocRow {
    project: string;
    filename: string;
    content?: string;
    [key: string]: unknown;
  }
  interface SearchKnowledgeRowsResult {
    safeQuery: string;
    rows: DocRow[] | null;
    usedFallback: boolean;
  }
  export function searchKnowledgeRows(
    db: unknown,
    options: {
      query: string;
      maxResults: number;
      fetchLimit?: number;
      filterProject?: string | null;
      filterType?: string | null;
      phrenPath: string;
    },
  ): Promise<SearchKnowledgeRowsResult>;
  export function rankResults(
    rows: DocRow[],
    intent: string,
    gitCtx: unknown | null,
    detectedProject: string | null,
    phrenPath: string,
    db: unknown,
    cwd?: string,
    query?: string,
    opts?: { filterType?: string | null; skipTaskFilter?: boolean },
  ): DocRow[];
}

declare module "@phren/cli/data/access" {
  interface FindingItem {
    text: string;
    line: string;
    status: string;
    tier: string;
    citation?: string;
    [key: string]: unknown;
  }
  export function readFindings(phrenPath: string, project: string, options?: Record<string, unknown>): {
    ok: boolean;
    data?: FindingItem[];
    error?: string;
  };
}

declare module "@phren/cli/data/tasks" {
  interface TaskItem {
    line: string;
    checked: boolean;
  }
  export function readTasks(phrenPath: string, project: string): {
    ok: boolean;
    data?: { items: Record<string, TaskItem[]> };
    error?: string;
  };
  export function completeTasks(phrenPath: string, project: string, items: string[]): {
    ok: boolean;
    error?: string;
  };
}

declare module "@phren/cli/shell/render-api" {
  export type MenuView =
    | "Projects" | "Tasks" | "Findings" | "Review Queue"
    | "Skills" | "Hooks" | "Health";

  export interface MenuState {
    view: MenuView;
    project?: string;
    filter?: string;
    cursor: number;
    scroll: number;
  }

  export interface MenuRenderResult {
    output: string;
    listCount: number;
  }

  export function renderMenuFrame(
    phrenPath: string,
    profile: string,
    state: MenuState,
  ): Promise<MenuRenderResult>;

  export function handleMenuKey(
    state: MenuState,
    keyName: string,
    listCount: number,
    phrenPath?: string,
    profile?: string,
  ): MenuState | null;
}

declare module "@phren/cli/core/finding" {
  export function addFinding(
    phrenPath: string,
    project: string,
    finding: string,
    citation?: { file?: string; line?: number; repo?: string; commit?: string; supersedes?: string },
    findingType?: string,
  ): { ok: boolean; message: string; data?: unknown };
}
