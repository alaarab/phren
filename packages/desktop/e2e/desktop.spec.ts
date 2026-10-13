import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Computer, MergedOverview, OverviewHub } from "../src/contract.js";
import { hookRequest, hookWebSocket } from "../src/hook-client.js";
import { createOverviewHub } from "../src/overview.js";
import { startServer } from "../src/server.js";
import { startFakeHook, type FakeHook } from "../src/testing/fake-hook.js";

const LOCAL: Computer = { name: "This computer", local: true, server: "default" };
const TOKEN = "desktop-smoke-token";

const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));
// server.ts finds its UI folder as `../../ui` from its own file: right for the
// compiled dist/src/server.js, but from the TS source it lands on packages/ui.
// Bridge the two for the in-process daemon; remove it once the run is over.
const UI_SOURCE = path.resolve(SPEC_DIR, "../ui");
const UI_LINK = path.resolve(SPEC_DIR, "../../../packages/ui");
let linkedUi = false;

function fixture(name: string): Promise<unknown> {
  return readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8").then(JSON.parse);
}

let dir: string;
let hook: FakeHook;
let hub: OverviewHub;
let closeServer: (() => Promise<void>) | undefined;
let url: string;
// What the fake Hook says about the working session's pull request checks.
let ciChecks = "pending";
const completed: string[] = [];

test.beforeAll(async () => {
  if (!existsSync(UI_LINK)) {
    symlinkSync(UI_SOURCE, UI_LINK, "dir");
    linkedUi = true;
  }

  dir = await mkdtemp(path.join(tmpdir(), "desktop-smoke-"));
  process.env.PHREN_BRIDGE_HOME = dir;

  const [overview, transcript, gitStatus, diff] = await Promise.all([
    fixture("overview.json"),
    fixture("transcript.json"),
    fixture("git-status.json"),
    fixture("diff.json"),
  ]);

  hook = await startFakeHook({
    dir,
    overviewFrames: [overview],
    transcriptFrames: transcript as unknown[],
    routes: {
      "POST /v1/git/status": () => ({ status: 200, json: gitStatus }),
      "POST /v1/diff": () => ({ status: 200, json: diff }),
      "GET /v1/transcripts/blob": () => ({ status: 200, body: TINY_PNG, contentType: "application/octet-stream" }),
      "POST /v1/git/pulls": () => ({ status: 200, json: { available: true, branch: "feat/login", pulls: [], host: { kind: "github", name: "GitHub", terms: { ref: "#" } },
        current: { number: 42, title: "Keep the session through the guard", state: "OPEN", checks: ciChecks } } }),
      "GET /v1/projects/repos": () => ({ status: 200, json: { repos: [{ name: "phren", directory: "/Users/you/phren", source: "activity", registered: true }] } }),
      "GET /v1/projects/phren/git": () => ({ status: 200, json: FORGE }),
      "GET /v1/projects/phren/tasks": (_req: unknown, _body: unknown, url: URL) => ({ status: 200, json: { project: "phren", branch: url.searchParams.get("branch"), truncated: false, tasks: [
        { id: "bid:1a2b3c4d", text: "Keep the signed-in user through feat/login's session guard", created: "2026-10-12", context: null, section: "active", match: "branch" },
      ] } }),
      "POST /v1/projects/phren/tasks/complete": (_req: unknown, body: unknown) => { completed.push((body as { id: string }).id); return { status: 200, json: { project: "phren", id: (body as { id: string }).id, status: "completed" } }; },
    },
  });

  hub = createOverviewHub([LOCAL], hookWebSocket);
  const ready = new Promise<void>((resolve) => {
    hub.on("change", (merged: MergedOverview) => { if (merged.computers[0]?.overview) resolve(); });
  });
  hub.start();
  await ready;

  const server = await startServer({
    port: 0,
    token: TOKEN,
    computers: [LOCAL],
    hub,
    hookRequest,
    hookWebSocket,
    attachTerminal: () => ({ write() {}, resize() {}, onData() {}, onExit() {}, kill() {} }),
  });
  url = server.url;
  closeServer = server.close;
});

// A gitboy-hosted project: the checked-out branch's own request and two open ones.
const FORGE = {
  project: "phren", directory: "/Users/you/phren", branch: "feat/login", available: true,
  host: { kind: "gitboy", name: "gitboy", domain: "git.example.com", webUrl: "https://git.example.com/you/phren", remote: "origin", source: "url",
    terms: { short: "PR", long: "pull request", ref: "#" }, supported: true },
  current: { number: 42, title: "Keep the session through the guard", url: "https://git.example.com/you/phren/pulls/42", head: "feat/login", base: "main", draft: false, state: "OPEN", checks: "failing",
    checkRuns: [{ name: "test", state: "failing", detail: "3 failed", url: "https://git.example.com/you/phren/actions/7" }, { name: "lint", state: "passing" }] },
  pulls: [
    { number: 42, title: "Keep the session through the guard", url: "https://git.example.com/you/phren/pulls/42", head: "feat/login", author: "you", updated: new Date(Date.now() - 3_600_000).toISOString(), checks: "failing" },
    { number: 41, title: "Faster store sync", url: "https://git.example.com/you/phren/pulls/41", head: "perf/sync", author: "you", draft: true, updated: new Date(Date.now() - 86_400_000).toISOString(), checks: "passing" },
  ],
};

const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGPYOeXLfxBmgDEAcq4NAdKXL0AAAAAASUVORK5CYII=", "base64");

test.afterAll(async () => {
  hub?.stop();
  await closeServer?.();
  await hook?.close();
  await rm(dir, { recursive: true, force: true });
  if (linkedUi) {
    try { unlinkSync(UI_LINK); } catch { /* already gone */ }
  }
  delete process.env.PHREN_BRIDGE_HOME;
});

test("sidebar, chat and changes render against the fake Hook", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click(); // the window opens on Home

  const session = page.locator(".sb-row", { hasText: "Fix login" });
  await expect(session).toBeVisible();
  await session.click();

  await expect(page.locator(".chat-title")).toHaveText("Fix login");
  await expect(page.locator(".ct-column")).toContainText("Fix the login flow");
  await expect(page.locator(".ct-column")).toContainText("On it. The session token is dropped before the guard runs.");

  await page.locator("#side .segments .segment", { hasText: "Changes" }).click();

  await expect(page.locator(".chg-name", { hasText: "app.ts" })).toBeVisible();
  await expect(page.locator(".chg-name", { hasText: "README.md" })).toBeVisible();

  await page.screenshot({ path: test.info().outputPath("desktop-smoke.png") });
});

test("home lists who needs you, and sessions open as centre tabs", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click(); // the window opens on Home
  await page.evaluate(() => localStorage.clear());

  await page.locator(".section-pill", { hasText: "Home" }).click();
  const needs = page.locator('[data-block="needs"] .home-row', { hasText: "Ship release 0.3.34" });
  await expect(needs).toBeVisible();
  await expect(page.locator('[data-block="working"] .home-row', { hasText: "Fix login" })).toBeVisible();
  await expect(page.locator("#needs-pill")).toHaveText("1 needs you");
  await expect(page.locator(".section-pill.selected")).toHaveText(/Home/);
  await page.waitForTimeout(300); // let the pill's colour transition finish
  await page.screenshot({ path: test.info().outputPath("desktop-home.png") });

  // A Home row opens its session in Agents as a tab; a second session adds a second tab.
  await needs.click();
  await expect(page.locator(".section-pill.selected")).toHaveText("Agents");
  await page.locator(".sb-row", { hasText: "Fix login" }).click();
  await expect(page.locator(".doc-tab")).toHaveCount(2);
  await expect(page.locator(".doc-tab.selected")).toContainText("Fix login");

  // Switching back keeps the first chat mounted; closing it activates the other.
  await page.locator(".doc-tab", { hasText: "Ship release" }).click();
  await expect(page.locator(".doc-tab.selected")).toContainText("Ship release");
  await expect(page.locator(".chg-name", { hasText: "app.ts" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("desktop-tabs.png") });
  await page.locator(".doc-tab.selected .doc-tab-close").click();
  await expect(page.locator(".doc-tab")).toHaveCount(1);
  await expect(page.locator(".doc-tab.selected")).toContainText("Fix login");
});

test("themes switch the phone's token sets at runtime", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click(); // the window opens on Home
  const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toUpperCase());
  await expect.poll(bg).toBe("#1E1E1E");
  await page.evaluate(async () => { const m = await import("/shell/theme.js"); await m.applyTheme("amethyst"); });
  await expect.poll(bg).toBe("#17121F");
  await page.evaluate(async () => { const m = await import("/shell/theme.js"); await m.applyTheme("midnight"); });
});

test("palette, settings and the three-segment tool panel", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click(); // the window opens on Home
  await page.evaluate(() => localStorage.clear());
  await page.locator(".sb-row", { hasText: "Fix login" }).click();

  // The right panel has exactly Changes · Files · Search; Extensions moved to Settings.
  await expect(page.locator("#side .segments .segment")).toHaveText(["Changes", "Files", "Search"]);

  // ⌘K opens the palette; typing a session title and Enter opens it.
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".palette-input")).toBeFocused();
  await page.keyboard.type("Ship release");
  await page.screenshot({ path: test.info().outputPath("desktop-palette.png") });
  await page.keyboard.press("Enter");
  await expect(page.locator(".doc-tab.selected")).toContainText("Ship release");

  // Settings: theme picker and Extensions page.
  await page.locator(".section-pill[data-section=\"settings\"]").click();
  await page.locator(".settings-tab", { hasText: "Appearance" }).click();
  await page.locator(".settings-theme", { hasText: "Slate" }).click();
  await expect(page.locator(".settings-theme.selected")).toHaveText("Slate");
  await page.waitForTimeout(300);
  await page.screenshot({ path: test.info().outputPath("desktop-settings.png") });
  await page.locator(".settings-theme", { hasText: "Charcoal" }).click();
  await page.locator(".settings-tab", { hasText: "Computers" }).click();
  await expect(page.locator(".settings-page-computers")).toContainText("This computer");
});

test("composer matches the phone's bar", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click(); // the window opens on Home
  await page.evaluate(async () => {
    const { createComposer } = await import("/chat/composer.js");
    const host = document.createElement("div");
    host.id = "composer-probe";
    host.style.cssText = "position:fixed;left:40px;bottom:40px;width:620px;z-index:999;background:var(--bg);padding:16px";
    document.body.append(host);
    const c = createComposer({ computer: "This computer", target: { server: "default", workspace: "1", tab: "1", pane: "1", source: "claude", session: "sess-fix-login" }, provider: "claude",
      onConsole() {}, onAgents() {}, onWorkers() {}, onDictate() {}, onTalk() {} });
    host.append(c.el);
    c.setStatus({ status: "working" });
    c.setCounts({ agents: 2, workers: 6 });
    c.setBackground([1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: String(i), label: `job ${i}`, state: "running" })));
  });
  await page.waitForTimeout(300);
  await page.locator("#composer-probe").screenshot({ path: test.info().outputPath("composer.png") });
});

test("the kit loads in the browser", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click(); // the window opens on Home
  const names = await page.evaluate(async () => Object.keys(await import("/vendor/kit/index.js")).length);
  expect(names).toBeGreaterThan(10);
});

test("a changed file opens as a centre diff tab", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click(); // the window opens on Home
  await page.evaluate(() => localStorage.clear());
  await page.locator(".sb-row", { hasText: "Fix login" }).click();
  await page.locator(".chg-name", { hasText: "app.ts" }).click();
  await expect(page.locator(".doc-tab", { hasText: "app.ts" })).toBeVisible();
  await expect(page.locator(".doc-tab")).toHaveCount(2);
  await page.locator(".doc-diff .monaco-editor, .doc-diff .monaco-diff-editor").first().waitFor({ timeout: 15000 }).catch(() => {});
  await expect(page.locator(".doc-diff .ed-banner")).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("diff-tab.png") });
});

test("tiles split, move and swap like Herdr panes; a session switches to its console", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click(); // the window opens on Home
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".sb-row", { hasText: "Fix login" }).click();
  await page.locator(".sb-row", { hasText: "Ship release" }).click();
  await expect(page.locator(".tile")).toHaveCount(1);

  // Split side by side, then move the active session into the new tile.
  await page.locator(".layout-btn", { hasText: "Split →" }).click();
  await expect(page.locator(".tile")).toHaveCount(2);
  await page.locator(".tile").first().locator(".doc-tab", { hasText: "Ship release" }).click();
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Shift+L");
  await expect(page.locator(".tile").nth(1).locator(".doc-tab")).toContainText(["Ship release"]);
  await expect(page.locator(".tile").first().locator(".doc-tab")).toContainText(["Fix login"]);

  // Chat <-> Console on the focused session.
  await page.locator(".tile").nth(1).locator(".session-switch .segment", { hasText: "Console" }).click();
  await expect(page.locator(".tile").nth(1).locator(".session-console")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: test.info().outputPath("tiles.png") });
  await page.locator(".tile").nth(1).locator(".session-switch .segment", { hasText: "Chat" }).click();

  // Closing the last tab of a tile collapses it.
  await page.locator(".tile").nth(1).locator(".doc-tab-close").click({ force: true });
  await expect(page.locator(".tile")).toHaveCount(1);
});

test("projects section renders", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click(); // the window opens on Home
  await page.locator(".section-pill", { hasText: "Projects" }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: test.info().outputPath("projects.png") });
  // A project's Code block: host, branch with its own request's checks, open requests.
  await page.locator(".pj-card", { hasText: "phren" }).first().click();
  const forge = page.locator(".pj-forge");
  await expect(forge).toContainText("gitboy · git.example.com");
  await expect(forge.locator(".pj-forge-branch")).toContainText("feat/login");
  await expect(forge.locator(".pj-forge-branch .pj-checks.failing")).toBeVisible();
  await expect(forge.locator(".pj-row")).toHaveCount(2);
  await expect(forge.locator(".pj-row", { hasText: "#41 Faster store sync" })).toContainText("Checks pass");
  // The open tasks naming the checkout's branch, with Done.
  const tasks = forge.locator(".bt");
  await expect(tasks).toContainText("1 task for this branch");
  await expect(tasks.locator(".bt-item")).toContainText("session guard");
  await page.screenshot({ path: test.info().outputPath("project-forge.png") });
  await tasks.getByRole("button", { name: "Done" }).click();
  await expect(tasks.locator(".bt-item.done")).toHaveCount(1);
  expect(completed).toEqual(["bid:1a2b3c4d"]);
  // Launch agent opens the shared launch sheet on this project.
  await page.getByRole("button", { name: "Launch agent" }).click();
  await expect(page.locator(".launch-title")).toHaveText("Launch an agent in phren");
  await expect(page.locator(".launch-input").first()).toHaveValue("phren");
  await page.locator(".launch-close").click();
  // Fix it on the failing request opens the launch sheet with its failures as the first prompt.
  await forge.locator(".pj-fixit").click();
  await expect(page.locator(".launch-title")).toHaveText("Fix #42");
  await expect(page.getByRole("textbox", { name: "First prompt" })).toHaveValue(/branch feat\/login[\s\S]*- test: 3 failed \(https:\/\/git\.example\.com\/you\/phren\/actions\/7\)\n\n/);
  await page.screenshot({ path: test.info().outputPath("project-fix-it.png") });
  await page.locator(".launch-close").click();
  expect(errors).toEqual([]);
});

test("the graph renderer is served", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click(); // the window opens on Home
  const ok = await page.evaluate(async () => (await fetch("/vendor/phren-graph.js")).ok);
  expect(ok).toBe(true);
});

test("using the desktop reports desk presence to the Hooks", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click(); // the window opens on Home
  await page.bringToFront();
  await page.locator(".section-pill", { hasText: "Home" }).click();
  await page.keyboard.press("Shift");
  await expect.poll(() => hook.calls.filter((c) => c.path === "/v1/push/presence").length).toBeGreaterThan(0);
  const call = hook.calls.find((c) => c.path === "/v1/push/presence");
  expect(call?.method).toBe("POST");
});

test("Enter on a focused Deny denies (it never approves)", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click(); // the window opens on Home
  const decisions: string[] = [];
  await page.route("**/v1/approvals/answer", async (route) => {
    decisions.push(JSON.parse(route.request().postData() ?? "{}").decision);
    await route.fulfill({ status: 200, contentType: "application/json", body: "{\"ok\":true}" });
  });
  await page.evaluate(async () => {
    const { renderInteractions } = await import("/chat/cards.js");
    const host = document.createElement("div");
    host.id = "card-probe";
    document.body.append(host);
    renderInteractions(host, { status: "blocked", pendingApproval: { actionId: "a1", toolName: "Bash", title: "Bash", summary: "rm -rf build" } },
      { computer: "This computer", target: { server: "default", workspace: "1", tab: "1", pane: "1", source: "claude", session: "s" }, onAnswered() {} });
  });
  const deny = page.locator("#card-probe button", { hasText: /^Deny$/ });
  await deny.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => decisions).toEqual(["deny"]);
});

test("the window opens on Home", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".section-pill.selected")).toHaveAttribute("data-section", "home");
  await expect(page).toHaveURL(/#\/home$/);
});

test("Home and Conductor agree on the running conductor", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".home-conductor-title")).toHaveText("Conductor");
  await page.locator('.section-pill[data-group="fleet"]').click();
  await expect(page.locator(".section-sub")).toHaveText(["Conductor", "Schedules", "Previews"]);
  await page.locator('.section-sub[data-section="conductor"]').click();
  await expect(page.locator(".conductor-run-title")).toHaveText("Conductor");
  await expect(page.getByText("No conductor is running")).toHaveCount(0);
});

test("back and forward walk the visited sections", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#nav-back")).toBeDisabled();
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.locator('.section-pill[data-section="review"]').click();
  await page.locator("#nav-back").click();
  await expect(page).toHaveURL(/#\/agents$/);
  await page.locator("#nav-back").click();
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.locator("#nav-back")).toBeDisabled();
  await page.locator("#nav-forward").click();
  await expect(page).toHaveURL(/#\/agents$/);
});

test("an image in a transcript shows as a thumbnail that opens full size", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.locator(".sb-row", { hasText: "Fix login" }).first().click();
  const thumb = page.locator(".ct-image.loaded img");
  await expect(thumb).toBeVisible();
  await thumb.click();
  await expect(page.locator(".ct-lightbox img")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".ct-lightbox")).toHaveCount(0);
});

test("CI watch notifies once when the working session's pull request checks fail", async ({ page }) => {
  ciChecks = "pending";
  await page.clock.install();
  // The Electron preload's shell, recording notifications.
  await page.addInitScript(() => {
    const notes: string[][] = [];
    Object.assign(window, { __notes: notes, phrenDesktop: { notify: (title: string, body: string) => notes.push([title, body]), setBadge() {} } });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator(".sb-row", { hasText: "Fix login" })).toBeVisible();
  const pullCalls = () => hook.calls.filter((c) => c.path === "/v1/git/pulls").length;
  const notes = () => page.evaluate(() => (window as unknown as { __notes: string[][] }).__notes);
  // One tick with the session loaded sees the checks pending: the baseline, no notice.
  let before = pullCalls();
  await page.clock.fastForward(121_000);
  await expect.poll(pullCalls).toBeGreaterThan(before);
  await page.waitForTimeout(300); // that tick's reply lands
  expect(await notes()).toEqual([]);
  ciChecks = "failing";
  await page.clock.fastForward(121_000);
  await expect.poll(notes).toEqual([["phren: checks failed", "#42 Keep the session through the guard \u00b7 This computer"]]);
  // No change, no second notification.
  before = pullCalls();
  await page.clock.fastForward(121_000);
  await expect.poll(pullCalls).toBeGreaterThan(before);
  await page.waitForTimeout(300);
  expect(await notes()).toHaveLength(1);
});

test("the summon hotkey is set in Settings › Keys and opens ⌘K when it fires", async ({ page }) => {
  // The Electron preload's shell: records the accelerators it is asked to register.
  await page.addInitScript(() => {
    const keys: string[] = [];
    const shell = {
      platform: "darwin", notify() {}, setBadge() {},
      setSummonKey: async (accel: string) => { keys.push(accel); return accel !== "CommandOrControl+Alt+T"; },
      onSummon: (fn: () => void) => { Object.assign(window, { __summon: fn }); },
    };
    Object.assign(window, { __keys: keys, phrenDesktop: shell });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.removeItem("phren.desktop.summon"));
  await page.reload({ waitUntil: "domcontentloaded" });
  const keys = () => page.evaluate(() => (window as unknown as { __keys: string[] }).__keys);
  await expect.poll(keys).toEqual(["CommandOrControl+Shift+Space"]);

  await page.locator('.section-pill[data-section="settings"]').click();
  await page.locator(".settings-tab", { hasText: "Keys" }).click();
  const key = page.locator(".settings-summon-key");
  await expect(key).toHaveText("⌘⇧Space");
  await page.locator(".settings-summon").screenshot({ path: test.info().outputPath("desktop-summon.png") });

  // Record a new key; one the system refuses is reported.
  await key.click();
  await expect(key).toHaveText("Press a shortcut…");
  await page.keyboard.press("Meta+Alt+KeyT");
  await expect(page.locator(".settings-summon .settings-notice")).toContainText("taken by another app");
  await key.click();
  await page.keyboard.press("Meta+Shift+KeyP");
  await expect(key).toHaveText("⌘⇧P");
  await expect(page.locator(".settings-summon .settings-notice")).toBeHidden();
  expect((await keys()).at(-1)).toBe("CommandOrControl+Shift+P");

  // The shell reports the key: the palette opens.
  await page.evaluate(() => (window as unknown as { __summon: () => void }).__summon());
  await expect(page.locator(".palette-input")).toBeFocused();
  await page.evaluate(() => localStorage.removeItem("phren.desktop.summon"));
});

test("the menu bar icon lists who needs you and opens the one chosen", async ({ page }) => {
  // The Electron preload's shell: records what the icon is told to draw.
  await page.addInitScript(() => {
    const trays: unknown[] = [];
    const shell = {
      platform: "darwin", notify() {}, setBadge() {},
      setTray: (state: unknown) => { trays.push(state); },
      onOpenSession: (fn: (key: string) => void) => { Object.assign(window, { __openSession: fn }); },
    };
    Object.assign(window, { __trays: trays, phrenDesktop: shell });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.removeItem("phren.desktop.tray"));
  type Tray = { enabled: boolean; rows?: Array<{ key: string; title: string; sub: string }> };
  const last = () => page.evaluate(() => (window as unknown as { __trays: Tray[] }).__trays.at(-1));
  await expect.poll(async () => (await last())?.rows?.map((r) => r.title)).toEqual([expect.stringContaining("Ship release 0.3.34")]);
  const { key, sub } = (await last())!.rows![0];
  expect(sub).toBe("This computer · wants approval");

  // Choosing the row opens that session.
  await page.evaluate((k) => (window as unknown as { __openSession: (k: string) => void }).__openSession(k), key);
  await expect(page.locator(".section-pill.selected")).toHaveText("Agents");
  await expect(page.locator(".doc-tab.selected")).toContainText("Ship release");

  // Settings › Notifications turns it off.
  await page.locator('.section-pill[data-section="settings"]').click();
  await page.locator(".settings-tab", { hasText: "Notifications" }).click();
  const toggle = page.locator(".settings-toggle", { hasText: "menu bar" });
  await expect(toggle.locator("input")).toBeChecked();
  await page.locator(".settings-page-notifications .settings-list").screenshot({ path: test.info().outputPath("desktop-tray-setting.png") });
  await toggle.click();
  await expect.poll(last).toEqual({ enabled: false });
  await page.evaluate(() => localStorage.removeItem("phren.desktop.tray"));
});

test("a reply typed into a notification reaches the session as its next prompt", async ({ page }) => {
  await page.addInitScript(() => {
    const notes: unknown[] = [];
    const shell = {
      platform: "darwin", setBadge() {}, setTray() {},
      notify: (...args: unknown[]) => { notes.push(args); },
      onOpenSession() {},
      onReply: (fn: (r: { key: string; text: string }) => void) => { Object.assign(window, { __reply: fn }); },
    };
    Object.assign(window, { __notes: notes, phrenDesktop: shell });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator(".sb-row", { hasText: "Fix login" })).toBeVisible();
  const key = "This computer/sess-fix-login";
  const before = hook.calls.filter((c) => c.path === "/v1/prompt").length;
  await page.evaluate((k) => (window as unknown as { __reply: (r: { key: string; text: string }) => void }).__reply({ key: k, text: "yes, ship it" }), key);
  await expect.poll(() => hook.calls.filter((c) => c.path === "/v1/prompt").length).toBe(before + 1);
  expect(hook.calls.filter((c) => c.path === "/v1/prompt").at(-1)!.body).toMatchObject({ target: { session: "sess-fix-login" }, text: "yes, ship it" });

  // A session that is gone is reported, not dropped.
  await page.evaluate(() => (window as unknown as { __reply: (r: { key: string; text: string }) => void }).__reply({ key: "nowhere/0", text: "hi" }));
  await expect.poll(() => page.evaluate(() => (window as unknown as { __notes: unknown[][] }).__notes.at(-1))).toEqual(["Reply not sent", "That session is gone."]);
});
