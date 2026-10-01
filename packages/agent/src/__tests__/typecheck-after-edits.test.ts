import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runAgent } from "../agent-loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { createShellTool } from "../tools/shell.js";
import { detectTypecheckCommand } from "../tools/lint-test.js";
import type { LlmMessage, LlmProvider, LlmResponse } from "../providers/types.js";

vi.mock("../spinner.js", () => ({ createSpinner: () => ({ start() {}, update() {}, stop() {} }), formatTurnHeader: () => "", formatToolCall: () => "" }));
vi.mock("../checkpoint.js", () => ({ createCheckpoint: () => null }));
vi.mock("../memory/error-recovery.js", () => ({ searchErrorRecovery: vi.fn().mockResolvedValue("") }));
vi.mock("../memory/auto-capture.js", () => ({ createCaptureState: () => ({ captured: 0, hashes: new Set(), lastCaptureTime: 0 }), analyzeAndCapture: vi.fn().mockResolvedValue(0) }));

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "phren-typecheck-"));
  dirs.push(dir);
  return dir;
}

/** A command that records it ran in `ran.txt`, prints `out` and exits with `code`. */
function script(cwd: string, name: string, code: number, out = ""): string {
  const file = path.join(cwd, `${name}.cjs`);
  fs.writeFileSync(file, `require('node:fs').appendFileSync(${JSON.stringify(path.join(cwd, "ran.txt"))}, ${JSON.stringify(`${name}\n`)}); process.stdout.write(${JSON.stringify(out)}); process.exit(${code});`);
  return `node '${file}'`;
}

async function editAndCheck(cwd: string, file: string, config: { typecheckCmd?: string; testCmd?: string }) {
  const registry = new ToolRegistry();
  registry.setPermissions({ mode: "full-auto", projectRoot: cwd, allowedPaths: [], sandboxMode: "off" });
  registry.register({ name: "write_file", description: "write", input_schema: {}, async execute() { return { output: "Wrote file" }; } });
  registry.register(createShellTool(() => registry.permissionConfig));
  const requests: LlmMessage[][] = [];
  let index = 0;
  const provider: LlmProvider = {
    name: "fixture",
    async chat(_s, messages): Promise<LlmResponse> {
      requests.push(structuredClone(messages));
      if (index++ === 0) return { content: [{ type: "tool_use", id: "w1", name: "write_file", input: { path: file, content: "x" } }], stop_reason: "tool_use" };
      return { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" };
    },
  };
  await runAgent("edit", { provider, registry, systemPrompt: "t", maxTurns: 5, verbose: false, lintTestConfig: { testCmd: config.testCmd, typecheckCmd: config.typecheckCmd }, hooks: { onTextBlock() {}, onStatus() {} } });
  const ran = fs.existsSync(path.join(cwd, "ran.txt")) ? fs.readFileSync(path.join(cwd, "ran.txt"), "utf-8").trim().split("\n") : [];
  return { ran, feedback: JSON.stringify(requests[1]?.at(-1)) };
}

describe("type check after edits", () => {
  it("runs before the tests, and a type error skips the tests", async () => {
    const cwd = tmp();
    const { ran, feedback } = await editAndCheck(cwd, "src/a.ts", {
      typecheckCmd: script(cwd, "types", 1, "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'."),
      testCmd: script(cwd, "tests", 0),
    });
    expect(ran).toEqual(["types"]);
    expect(feedback).toContain("TS2322");
    expect(feedback).toContain("were not run: fix the type errors first");
  });

  it("runs the tests once the types check", async () => {
    const cwd = tmp();
    const { ran } = await editAndCheck(cwd, "src/a.ts", { typecheckCmd: script(cwd, "types", 0), testCmd: script(cwd, "tests", 0) });
    expect(ran).toEqual(["types", "tests"]);
  });

  it("skips the type check after an edit to a file it doesn't look at", async () => {
    const cwd = tmp();
    const { ran } = await editAndCheck(cwd, "README.md", { typecheckCmd: script(cwd, "types", 1), testCmd: script(cwd, "tests", 0) });
    expect(ran).toEqual(["tests"]);
  });

  it("shows the start and the end of a long failure, where test runners put the summary", async () => {
    const cwd = tmp();
    const { feedback } = await editAndCheck(cwd, "src/a.ts", { testCmd: script(cwd, "tests", 1, `FIRST ${"x".repeat(5000)} SUMMARY: 3 failed`) });
    expect(feedback).toContain("FIRST");
    expect(feedback).toContain("SUMMARY: 3 failed");
    expect(feedback).toContain("chars cut");
  });
});

describe("detectTypecheckCommand", () => {
  it("prefers a package script, then tsc where it is installed, then mypy", () => {
    const scripted = tmp();
    fs.writeFileSync(path.join(scripted, "package.json"), JSON.stringify({ scripts: { "type-check": "tsc -b" } }));
    expect(detectTypecheckCommand(scripted)).toBe("npm run type-check");

    const ts = tmp();
    fs.writeFileSync(path.join(ts, "tsconfig.json"), "{}");
    expect(detectTypecheckCommand(ts)).toBeNull(); // no local tsc: nothing cheap to run
    fs.mkdirSync(path.join(ts, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(ts, "node_modules", ".bin", "tsc"), "");
    expect(detectTypecheckCommand(ts)).toBe("npx tsc --noEmit");

    const py = tmp();
    fs.writeFileSync(path.join(py, "mypy.ini"), "[mypy]\n");
    expect(detectTypecheckCommand(py)).toBe("mypy .");
    expect(detectTypecheckCommand(tmp())).toBeNull();
  });
});
