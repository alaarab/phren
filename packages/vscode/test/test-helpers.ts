// Shared fakes for tests under packages/vscode/test/. Not a *.test.ts file,
// so vitest's include glob (packages/vscode/test/**/*.test.ts) never treats
// this as a suite of its own — import it from test files instead.

import { vi } from "vitest";
import type { PhrenClient } from "../src/phrenClient";

/** Wraps a payload in the {ok:true, data} envelope every MCP tool call returns. */
export function ok(data: unknown): { ok: true; data: unknown } {
  return { ok: true, data };
}

/**
 * A fully-mocked PhrenClient. Every method the extension actually calls is a
 * vi.fn() with a harmless empty-ish default so tests only need to override
 * the handful of calls relevant to the behavior under test — never spawns a
 * real MCP subprocess.
 */
export function fakeClient(overrides: Record<string, unknown> = {}): PhrenClient {
  const base = {
    listProjects: vi.fn(async () => ok({ projects: [] })),
    storeList: vi.fn(async () => ok({ stores: [] })),
    getProjectSummary: vi.fn(async () => ok({ files: [] })),
    getFindings: vi.fn(async () => ok({ findings: [] })),
    getNotes: vi.fn(async () => ok({ notes: [] })),
    addNote: vi.fn(async () => ok({})),
    editNote: vi.fn(async () => ok({})),
    removeNote: vi.fn(async () => ok({})),
    promoteNote: vi.fn(async () => ok({})),
    getTasks: vi.fn(async () => ok({ items: {} })),
    getAllTasks: vi.fn(async () => ok({ projects: [] })),
    getReviewQueue: vi.fn(async () => ok({ items: [] })),
    getTruths: vi.fn(async () => ok({ truths: [] })),
    listSkills: vi.fn(async () => ok({ skills: [] })),
    listHooks: vi.fn(async () => ok({ tools: [], customHooks: [] })),
    listHookErrors: vi.fn(async () => ok({ errors: [] })),
    sessionHistory: vi.fn(async () => ok([])),
    addFinding: vi.fn(async () => ok({})),
    removeFinding: vi.fn(async () => ok({})),
    editFinding: vi.fn(async () => ok({})),
    supersedeFinding: vi.fn(async () => ok({})),
    retractFinding: vi.fn(async () => ok({})),
    resolveContradiction: vi.fn(async () => ok({})),
    pinMemory: vi.fn(async () => ok({})),
    updateTask: vi.fn(async () => ok({})),
    addTask: vi.fn(async () => ok({})),
    completeTask: vi.fn(async () => ok({})),
    removeTask: vi.fn(async () => ok({})),
    readGraph: vi.fn(async () => ok({ fragments: [] })),
    getTopicConfig: vi.fn(async () => ok({ topics: [] })),
    addProject: vi.fn(async () => ok({})),
    ...overrides,
  };
  return base as unknown as PhrenClient;
}

/** Default DeviceContext used by the readDeviceContext mock unless overridden per test. */
export function deviceContext(overrides: Partial<{ profile: string; activeProjects: Set<string>; machine: string; lastSync: string }> = {}) {
  return {
    profile: "",
    activeProjects: new Set<string>(),
    machine: "test-machine",
    lastSync: "",
    ...overrides,
  };
}
