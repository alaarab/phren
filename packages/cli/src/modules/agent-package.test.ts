import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentPackageAt, findAgentPackage, runAgentCommand } from "./agent-package.js";

let root: string;
const saved = process.env.PHREN_AGENT_PACKAGE;

function fakePackage(directory: string, manifest: Record<string, unknown>, script?: string): string {
  fs.mkdirSync(path.join(directory, "dist"), { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
  if (script !== undefined) fs.writeFileSync(path.join(directory, "dist", "bin.js"), script);
  return directory;
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "phren-agent-pkg-")); });
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (saved === undefined) delete process.env.PHREN_AGENT_PACKAGE; else process.env.PHREN_AGENT_PACKAGE = saved;
});

describe("the optional @phren/agent package", () => {
  it("accepts only a built @phren/agent with a phren-agent binary", () => {
    const good = fakePackage(path.join(root, "good"), { name: "@phren/agent", version: "9.9.9", bin: { "phren-agent": "dist/bin.js" } }, "");
    expect(agentPackageAt(good, "test")).toEqual({ directory: good, bin: path.join(good, "dist", "bin.js"), version: "9.9.9", source: "test" });
    expect(agentPackageAt(fakePackage(path.join(root, "other"), { name: "@phren/code", bin: { "phren-agent": "dist/bin.js" } }, ""), "test")).toBeUndefined();
    expect(agentPackageAt(fakePackage(path.join(root, "unbuilt"), { name: "@phren/agent", bin: { "phren-agent": "dist/bin.js" } }), "test")).toBeUndefined();
    expect(agentPackageAt(path.join(root, "missing"), "test")).toBeUndefined();
  });

  it("prefers an explicit PHREN_AGENT_PACKAGE", () => {
    const explicit = fakePackage(path.join(root, "explicit"), { name: "@phren/agent", bin: "dist/bin.js" }, "");
    process.env.PHREN_AGENT_PACKAGE = explicit;
    expect(findAgentPackage({ global: false })?.source).toBe("PHREN_AGENT_PACKAGE");
  });

  it("runs the agent with every argument, as phren-agent, and returns its exit code", async () => {
    const out = path.join(root, "argv.json");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), argv0: process.argv0, pane: process.env.HERDR_PANE_ID })); process.exit(3);`;
    const directory = fakePackage(path.join(root, "runner"), { name: "@phren/agent", bin: { "phren-agent": "dist/bin.js" } }, script);
    fs.writeFileSync(path.join(directory, "dist", "package.json"), JSON.stringify({ type: "commonjs" }));
    process.env.PHREN_AGENT_PACKAGE = directory;
    process.env.HERDR_PANE_ID = "p_test";
    try {
      expect(await runAgentCommand(["-i", "--help", "fix it"])).toBe(3);
    } finally { delete process.env.HERDR_PANE_ID; }
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual({ argv: ["-i", "--help", "fix it"], argv0: "phren-agent", pane: "p_test" });
  });
});
