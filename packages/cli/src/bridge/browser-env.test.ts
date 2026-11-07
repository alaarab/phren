import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { browserEnv, browserShimPath, runBrowser } from "./browser-env.js";

let root: string;
let output: string[];
beforeEach(() => {
  mkdirSync(".scratch", { recursive: true });
  root = mkdtempSync(path.resolve(".scratch/browser-env-"));
  vi.stubEnv("PHREN_BRIDGE_HOME", root + " ' $() ` ");
  vi.stubEnv("PHREN_BROWSER_SESSION", "");
  vi.stubEnv("HERDR_PANE_ID", "");
  vi.stubEnv("TMUX_PANE", "");
  vi.stubEnv("NODE_OPTIONS", "--trace-warnings");
  vi.stubEnv("BUN_OPTIONS", "--smol");
  output = [];
  vi.spyOn(console, "log").mockImplementation(line => { output.push(String(line)); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("browser env command", () => {
  it.each(["bash", "zsh"])("round trips hostile values through %s without executing them", async shell => {
    const session = "pane ' \" $() `touch SHOULD_NOT_EXIST` \\ with\nnewlines";
    expect(await runBrowser(["env", "--session", session])).toBe(0);
    const env = browserEnv(session);
    const script = 'eval "$PHREN_TEST_ENV_OUTPUT" || exit $?; node -e \'console.log(JSON.stringify(Object.fromEntries(["BUN_OPTIONS","NODE_OPTIONS","PHREN_BROWSER_SOCKET","PHREN_BROWSER_SESSION"].map(k=>[k,process.env[k]]))))\'';
    const flags = shell === "zsh" ? ["-f", "-i", "-c"] : ["--noprofile", "--norc", "-c"];
    const result = execFileSync(shell, [...flags, script], { env: { ...process.env, NODE_OPTIONS: "", PHREN_TEST_ENV_OUTPUT: output.join("\n") }, encoding: "utf8" });
    expect(JSON.parse(result)).toEqual(env);
    expect(env.NODE_OPTIONS).toMatch(/^--trace-warnings --require=/);
    expect(env.BUN_OPTIONS).toMatch(/^--smol --preload=/);
  });
  it("keeps installed shim paths with spaces and quotes evaluable and offers the Bun CLI fallback", async () => {
    const bridge = path.join(root, "with ' \" $() ` spaces");
    const shim = path.join(bridge, "current/bridge/browser-shim/phren-playwright.cjs");
    mkdirSync(path.dirname(shim), { recursive: true });
    copyFileSync(browserShimPath(), shim);
    vi.stubEnv("PHREN_BRIDGE_HOME", bridge);
    await runBrowser(["env"]);
    const expected = browserEnv(`manual-${process.ppid}`);
    expect(expected).not.toHaveProperty("BUN_OPTIONS");
    expect(output.join("\n")).toContain("bun --preload");
    const result = execFileSync("bash", ["-c", output.join("\n") + '\nnode -e \'console.log(process.env.PHREN_BROWSER_SESSION)\''], { env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8" });
    expect(result.trim()).toBe(`manual-${process.ppid}`);
  });
  it.skipIf(spawnSync("fish", ["--version"]).status !== 0)("emits fish statements that round trip quotes and backslashes", async () => {
    const session = "pane \\ ' $()";
    await runBrowser(["env", "--fish", "--session", session]);
    const result = execFileSync("fish", ["-c", output.join("\n") + '\nprintf %s "$PHREN_BROWSER_SESSION"'], { env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8" });
    expect(result).toBe(session);
  });
  it("emits only JSON and resolves explicit, inherited, pane and manual sessions", async () => {
    for (const [name, value] of [["manual", `manual-${process.ppid}`], ["TMUX_PANE", "%42"], ["HERDR_PANE_ID", "p7"], ["PHREN_BROWSER_SESSION", "inherited"]]) {
      if (name !== "manual") vi.stubEnv(name, value);
      await runBrowser(["env", "--json"]);
      expect(JSON.parse(output.pop()!).PHREN_BROWSER_SESSION).toBe(value);
    }
    await runBrowser(["env", "--session", "override", "--json"]);
    expect(JSON.parse(output.pop()!).PHREN_BROWSER_SESSION).toBe("override");
  });
  it("rejects invalid flags and documents eval and Bun in help", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const flags of [["--session"], ["--wat"], ["--fish", "--json"]]) expect(await runBrowser(["env", ...flags])).toBe(1);
    await runBrowser(["--help"]);
    expect(output.join("\n")).toContain('eval "$(phren browser env)"');
    expect(output.join("\n")).toContain("bun --preload");
  });
  it.skipIf(spawnSync("bun", ["--version"]).status !== 0)("checks installed Bun preload support without claiming automatic instrumentation", () => {
    const preload = path.join(root, "marker ' \" $().cjs");
    writeFileSync(preload, "globalThis.phrenPreloaded = true;");
    const script = path.join(root, "probe.cjs");
    writeFileSync(script, `console.log(JSON.stringify({preloaded:!!globalThis.phrenPreloaded, init:typeof require(${JSON.stringify(browserShimPath())}).initPage}));`);
    const result = execFileSync("bun", ["--preload", preload, script], { env: { ...process.env, NODE_OPTIONS: "", BUN_OPTIONS: "" }, encoding: "utf8" });
    expect(JSON.parse(result)).toEqual({ preloaded: true, init: "function" });
    const safePreload = path.join(root, "marker-safe.cjs");
    writeFileSync(safePreload, "globalThis.phrenPreloaded = true;");
    const bunOptions = execFileSync("bun", [script], { env: { ...process.env, NODE_OPTIONS: "", BUN_OPTIONS: `--preload=${safePreload}` }, encoding: "utf8" });
    expect(JSON.parse(bunOptions).preloaded).toBe(true);
    const nodeOptions = execFileSync("bun", [script], { env: { ...process.env, BUN_OPTIONS: "", NODE_OPTIONS: `--require=${JSON.stringify(preload)}` }, encoding: "utf8" });
    const socket = path.join(root, "browser.sock");
    writeFileSync(socket, "");
    const playwright = path.join(root, "playwright-core.cjs");
    writeFileSync(playwright, "globalThis.originalLaunch = async () => ({contexts:()=>[], on(){}}); module.exports={chromium:{launch:globalThis.originalLaunch}};");
    writeFileSync(script, `const p=require(${JSON.stringify(playwright)}); console.log(JSON.stringify({automatic:p.chromium.launch!==globalThis.originalLaunch}));`);
    const intercepted = execFileSync("bun", ["--preload", browserShimPath(), script], { env: { ...process.env, PHREN_BROWSER_SOCKET: socket, NODE_OPTIONS: "", BUN_OPTIONS: "" }, encoding: "utf8" });
    writeFileSync(script, `(async()=>{const context=async()=>({}); const browser={contexts:()=>[],on(){},newContext:context}; await require(${JSON.stringify(browserShimPath())}).initPage({page:{context:()=>({browser:()=>browser})}}); console.log(JSON.stringify({explicit:browser.newContext!==context}));})()`);
    const explicit = execFileSync("bun", [script], { env: { ...process.env, PHREN_BROWSER_SOCKET: socket, NODE_OPTIONS: "", BUN_OPTIONS: "" }, encoding: "utf8" });
    expect(JSON.parse(explicit).explicit).toBe(true);
    writeFileSync(path.resolve(".scratch/bun-verification.json"), JSON.stringify({ version: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(), nodeOptionsRequire: JSON.parse(nodeOptions).preloaded, bunOptionsPreload: JSON.parse(bunOptions).preloaded, automatic: JSON.parse(intercepted).automatic, explicitInitPage: JSON.parse(explicit).explicit }));
  });
});
