import { describe, expect, it } from "vitest";
import { runDreamEval } from "./index.js";

describe("dream eval through the real engine", () => {
  it("the scripted model's changes survive collect, prompt, validation and the record", async () => {
    const report = await runDreamEval({ model: "scripted" });
    expect(report.error).toBeUndefined();
    const failed = report.score.checks.filter(check => !check.ok).map(check => `${check.name}: ${check.detail}`);
    expect(failed).toEqual([]);
    expect(report.score.passed).toBe(report.score.total);
  }, 60_000);
});
