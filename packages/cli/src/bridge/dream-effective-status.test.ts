import { describe, expect, it, vi } from "vitest";
import type { EffectiveStatusInput } from "./session-activity.js";
import { nextTurn } from "./turn-records.js";

const state = vi.hoisted(() => ({ evidence: {} as EffectiveStatusInput, session: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" as string | undefined }));
vi.mock("./herdr.js", () => ({ paneChatState: async () => ({ sessionId: state.session }) }));
vi.mock("./session-evidence.js", () => ({ effectivePaneEvidence: async () => state.evidence }));
import { dreamEligibility, effectiveDreamSessions } from "./dream-schedule.js";
import { DEFAULT_DREAMING_CONFIG } from "../config/dreaming.js";

// Exercise dream admission with real turn/status resolution; expensive transcript
// enrichment is supplied at the same boundary as in the overview.
describe("dream admission uses effective status", () => {
  it("blocks unanswered prompts, children, held asks and unresolved identities despite idle snapshots", async () => {
    const now = Date.now();
    const owner = nextTurn(undefined, { event: "UserPromptSubmit", source: "claude", session: state.session!, terminal: "term", at: now })!;
    const ended = nextTurn(owner, { event: "Stop", source: "claude", session: state.session!, terminal: "term", at: now + 1 })!;
    const snapshot = { panes: [{ agent: "claude", pane_id: "p", workspace_id: "w", tab_id: "t", cwd: "/repo", agent_status: "idle" }] };
    const admission = async () => dreamEligibility({ config: { ...DEFAULT_DREAMING_CONFIG, enabled: true }, now: new Date(2026, 10, 6, 3),
      sessions: await effectiveDreamSessions("default", snapshot, () => "proj") }).eligible;
    for (const evidence of [
      { paneStatus: "idle", record: owner },
      { paneStatus: "idle", record: ended, runningChildren: 1 },
      { paneStatus: "idle", held: true },
    ]) {
      state.evidence = evidence;
      expect(await admission()).toBe(false);
    }
    state.evidence = { paneStatus: "idle", record: ended, runningChildren: 0 };
    expect(await admission()).toBe(true);
    state.session = undefined;
    expect(await admission()).toBe(false);
  });
});
