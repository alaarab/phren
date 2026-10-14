import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scheduleProblems } from "./schedule-problems.js";
import type { Schedule } from "./schedule-format.js";

const schedule = (prompt: string): Schedule => ({
  id: "4af172ca", name: "loop", enabled: true, computer: "pj", harness: "claude", every: "cron", cron: "7 * * * *",
  prompt, createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z",
});

describe("schedule problems", () => {
  it("flags a prompt with no words in it, such as a lone '>'", async () => {
    const store = await mkdtemp(path.join(tmpdir(), "phren-sched-"));
    try {
      const run = (prompt: string) => scheduleProblems(schedule(prompt), "phren", { store, owned: false });
      expect((await run(">")).join(" ")).toContain("no words");
      expect((await run("  \n")).join(" ")).toContain("no words");
      expect((await run("Run the dev-loop skill.")).join(" ")).not.toContain("no words");
    } finally { await rm(store, { recursive: true, force: true }); }
  });
});
