// Shared setup for the desktop smoke specs: the plain-ESM UI link, a fake Hook with the real
// daemon in front of it, and the overview frames and chat rows the specs script.
import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import type { Computer, MergedOverview, OverviewHub } from "../src/contract.js";
import { hookRequest, hookWebSocket } from "../src/hook-client.js";
import { createOverviewHub } from "../src/overview.js";
import { startServer } from "../src/server.js";
import { startFakeHook, type FakeHook, type FakeHookOptions } from "../src/testing/fake-hook.js";

export const LOCAL: Computer = { name: "This computer", local: true, server: "default" };
const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_SOURCE = path.resolve(SPEC_DIR, "../ui");
const UI_LINK = path.resolve(SPEC_DIR, "../../../packages/ui");

/** Serve `packages/ui` from the desktop UI for the specs; returns the undo. */
export function linkUi(): () => void {
  if (existsSync(UI_LINK)) return () => {};
  symlinkSync(UI_SOURCE, UI_LINK, "dir");
  return () => { try { unlinkSync(UI_LINK); } catch { /* already gone */ } };
}

export interface Harness {
  url: string;
  hook: FakeHook;
  /** Stops the daemon and the fake Hook, removes the bridge directory and restores the environment. */
  close(): Promise<void>;
}

/** A fake Hook plus the real daemon over it, in a short temp directory (a Unix socket path must stay under ~100 bytes). */
export async function startHarness(name: string, options: Omit<FakeHookOptions, "dir"> = {}): Promise<Harness> {
  const saved = { bridge: process.env.PHREN_BRIDGE_HOME, config: process.env.XDG_CONFIG_HOME };
  const undo: Array<() => unknown> = [];
  // Closes whatever has started, newest first, then restores the environment; one failing step does not skip the rest.
  const close = async () => {
    for (const step of undo.splice(0).reverse()) { try { await step(); } catch { /* keep tearing down */ } }
    for (const [key, value] of [["PHREN_BRIDGE_HOME", saved.bridge], ["XDG_CONFIG_HOME", saved.config]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  try {
    const dir = await mkdtemp(path.join(tmpdir(), `desktop-${name}-`));
    undo.push(() => rm(dir, { recursive: true, force: true }));
    process.env.PHREN_BRIDGE_HOME = dir;
    process.env.XDG_CONFIG_HOME = dir;
    const hook = await startFakeHook({ dir, ...options });
    undo.push(() => hook.close());
    const hub: OverviewHub = createOverviewHub([LOCAL], hookWebSocket);
    undo.push(() => hub.stop());
    const ready = new Promise<void>((resolve) => { hub.on("change", (merged: MergedOverview) => { if (merged.computers[0]?.overview) resolve(); }); });
    hub.start();
    await ready;
    const server = await startServer({
      port: 0, token: `desktop-${name}-token`, computers: [LOCAL], hub, hookRequest, hookWebSocket,
      attachTerminal: () => ({ write() {}, resize() {}, onData() {}, onExit() {}, kill() {} }),
    });
    undo.push(() => server.close());
    return { url: server.url, hook, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** One session row of an overview frame; `fields` override any of it. */
export function chatRow(id: string, title: string, agentStatus: string, fields: object = {}) {
  return {
    id, title, label: "phren", agent: "claude", agentStatus, lastReply: "", cwd: "/Users/you/phren",
    target: { server: "default", workspace: "1", tab: id, pane: id, source: "claude", session: id }, ...fields,
  };
}

/** An overview frame holding `children` in one group. */
export function overviewFrame(children: object[]) {
  return {
    type: "overview", kind: "overview", groups: [{ id: "1", label: "phren", children }],
    phren: { computer: { id: "test-computer", name: LOCAL.name }, version: "0.3.49",
      capabilities: { transcript: true, prompt: true, overviewStream: true } },
  };
}

/** Open the Agents section, click the sidebar row titled `title` and wait for `text` in its transcript. */
export async function openChat(page: Page, url: string, title: string, text: string) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.locator(".sb-row", { hasText: title }).first().click();
  await expect(page.locator(".ct-column")).toContainText(text);
}
