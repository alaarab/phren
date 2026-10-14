import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM UI module
import { stateChip } from "../ui/shell/returns.js";

// Both Conductor and Review use these labels and classes for Hook return states.
describe("dispatch return chips", () => {
  it.each([
    ["done", "done", "done"], ["needs-you", "needs you", "needs"],
    ["blocked", "blocked", "needs"], ["stalled", "stalled", "needs"],
    ["failed", "failed", "failed"], ["gone", "gone", "gone"],
    ["working", "working", "working"], ["launching", "launching", "working"],
    ["sending", "sending", "working"], ["accepted", "accepted", "working"],
    ["uncertain", "uncertain", "needs"], ["idle", "idle", ""], ["closed", "closed", "gone"],
    ["future-state", "future-state", ""], [undefined, "unknown", ""], [null, "unknown", ""],
  ])("shows %s as %s with class %s", (state, label, cls) => {
    expect(stateChip(state)).toEqual({ label, cls });
  });
});
