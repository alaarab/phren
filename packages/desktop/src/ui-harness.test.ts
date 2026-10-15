import { expect, it } from "vitest";
import { agentLabel, harnessLabel } from "../ui/harness.js";

// One display-name map now serves chat, schedules, launch, hand-off and Switch;
// each surface depended on its own copy's casing and fallback before the merge.
it("names every known harness the same way on every surface", () => {
  expect(["claude", "codex", "copilot", "opencode", "phren"].map((source) => harnessLabel(source)))
    .toEqual(["Claude", "Codex", "Copilot", "OpenCode", "Phren"]);
  expect(["CLAUDE", "Codex", " opencode"].map(agentLabel)).toEqual(["Claude", "Codex", "Agent"]);
});

it("keeps an unknown schedule or launch harness as written, and an unknown chat source as Agent", () => {
  expect(harnessLabel("gemini")).toBe("gemini");
  expect(harnessLabel(undefined, "agent")).toBe("agent");
  for (const source of [undefined, null, "", "gemini"]) expect(agentLabel(source)).toBe("Agent");
});
