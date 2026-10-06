import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import { createShellTool, OUTPUT_HEAD_CHARS, OUTPUT_TAIL_CHARS } from "../tools/shell.js";

const posix = process.platform !== "win32";
const saved = {
  max: process.env.PHREN_AGENT_SHELL_MAX_TIMEOUT_MS,
  def: process.env.PHREN_AGENT_SHELL_TIMEOUT_MS,
};
afterEach(() => {
  if (saved.max === undefined) delete process.env.PHREN_AGENT_SHELL_MAX_TIMEOUT_MS;
  else process.env.PHREN_AGENT_SHELL_MAX_TIMEOUT_MS = saved.max;
  if (saved.def === undefined) delete process.env.PHREN_AGENT_SHELL_TIMEOUT_MS;
  else process.env.PHREN_AGENT_SHELL_TIMEOUT_MS = saved.def;
});

describe.skipIf(!posix)("shell output past 100 KB", () => {
  it("succeeds with the real exit code, keeping head and tail with a marker", async () => {
    // ~229 KB of output: the old 100 KB maxBuffer killed this and reported Exit code 1.
    const result = await createShellTool().execute({ command: "seq 1 40000; echo DONE; exit 0" });
    expect(result.is_error).toBeUndefined();
    expect(result.output.startsWith("1\n2\n3\n")).toBe(true);
    expect(result.output.endsWith("40000\nDONE")).toBe(true);
    expect(result.output).toMatch(/\[\d+ chars of output omitted\. Full output \(\d+ chars\) is in .+shell-\d+\.log/);
    expect(result.output.length).toBeLessThan(OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS + 500);

    const file = /is in (\S+?\.log)/.exec(result.output)![1];
    const full = fs.readFileSync(file, "utf-8");
    expect(full).toContain("\n20000\n");
    expect(full.trim().endsWith("DONE")).toBe(true);
  });

  it("reports a failing exit code with the tail intact", async () => {
    const result = await createShellTool().execute({ command: "seq 1 40000; echo 'FAIL: expected 2 got 3'; exit 3" });
    expect(result.is_error).toBe(true);
    expect(result.output.startsWith("Exit code 3\n")).toBe(true);
    expect(result.output.endsWith("FAIL: expected 2 got 3")).toBe(true);
  });

  it("keeps small output whole, stdout and stderr together", async () => {
    const result = await createShellTool().execute({ command: "echo out; echo err >&2; echo out2" });
    expect(result.output.split("\n").sort()).toEqual(["err", "out", "out2"]);
  });
});

describe.skipIf(!posix)("shell timeouts", () => {
  it("defaults to a 10 minute cap with the scheduler deadline just above it", () => {
    delete process.env.PHREN_AGENT_SHELL_MAX_TIMEOUT_MS;
    const tool = createShellTool();
    expect(tool.timeoutMs).toBe(605_000);
    const schema = tool.input_schema.properties as Record<string, { description: string }>;
    expect(schema.timeout.description).toContain("max: 600000");
  });

  it("the cap is configurable and clamps the requested timeout", async () => {
    process.env.PHREN_AGENT_SHELL_MAX_TIMEOUT_MS = "300";
    const started = Date.now();
    const result = await createShellTool().execute({ command: "sleep 5", timeout: 999_999 });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(result.is_error).toBe(true);
    expect(result.output).toMatch(/timed out after 300ms/);
  });

  it("a timeout kills what the command spawned, so a held pipe doesn't hang the call", async () => {
    const started = Date.now();
    const result = await createShellTool().execute({ command: "echo started; sleep 30 & wait", timeout: 300 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.is_error).toBe(true);
    expect(result.output).toContain("started");
  });

  it("an abort cancels the command", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    const result = await createShellTool().execute({ command: "sleep 30" }, abort.signal);
    expect(result.is_error).toBe(true);
    expect(result.output).toMatch(/cancelled/);
  });
});
