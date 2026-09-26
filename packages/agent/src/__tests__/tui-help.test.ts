import { PassThrough } from "node:stream";
import { render, renderToString } from "ink";
import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { App, type AppProps } from "../tui/components/App.js";
import { DARK_THEME } from "../tui/themes.js";

function props(): AppProps {
  return { state: { provider: "test", project: null, turns: 0, cost: "0", permMode: "suggest", agentCount: 0, version: "test" },
    completedMessages: [], streamingText: "", completedToolCalls: [], activeTool: null, thinking: false,
    thinkStartTime: 0, thinkElapsed: null, steerQueue: [], running: false, showBanner: false,
    inputHistory: [], verbose: false, theme: DARK_THEME, onSubmit: vi.fn(), onPermissionCycle: vi.fn(), onCancelTurn: vi.fn(), onExit: vi.fn() };
}

it("keeps wrapped assistant text aligned after its label", () => {
  const configuration = props();
  configuration.streamingText = "alpha beta gamma delta epsilon zeta eta theta";
  configuration.theme = { ...DARK_THEME, agent: { ...DARK_THEME.agent, label: "AI" } };
  const output = renderToString(createElement(App, configuration), { columns: 22 });
  expect(output).toContain("AI alpha beta gamma");
  expect(output).toMatch(/\n {3}delta epsilon zeta/);
});

it("opens help with ? and F1, preserves drafts and consumes help keys", async () => {
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = new PassThrough();
  Object.assign(stdout, { columns: 100, rows: 40, isTTY: true });
  let output = ""; stdout.on("data", chunk => { output += chunk; });
  const configuration = props();
  const instance = render(createElement(App, configuration), { stdin: stdin as NodeJS.ReadStream, stdout: stdout as NodeJS.WriteStream,
    stderr: stdout as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false, debug: true });
  const key = async (value: string) => { output = ""; stdin.write(value); await new Promise(resolve => setTimeout(resolve, 35)); await instance.waitUntilRenderFlush(); };
  try {
    await instance.waitUntilRenderFlush();
    await key("?"); expect(output).toContain("Keyboard shortcuts");
    await key("\u001b");
    await key("draft?");
    await key("\u001bOP"); expect(output).toContain("Keyboard shortcuts");
    await key("?");
    await key("\r");
    expect(configuration.onSubmit).toHaveBeenCalledWith("draft?");
    expect(configuration.onSubmit).toHaveBeenCalledTimes(1);
  } finally { instance.unmount(); await instance.waitUntilExit(); stdin.destroy(); stdout.destroy(); }
});
