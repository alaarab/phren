import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgent } from "../agent-loop.js";
import { ToolRegistry } from "../tools/registry.js";
import * as sandbox from "../permissions/kernel-sandbox.js";
import { createShellTool } from "../tools/shell.js";
import type { LlmProvider, LlmResponse } from "../providers/types.js";
import type { AgentToolResult } from "../tools/types.js";
import type { TurnHooks } from "../agent-loop/types.js";

vi.mock("../spinner.js", () => ({ createSpinner: () => ({ start() {}, update() {}, stop() {} }), formatTurnHeader: () => "", formatToolCall: () => "" }));
vi.mock("../checkpoint.js", () => ({ createCheckpoint: () => null }));
vi.mock("../memory/error-recovery.js", () => ({ searchErrorRecovery: vi.fn().mockResolvedValue("") }));
vi.mock("../memory/auto-capture.js", () => ({ createCaptureState: () => ({ captured: 0, hashes: new Set(), lastCaptureTime: 0 }), analyzeAndCapture: vi.fn().mockResolvedValue(0) }));

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function fixture() {
  const cwd = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "phren-post-check-"));
  dirs.push(cwd);
  const marker = path.join(cwd, "checked.txt");
  const edited = path.join(cwd, "edited.txt");
  const script = path.join(cwd, "check.cjs");
  fs.writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'checked');`);
  const command = `node '${script}'`;
  const registry = new ToolRegistry();
  registry.setPermissions({ mode: "suggest", projectRoot: cwd, allowedPaths: [], sandboxMode: "off" });
  const execute = vi.fn(async (input: Record<string, unknown>): Promise<AgentToolResult> => { fs.writeFileSync(edited, String(input.content)); return { output: "Wrote file" }; });
  registry.register({ name: "write_file", description: "fixture write", input_schema: {}, execute });
  registry.register(createShellTool(() => registry.permissionConfig));
  const ask = vi.fn().mockResolvedValue(true);
  registry.askUser = ask;
  async function run(edits = 1, hooks: TurnHooks = {}) {
    let index = 0;
    const provider: LlmProvider = {
      name: "fixture",
      async chat(): Promise<LlmResponse> {
        if (index++ < edits) return { content: [{ type: "tool_use", id: `edit-${index}`, name: "write_file", input: { path: edited, content: `edit${index}` } }], stop_reason: "tool_use" };
        return { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" };
      },
    };
    return runAgent("edit fixture", { provider, registry, systemPrompt: "test", maxTurns: 5, verbose: false,
      lintTestConfig: { lintCmd: command, testCmd: "" }, hooks: { onTextBlock() {}, onStatus() {}, ...hooks } });
  }
  return { cwd, marker, edited, script, command, registry, execute, ask, run };
}

describe("automatic post-edit checks", () => {
  it("does not run a check after an edit is denied", async () => {
    const f = fixture(); f.ask.mockResolvedValue(false); await f.run();
    expect(f.execute).not.toHaveBeenCalled();
    expect(fs.existsSync(f.marker)).toBe(false);
    expect(f.ask.mock.calls.map((call) => call[0])).toEqual(["write_file"]);
  });
  it("does not run a check after an edit fails", async () => {
    const f = fixture(); f.execute.mockResolvedValue({ output: "Edit failed", is_error: true }); await f.run();
    expect(fs.existsSync(f.marker)).toBe(false);
  });
  it("does not run a check when cancelled after a successful edit", async () => {
    const f = fixture(); const controller = new AbortController();
    await f.run(1, { signal: controller.signal, onToolEnd: () => controller.abort() });
    expect(fs.existsSync(f.edited)).toBe(true); expect(fs.existsSync(f.marker)).toBe(false);
  });
  it("asks separately for checks and does not repeat a denied check after more edits", async () => {
    const f = fixture(); f.ask.mockImplementation(async (name: string) => name === "write_file");
    const result = await f.run(2);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.ask.mock.calls.filter((call) => call[0] === "shell")).toHaveLength(1);
    expect(fs.existsSync(f.marker)).toBe(false);
    expect(JSON.stringify(result.messages)).toContain("User denied permission");
  });
  it("runs permitted checks through shell with scrubbed environment and project cwd", async () => {
    const f = fixture(); vi.stubEnv("PHREN_ASSESSMENT_SECRET", "fake-marker-only");
    fs.writeFileSync(f.script, `require('node:fs').writeFileSync(${JSON.stringify(f.marker)}, JSON.stringify({cwd:process.cwd(),secret:process.env.PHREN_ASSESSMENT_SECRET}));`);
    await f.run();
    expect(f.ask.mock.calls.map((call) => call[0])).toEqual(["write_file", "shell"]);
    expect(JSON.parse(fs.readFileSync(f.marker, "utf8"))).toEqual({ cwd: f.cwd });
  });
  it("honors required kernel sandbox refusal without launching or repeating the check", async () => {
    const f = fixture();
    f.registry.permissionConfig.sandboxMode = "require";
    const wrap = vi.spyOn(sandbox, "wrapWithSandbox").mockImplementation(() => {
      throw new sandbox.SandboxRequiredError("fixture backend unavailable");
    });
    const result = await f.run(2);
    expect(wrap).toHaveBeenCalledTimes(1);
    expect(wrap).toHaveBeenCalledWith(["bash", "-c", f.command], {
      mode: "require", workspaceRoot: f.cwd, extraWritable: [],
    });
    expect(fs.existsSync(f.marker)).toBe(false);
    expect(JSON.stringify(result.messages)).toContain("fixture backend unavailable");
  });
  it("feeds failed check output back and reruns after another permitted edit", async () => {
    const f = fixture(); fs.appendFileSync(f.script, "process.stderr.write('fixture lint failure');process.exitCode=1;");
    const result = await f.run(2);
    expect(fs.readFileSync(f.marker, "utf8")).toBe("checkedchecked");
    expect(JSON.stringify(result.messages)).toContain("fixture lint failure");
  });
  it("returns on cancellation during check approval and rejects late approval", async () => {
    const f = fixture(); const controller = new AbortController();
    let approve!: (value: boolean) => void; let prompted!: () => void;
    const pending = new Promise<void>((resolve) => { prompted = resolve; });
    f.ask.mockImplementation(async (name: string) => {
      if (name !== "shell") return true;
      prompted(); return new Promise<boolean>((resolve) => { approve = resolve; });
    });
    const run = f.run(1, { signal: controller.signal });
    await pending; controller.abort(); await run; approve(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fs.existsSync(f.marker)).toBe(false);
  });
});
