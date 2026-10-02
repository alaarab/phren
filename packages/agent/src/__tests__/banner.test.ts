import * as os from "node:os";
import { renderToString } from "ink";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Banner } from "../tui/components/Banner.js";
import type { AppState } from "../tui/components/App.js";

const state: AppState = { provider: "test", project: null, turns: 0, cost: "0", permMode: "suggest", agentCount: 0, version: "1.2.3" };

afterEach(() => { vi.restoreAllMocks(); });

it("shows the folder for an agent and hides it for a quick chat in the store", () => {
  vi.spyOn(process, "cwd").mockReturnValue(`${os.homedir()}/.phren`);
  expect(renderToString(createElement(Banner, { state }))).toContain("~/.phren");
  const chat = renderToString(createElement(Banner, { state: { ...state, chat: true } }));
  expect(chat).toContain("phren v1.2.3");
  expect(chat).not.toContain(".phren");
});
