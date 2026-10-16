import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type WebSocketRoute } from "@playwright/test";
import type { Computer, MergedOverview, OverviewHub } from "../src/contract.js";
import { hookRequest, hookWebSocket } from "../src/hook-client.js";
import { createOverviewHub } from "../src/overview.js";
import { startServer } from "../src/server.js";
import { SAMPLE_FINDING, SAMPLE_STALE_FINDINGS, startFakeHook, type FakeHook } from "../src/testing/fake-hook.js";

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

test("queued chat stays pending through cancellation and recovers on a late delivered receipt", async ({ page }) => {
  let deliveryId = "";
  await page.route("**/v1/prompt", async (route) => {
    deliveryId = route.request().postDataJSON().deliveryId;
    await route.fulfill({ json: { state: "queued" } });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.locator(".sb-row", { hasText: "Fix login" }).first().click();
  await expect(page.locator(".ct-column")).toContainText("Fix the login flow");
  await page.locator(".pc-input").fill("Next review step");
  await page.locator(".pc-input").press("Enter");
  await expect(page.locator(".pc-pending-state")).toHaveText("Queued");
  const raw = { type: "user", message: { role: "user", content: "Next review step" } };
  hook.pushTranscript(undefined, { type: "append", totalLines: 21, entries: [{ line: 20, raw: { ...raw, phrenQueued: true } }] });
  // Seeing the queued transcript bubble proves the frame was rendered.
  await expect(page.locator(".ct-user-bubble", { hasText: "Next review step" })).toHaveCount(2);
  await expect(page.locator(".pc-pending-state")).toHaveText("Queued");
  hook.pushTranscript(undefined, { type: "delivery", deliveryId, state: "failed", reason: "Cancelled before consumption" });
  await expect(page.locator(".pc-pending-state")).toHaveText("Failed: Cancelled before consumption");
  hook.pushTranscript(undefined, { type: "append", totalLines: 22, entries: [{ line: 21, raw: { ...raw, message: { role: "user", content: "Harness prefix: Next review step" } } }] });
  await expect(page.locator(".ct-column")).toContainText("Harness prefix: Next review step");
  hook.pushTranscript(undefined, { type: "delivery", deliveryId, state: "delivered" });
  await expect(page.locator(".pc-pending")).toBeHidden();
  await expect(page.locator(".ct-pending")).toHaveCount(0);
});

test("a queued row and its real turn settle only one repeated chat submission", async ({ page }) => {
  await page.route("**/v1/prompt", route => route.fulfill({ json: { state: "queued" } }));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.locator(".sb-row", { hasText: "Fix login" }).first().click();
  await expect(page.locator(".ct-column")).toContainText("Fix the login flow");
  for (let i = 0; i < 2; i++) {
    await page.locator(".pc-input").fill("Repeat review");
    await page.locator(".pc-input").press("Enter");
    await expect(page.locator(".pc-pending-state.queued")).toHaveCount(i + 1);
  }
  const raw = { type: "user", message: { role: "user", content: "Repeat review" } };
  hook.pushTranscript(undefined, { type: "append", totalLines: 21, entries: [{ line: 20, raw: { ...raw, phrenQueued: true } }] });
  await expect(page.locator(".ct-user-bubble", { hasText: "Repeat review" })).toHaveCount(3);
  await expect(page.locator(".pc-pending-row")).toHaveCount(2);
  hook.pushTranscript(undefined, { type: "append", totalLines: 22, entries: [{ line: 21, raw: { ...raw, message: { role: "user", content: "  Repeat\nreview  " } } }] });
  await expect(page.locator(".pc-pending-row")).toHaveCount(1);
  await expect(page.locator(".ct-pending")).toHaveCount(1);
  hook.pushTranscript(undefined, { type: "append", totalLines: 23, entries: [{ line: 22, raw }] });
  await expect(page.locator(".pc-pending")).toBeHidden();
  await expect(page.locator(".ct-pending")).toHaveCount(0);
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
  await page.keyboard.press("ControlOrMeta+k");
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
  // New agent opens the shared launch sheet on this project.
  await page.getByRole("button", { name: "New agent" }).click();
  await expect(page.locator(".launch-title")).toHaveText("New agent in phren");
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

for (const source of ["claude", "opencode"]) {
  test(`${source} terminal questions appear in chat and accept choices and typed answers`, async ({ page }) => {
    const overview = await fixture("overview.json") as any;
    const child = overview.groups[0].children[0];
    child.agent = source;
    child.target.source = source;
    overview.groups[0].children = [child];
    await page.routeWebSocket("**/api/overview", (ws) => {
      ws.send(JSON.stringify({ type: "overview", merged: { computers: [{ computer: "This computer", state: "online", overview }] } }));
    });
    let statusSocket: WebSocketRoute | undefined;
    await page.routeWebSocket("**/v1/status?**", (ws) => {
      statusSocket = ws;
      ws.send(JSON.stringify({ agentStatus: { status: "working" } }));
    });
    const posted: unknown[] = [];
    await page.route("**/v1/questions/answer", async (route) => {
      posted.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto(`${url}#/agents`, { waitUntil: "domcontentloaded" });
    await page.locator(".sb-row", { hasText: "Fix login" }).click();
    await expect.poll(() => !!statusSocket).toBe(true);
    const questions = [{ question: "Red or blue?", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] }];
    const sendStatus = (terminalPrompt?: unknown) => statusSocket!.send(JSON.stringify({
      agentStatus: { status: "waiting", terminalPrompt },
    }));
    const prompt = { toolName: "AskUserQuestion", questions, questionIndex: 0 };
    const card = page.locator(".interaction-card.question");
    sendStatus(prompt);
    await expect(card).toContainText("Red or blue?");
    await card.getByRole("button", { name: "Blue", exact: true }).click();
    await card.getByRole("button", { name: "Send answer" }).click();
    await expect(card).toContainText("Answer sent");
    sendStatus();
    await expect(card).toHaveCount(0);
    sendStatus(prompt);
    await card.getByRole("textbox").fill("Green");
    sendStatus({ ...prompt, at: new Date().toISOString() });
    await expect(card.getByRole("textbox")).toHaveValue("Green");
    await card.getByRole("button", { name: "Send answer" }).click();
    await expect(card).toContainText("Answer sent");
    const base = { target: child.target, questions: [{ question: "Red or blue?", multiSelect: false, options: ["Red", "Blue"] }] };
    expect(posted).toEqual([
      { ...base, answers: [{ optionIndexes: [1] }] },
      { ...base, answers: [{ optionIndexes: [], text: "Green" }] },
    ]);
  });
}

test("the window opens on Home", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".section-pill.selected")).toHaveAttribute("data-section", "home");
  await expect(page).toHaveURL(/#\/home$/);
});

test("Home's Saved today card lists today's findings and tasks and each row opens its section", async ({ page }) => {
  await page.route("**/api/memory/*/projects", route => route.fulfill({ json: { projects: [{ name: "phren", findings: 2 }, { name: "website", findings: 2 }] } }));
  await page.route("**/api/memory/*/findings?*", route => route.fulfill({ json: { items: [
    { id: "fid:phren-today", text: "[pitfall] Sample finding saved today: the Hook caps findings at 500 per project.", date: "2026-01-01" },
  ] } }));
  const memoryReads: string[] = [];
  page.on("request", (request) => { if (/\/v1\/projects\/[^/]+\/memory$/.test(new URL(request.url()).pathname)) memoryReads.push(request.url()); });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const card = page.locator('[data-block="saved-today"]');
  await expect(card.locator(".home-saved-row")).toHaveCount(4);
  // Tasks carry a time and lead, newest first; findings (date only) follow.
  const rows = card.locator(".home-saved-row");
  await expect(rows.nth(0)).toContainText("tidy the release checklist");
  await expect(rows.nth(0)).toContainText(/task.*phren.*12 min ago/);
  await expect(rows.nth(1)).toContainText("compress the hero image");
  await expect(rows.nth(2)).toContainText(/finding.*today/);
  await expect(card.locator(".home-more")).toBeHidden();
  // One memory read per project, not per render or poll.
  expect(memoryReads).toHaveLength(2);

  // A cold Tasks section (never opened) lands on the task's project and row.
  await rows.filter({ hasText: "compress the hero image" }).click();
  await expect(page).toHaveURL(/#\/tasks$/);
  await expect(page.locator(".tasks-project.selected")).toContainText("website");
  await expect(page.locator(".tasks-row.selected")).toContainText("compress the hero image");

  await page.locator(".section-pill", { hasText: "Home" }).click();
  await expect(rows).toHaveCount(4);
  await rows.filter({ hasText: "caps findings at 500" }).click();
  await expect(page).toHaveURL(/#\/memory$/);
  await expect(page.locator(".mem-row", { hasText: "caps findings at 500" })).toBeVisible();

  // Showing Home again inside the five minute window does not read memory again.
  await page.locator(".section-pill", { hasText: "Home" }).click();
  await expect(rows).toHaveCount(4);
  expect(memoryReads).toHaveLength(2);
});

test("Home's Saved today card says so when every read fails", async ({ page }) => {
  await page.route("**/v1/projects/*/memory", route => route.fulfill({ status: 500, json: { error: "boom" } }));
  await page.route("**/v1/tasks?*", route => route.fulfill({ status: 500, json: { error: "boom" } }));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-block="saved-today"] .home-empty')).toHaveText("Couldn't read what was saved today.");
});

test("Home reads and handles keys only while shown, including a hidden first mount", async ({ page }) => {
  let receipts = 0;
  let schedules = 0;
  await page.route("**/v1/dispatch", async (route) => {
    receipts++;
    await route.fulfill({ json: { dispatches: [] } });
  });
  await page.route("**/v1/schedules", async (route) => {
    schedules++;
    await route.fulfill({ json: { schedules: [] } });
  });
  await page.clock.install();
  await page.goto(`${url}#/agents`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".sb-row", { hasText: "Ship release" })).toBeVisible();
  await page.evaluate(async () => {
    const sections = await import("/shell/sections.js");
    sections.sectionHandle("home");
  });
  await page.clock.fastForward(65_000);
  expect({ receipts, schedules }).toEqual({ receipts: 0, schedules: 0 });
  // Hidden Home must not consume the keyboard's open-session shortcut.
  const consumed = await page.evaluate(() => !document.dispatchEvent(new KeyboardEvent("keydown", { key: "o", bubbles: true, cancelable: true })));
  expect(consumed).toBe(false);
  await page.locator('.section-pill[data-section="home"]').click();
  await expect.poll(() => ({ receipts, schedules })).toEqual({ receipts: 1, schedules: 1 });
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.clock.fastForward(65_000);
  expect({ receipts, schedules }).toEqual({ receipts: 1, schedules: 1 });
  await page.locator('.section-pill[data-section="home"]').click();
  await expect.poll(() => ({ receipts, schedules })).toEqual({ receipts: 2, schedules: 2 });
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
  let cachedFrame: { merged: { computers: Array<{ state: string }> } };
  let showOffline!: () => void;
  let offline = false;
  await page.routeWebSocket("**/api/overview", (socket) => {
    const server = socket.connectToServer();
    server.onMessage((data) => {
      const frame = JSON.parse(String(data));
      cachedFrame = frame;
      if (offline) for (const computer of frame.merged.computers) computer.state = "offline";
      socket.send(JSON.stringify(frame));
    });
    showOffline = () => {
      offline = true;
      for (const computer of cachedFrame.merged.computers) computer.state = "offline";
      socket.send(JSON.stringify(cachedFrame));
    };
  });
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

  // A notification/tray click still opens the cached session after disconnect.
  showOffline();
  await expect(page.locator("#needs-pill")).toHaveText("0 need you");
  await page.evaluate((k) => (window as unknown as { __openSession: (k: string) => void }).__openSession(k), key);
  await expect(page.locator(".section-pill.selected")).toHaveText("Agents");
  await expect(page.locator(".doc-tab.selected")).toContainText("Ship release");

  // Settings › Notifications turns it off.
  await page.locator('.section-pill[data-section="settings"]').click();
  await page.locator(".settings-tab", { hasText: "Notifications" }).click();
  const toggle = page.locator(".settings-toggle", { hasText: "menu bar" });
  await expect(toggle.locator("input")).toBeChecked();
  await page.locator(".settings-page-notifications").screenshot({ path: test.info().outputPath("desktop-tray-setting.png") });
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
  const overview = await fixture("overview.json") as { groups: Array<{ children: Array<Record<string, unknown>> }> };
  const waiting = structuredClone(overview);
  const child = waiting.groups[0].children[0];
  Object.assign(child, { agentStatus: "waiting", sessionId: "A", lastReply: "Use Authorization: Bearer banner-secret. Tests pass." });
  const notes = () => page.evaluate(() => (window as unknown as { __notes: unknown[][] }).__notes);
  try {
    hook.pushOverview(waiting);
    await expect.poll(notes).toContainEqual(["phren needs you", expect.stringMatching(/Authorization: \[redacted\] Tests pass\./), expect.objectContaining({ reply: true, binding: expect.any(Object) })]);
    const notice = (await notes()).find((note) => (note[2] as { reply?: boolean })?.reply)!;
    expect(notice[1]).not.toContain("banner-secret");
    const opts = notice[2] as { key: string; binding: unknown };
    const reply = (value: unknown) => page.evaluate((r) => (window as unknown as { __reply: (r: unknown) => void }).__reply(r), value);
    const before = hook.calls.filter((c) => c.path === "/v1/prompt").length;
    await reply({ ...opts, text: "yes, ship it" });
    await expect.poll(() => hook.calls.filter((c) => c.path === "/v1/prompt").length).toBe(before + 1);
    expect(hook.calls.filter((c) => c.path === "/v1/prompt").at(-1)!.body).toMatchObject({ target: { session: "sess-fix-login" }, text: "yes, ship it" });

    // Restart the conversation in the same tab, keeping the old banner alive.
    const restarted = structuredClone(waiting);
    Object.assign(restarted.groups[0].children[0], { sessionId: "B", target: { ...(child.target as object), session: "replacement" }, title: "Restarted login" });
    hook.pushOverview(restarted);
    await expect(page.locator(".sb-row", { hasText: "Restarted login" })).toBeVisible();
    await reply({ ...opts, text: "old reply" });
    await expect.poll(notes).toContainEqual(["Reply not sent", "That session has changed. Open it to reply."]);
    expect(hook.calls.filter((c) => c.path === "/v1/prompt")).toHaveLength(before + 1);
    await reply({ key: "nowhere/0", text: "hi", binding: opts.binding });
    await expect.poll(notes).toContainEqual(["Reply not sent", "That session is gone."]);
  } finally {
    hook.pushOverview(overview);
  }
});

test("Home lists the turns that ended since you left", async ({ page }) => {
  await page.clock.install();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-block="working"] .home-row', { hasText: "Fix login" })).toBeVisible();
  const overview = await fixture("overview.json") as { groups: Array<{ children: Array<{ title: string; agentStatus: string }> }> };
  const idle = structuredClone(overview);
  for (const g of idle.groups) for (const c of g.children) if (c.title === "Fix login") Object.assign(c, { agentStatus: "idle", lastReply: "Login keeps the session through the guard now. Tests pass; want me to open a PR?" });

  // Leave, the agent finishes, come back two minutes later.
  await page.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event("blur")); });
  hook.pushOverview(idle);
  await expect(page.locator('[data-block="working"] .home-row', { hasText: "Fix login" })).toBeHidden();
  await page.clock.fastForward(120_000);
  await page.evaluate(() => { document.hasFocus = () => true; window.dispatchEvent(new Event("focus")); });

  const awayBlock = page.locator('[data-block="finished"]');
  await expect(awayBlock).toBeVisible();
  await expect(awayBlock.locator(".home-away-for")).toHaveText(" · away 2m");
  const row = awayBlock.locator(".home-row", { hasText: "Fix login" });
  await expect(row).toContainText("done 2m");
  await expect(row.locator(".home-row-sub.reply")).toHaveText("Login keeps the session through the guard now. Tests pass; want me to open a PR?");
  await page.waitForTimeout(300);
  await page.locator(".home").screenshot({ path: test.info().outputPath("desktop-since-you-left.png") });

  await row.click();
  await expect(page.locator(".doc-tab.selected")).toContainText("Fix login");
  await page.locator('.section-pill[data-section="home"]').click();
  await awayBlock.locator(".home-away-dismiss").click();
  await expect(awayBlock.locator(".home-away-dismiss")).toBeHidden();
  await expect(awayBlock.locator(".home-row", { hasText: "Fix login" })).toHaveCount(0);
  hook.pushOverview(overview);
});

test("⌘K lists the watched pull requests and opens one on its session's PRs", async ({ page }) => {
  ciChecks = "failing";
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // Home follows the CI watch, so its first look fills the palette too.
  await expect(page.locator(".home-check", { hasText: "#42" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("42");
  const row = page.locator(".palette-row", { hasText: "#42 Keep the session through the guard" });
  await expect(row).toContainText("Checks failing");
  await page.screenshot({ path: test.info().outputPath("desktop-palette-prs.png") });
  await page.keyboard.press("Enter");
  await expect(page.locator(".section-pill.selected")).toHaveText("Agents");
  await expect(page.locator('.chg-seg.sel[data-view="pulls"]')).toBeVisible();
  ciChecks = "pending";
});

test("Home flags a computer whose Hook is older than the newest seen", async ({ page }) => {
  // A second, older computer added to the overview the page receives.
  await page.routeWebSocket(/\/api\/overview$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const msg = JSON.parse(String(message));
      if (msg.type === "overview" && msg.merged?.computers?.[0]) {
        const [local] = msg.merged.computers;
        local.overview = { ...local.overview, phren: { ...local.overview?.phren, version: "0.3.45" } };
        msg.merged.computers.push({ computer: "Build box", state: "online", overview: { groups: [], phren: { version: "0.3.44" } } });
      }
      ws.send(JSON.stringify(msg));
    });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const computers = page.locator('[data-block="computers"]');
  await expect(computers.locator(".home-computer", { hasText: "This computer" }).locator(".home-hook")).toHaveText("Hook 0.3.45");
  const box = computers.locator(".home-computer", { hasText: "Build box" });
  await expect(box.locator(".home-hook.behind")).toHaveText("Hook 0.3.44");
  await page.waitForTimeout(300);
  await computers.screenshot({ path: test.info().outputPath("desktop-hook-drift.png") });
  await box.locator(".home-hook-update").click();
  await expect(box.locator(".home-hook-update")).toHaveText("command copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("npx --yes @phren/cli@0.3.45 bridge update");
});

test("an available update shows in the titlebar with What's new", async ({ page }) => {
  await page.addInitScript(() => {
    const actions: string[] = [];
    const shell = {
      platform: "darwin", notify() {}, setBadge() {},
      onUpdate: (fn: (state: unknown) => void) => { Object.assign(window, { __offer: fn }); },
      updateAction: (kind: string) => { actions.push(kind); },
    };
    Object.assign(window, { __actions: actions, phrenDesktop: shell });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.removeItem("phren.desktop.update-skipped"));
  await page.evaluate(() => (window as unknown as { __offer: (s: unknown) => void }).__offer({
    version: "0.1.7", current: "0.1.6", action: "download",
    notes: ["- Summon Phren with ⌘K open from any app.", "- A menu bar icon shows who needs you.", "- Since you left on Home."],
  }));
  const chip = page.locator(".update-chip");
  await expect(chip).toHaveText("Phren 0.1.7");
  await chip.click();
  const pop = page.locator(".update-pop");
  await expect(pop.locator(".update-title")).toHaveText("What's new in 0.1.7");
  await expect(pop.locator(".update-notes li")).toHaveCount(3);
  await page.waitForTimeout(200);
  await page.screenshot({ path: test.info().outputPath("desktop-update-chip.png"), clip: { x: 640, y: 0, width: 800, height: 300 } });
  await pop.locator(".update-go").click();
  expect(await page.evaluate(() => (window as unknown as { __actions: string[] }).__actions)).toEqual(["download"]);

  // Later hides it until the next version.
  await chip.click();
  await page.locator(".update-later").click();
  await expect(chip).toBeHidden();
  await page.evaluate(() => localStorage.removeItem("phren.desktop.update-skipped"));
});

test("⌘K lists projects and opens one's page", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator("#needs-pill").waitFor();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("phren");
  // The first open loads the Projects list, then the row fills in.
  const row = page.locator(".palette-row", { hasText: "Project · This computer" });
  await expect(row).toContainText("phren");
  await page.waitForTimeout(200);
  await page.screenshot({ path: test.info().outputPath("desktop-palette-projects.png") });
  await row.click();
  await expect(page.locator(".section-pill.selected")).toHaveText(/Projects/);
  await expect(page.locator(".pj-forge")).toContainText("gitboy · git.example.com");
});

test("a sidebar row waiting on you shows what the agent said last", async ({ page }) => {
  // The working session turns to waiting with a last reply, in the overview the page receives.
  await page.routeWebSocket(/\/api\/overview$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const msg = JSON.parse(String(message));
      for (const c of msg.merged?.computers ?? []) for (const g of c.overview?.groups ?? []) for (const child of g.children ?? []) {
        if (child.id === "sess-fix-login") Object.assign(child, { agentStatus: "waiting", lastReply: "Login keeps the session through the guard now. Tests pass; want me to open a PR?" });
      }
      ws.send(JSON.stringify(msg));
    });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.evaluate(() => localStorage.removeItem("phren.desktop.sidebarRows"));
  const row = page.locator(".sb-row", { hasText: "Fix login" });
  await expect(row.locator(".sb-reply")).toHaveText("Login keeps the session through the guard now. Tests pass; want me to open a PR?");
  // An approval row keeps its card instead.
  await expect(page.locator(".sb-row", { hasText: "Ship release" }).locator(".sb-reply")).toHaveCount(0);
  await page.waitForTimeout(300);
  const box = (await page.locator("#sidebar").boundingBox())!;
  await page.screenshot({ path: test.info().outputPath("desktop-sidebar-reply.png"), clip: { x: box.x, y: box.y, width: box.width, height: 320 } });
});

test("the menu bar answers an approval before Home is opened", async ({ page }) => {
  await page.addInitScript(() => {
    const trays: unknown[] = [];
    const shell = {
      platform: "darwin", notify() {}, setBadge() {},
      setTray: (state: unknown) => { trays.push(state); },
      onOpenSession() {},
      onTrayAnswer: (fn: (a: { key: string; decision: string }) => void) => { Object.assign(window, { __trayAnswer: fn }); },
    };
    Object.assign(window, { __trays: trays, phrenDesktop: shell });
  });
  // The approval session's status socket reports what it asks.
  await page.routeWebSocket(/\/v1\/status\?/, (ws) => {
    ws.send(JSON.stringify({ agentStatus: { status: "blocked", pendingApproval: { actionId: "a1", title: "Run pnpm test in phren-release" } } }));
  });
  const answers: unknown[] = [];
  await page.route("**/v1/approvals/answer", async (route) => {
    answers.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto(`${url}#/agents`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.removeItem("phren.desktop.tray"));
  type Tray = { rows?: Array<{ key: string; approval?: string }> };
  const last = () => page.evaluate(() => (window as unknown as { __trays: Tray[] }).__trays.at(-1));
  await expect.poll(async () => (await last())?.rows?.find((r) => r.approval)?.approval).toBe("Run pnpm test in phren-release");
  await expect(page.locator(".section-home")).toHaveCount(0);
  const key = (await last())!.rows!.find((r) => r.approval)!.key;
  await page.evaluate((k) => (window as unknown as { __trayAnswer: (a: { key: string; decision: string }) => void }).__trayAnswer({ key: k, decision: "approve" }), key);
  await expect.poll(() => answers.length).toBe(1);
  await expect(page.locator(".section-home")).toHaveCount(0);
  expect(answers[0]).toMatchObject({ actionId: "a1", target: { session: "sess-release" } });
});

test("a stalled working session reads 'stalled' on Home and in the sidebar", async ({ page }) => {
  const since = new Date(Date.now() - 7 * 60_000).toISOString();
  await page.routeWebSocket(/\/api\/overview$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const msg = JSON.parse(String(message));
      for (const c of msg.merged?.computers ?? []) for (const g of c.overview?.groups ?? []) for (const child of g.children ?? []) {
        if (child.id === "sess-fix-login") Object.assign(child, { stalled: true, stalledSince: since, stallFor: 420 });
      }
      ws.send(JSON.stringify(msg));
    });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const row = page.locator('[data-block="working"] .home-row', { hasText: "Fix login" });
  await expect(row).toHaveClass(/tone-stalled/);
  await expect(row.locator(".home-stalled")).toHaveText("stalled 7m");
  await page.waitForTimeout(300);
  const block = (await page.locator('[data-block="working"]').boundingBox())!;
  await page.screenshot({ path: test.info().outputPath("desktop-stalled-home.png"), clip: { x: block.x - 8, y: block.y - 8, width: block.width + 16, height: block.height + 16 } });
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator(".sb-row", { hasText: "Fix login" }).locator(".sb-stalled")).toHaveText("stalled 7m");
});

test("Since you left lists pull requests whose checks settled while away", async ({ page }) => {
  ciChecks = "pending";
  await page.clock.install();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // Home follows the CI watch; its first look is the baseline.
  await expect(page.locator(".home-check", { hasText: "#42" })).toBeVisible();
  await page.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event("blur")); });
  ciChecks = "failing";
  await page.clock.fastForward(121_000);
  await expect(page.locator(".home-check.failing", { hasText: "#42" })).toBeVisible();
  await page.evaluate(() => { document.hasFocus = () => true; window.dispatchEvent(new Event("focus")); });
  const awayBlock = page.locator('[data-block="finished"]');
  const row = awayBlock.locator(".home-row", { hasText: "#42 Keep the session through the guard" });
  await expect(row).toContainText("checks failed");
  await page.waitForTimeout(300);
  await page.locator(".home").screenshot({ path: test.info().outputPath("desktop-away-checks.png") });
  await row.click();
  await expect(page.locator('.chg-seg.sel[data-view="pulls"]')).toBeVisible();
  ciChecks = "pending";
});

test("quiet hours and the stalled-agent toggle are set in Settings › Notifications", async ({ page }) => {
  await page.addInitScript(() => { Object.assign(window, { phrenDesktop: { platform: "darwin", notify() {}, setBadge() {}, setTray() {}, onOpenSession() {} } }); });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => { localStorage.removeItem("phren.desktop.quiet"); localStorage.removeItem("phren.desktop.notify-stalled"); });
  await page.locator('.section-pill[data-section="settings"]').click();
  await page.locator(".settings-tab", { hasText: "Notifications" }).click();
  const list = page.locator(".settings-page-notifications");
  await expect(list.locator(".settings-toggle", { hasText: "An agent stalls" }).locator("input")).toBeChecked();
  const quiet = list.locator(".settings-quiet");
  await expect(quiet.locator("input[type=checkbox]")).not.toBeChecked();
  await quiet.locator(".settings-switch").click();
  await quiet.getByLabel("Quiet from").fill("21:30");
  await quiet.getByLabel("Quiet until").fill("06:45");
  await expect(quiet.locator("input[type=checkbox]")).toBeChecked();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("phren.desktop.quiet") ?? "{}"))).toEqual({ on: true, from: "21:30", to: "06:45" });
  await page.waitForTimeout(200);
  await list.screenshot({ path: test.info().outputPath("desktop-quiet-hours.png") });
  await page.evaluate(() => localStorage.removeItem("phren.desktop.quiet"));
});

test("the menu bar's New agent opens the launch sheet", async ({ page }) => {
  await page.addInitScript(() => {
    const shell = { platform: "darwin", notify() {}, setBadge() {}, setTray() {}, onOpenSession() {}, onNewAgent: (fn: () => void) => { Object.assign(window, { __newAgent: fn }); } };
    Object.assign(window, { phrenDesktop: shell });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator("#needs-pill").waitFor();
  await page.evaluate(() => (window as unknown as { __newAgent: () => void }).__newAgent());
  await expect(page.locator(".launch-sheet .launch-title")).toHaveText("New agent");
});

test("a session continues in another agent from the sidebar menu", async ({ page }) => {
  await page.route("**/v1/harnesses", (route) => route.fulfill({ json: { harnesses: [
    { source: "claude", installed: true, usable: true, accounts: [{ id: "default", usable: true }, { id: "work", label: "Work", usable: true }] },
    { source: "codex", installed: true, usable: true },
    { source: "opencode", installed: false, usable: false, reason: "Not installed" },
    { source: "copilot", installed: true, usable: true },
  ] } }));
  const moves: unknown[] = [];
  let polls = 0;
  await page.route("**/v1/sessions/move**", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      moves.push(body);
      return route.fulfill({ json: { ok: true, move: { id: body.id, state: "handing-off" } } });
    }
    polls += 1;
    return route.fulfill({ json: { move: { id: "x", state: polls < 2 ? "launching" : "moved", handoff: { source: "agent" } } } });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  const row = page.locator(".sb-row", { hasText: "Fix login" });
  await row.hover();
  await row.locator(".sb-more").click();
  await row.locator(".sb-menu button", { hasText: "Continue in…" }).click();
  const sheet = page.locator(".move-sheet");
  await expect(sheet.locator(".launch-seg")).toHaveText(["Codex", "OpenCode", "Copilot"]);
  await expect(sheet.locator(".launch-seg.selected")).toHaveText("Codex");
  await expect(sheet.locator(".launch-seg", { hasText: "OpenCode" })).toBeDisabled();
  await page.waitForTimeout(200);
  await sheet.screenshot({ path: test.info().outputPath("desktop-continue-in.png") });
  await sheet.getByRole("button", { name: "Continue" }).click();
  await expect.poll(() => moves.length).toBe(1);
  expect(moves[0]).toMatchObject({ target: { session: "sess-fix-login" }, to: { harness: "codex" } });
  await expect(sheet.locator(".launch-status")).toHaveText("Moved", { timeout: 10_000 });
});

/** The Hook capabilities the page sees: the desktop reads them from overview frames (and /v1/health before the first one). */
async function hookCapabilities(page: import("@playwright/test").Page, capabilities: Record<string, unknown>, version = "0.3.45") {
  await page.route("**/v1/health", (route) => route.fulfill({ json: { version, capabilities } }));
  await page.routeWebSocket(/\/api\/overview$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const msg = JSON.parse(String(message));
      for (const c of msg.merged?.computers ?? []) if (c.overview) c.overview.phren = { ...c.overview.phren, version, capabilities };
      ws.send(JSON.stringify(msg));
    });
  });
}

test("Quick chat starts phren's agent in chat mode on the project", async ({ page }) => {
  await hookCapabilities(page, { quickChat: true });
  await page.route("**/v1/dispatch/capacity", (route) => route.fulfill({ status: 404, json: { error: "not here" } }));
  await page.route("**/v1/harnesses", (route) => route.fulfill({ json: { harnesses: [
    { source: "claude", installed: true, usable: true }, { source: "codex", installed: true, usable: true }, { source: "phren", installed: true, usable: true },
  ] } }));
  const launches: Array<Record<string, unknown>> = [];
  await page.route("**/v1/workspaces/launch", async (route) => {
    launches.push(route.request().postDataJSON());
    await route.fulfill({ status: 500, json: { error: "stopped by the test" } });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator(".section-pill", { hasText: "Projects" }).click();
  await page.locator(".pj-card", { hasText: "phren" }).first().click();
  await page.getByRole("button", { name: "Quick chat" }).click();
  const sheet = page.locator(".launch-sheet");
  await expect(sheet.locator(".launch-title")).toHaveText("Quick chat about phren");
  const fieldNamed = (name: string) => sheet.locator(".launch-field").filter({ has: page.locator(".launch-label", { hasText: new RegExp(`^${name}$`) }) });
  await expect(fieldNamed("Harness").locator(".launch-seg")).toHaveText(["Phren"]);
  await expect(fieldNamed("Role")).toBeHidden();
  const go = sheet.getByRole("button", { name: "Start quick chat" });
  await expect(go).toBeEnabled();
  await page.waitForTimeout(200);
  await sheet.screenshot({ path: test.info().outputPath("desktop-quick-chat.png") });
  await go.click();
  await expect.poll(() => launches.length).toBe(1);
  expect(launches[0]).toMatchObject({ kind: "phren", mode: "chat", project: "phren" });
});

test("Quick chat stays off on a Hook without it", async ({ page }) => {
  await hookCapabilities(page, {}, "0.3.20");
  await page.route("**/v1/harnesses", (route) => route.fulfill({ json: { harnesses: [{ source: "phren", installed: true, usable: true }] } }));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator("#needs-pill").waitFor();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(">quick chat");
  await page.keyboard.press("Enter");
  await expect(page.locator(".launch-sheet .launch-title")).toHaveText("Quick chat");
  await page.locator(".launch-input").first().fill("phren");
  await expect(page.locator(".launch-sheet").getByRole("button", { name: "Start quick chat" })).toBeDisabled();
  await expect(page.locator(".launch-sheet .launch-error")).toContainText("older than quick chat");
});

test("⌘K's ? search offers to ask the question in a quick chat", async ({ page }) => {
  await page.route("**/memory/search**", (route) => route.fulfill({ json: { results: [
    { kind: "finding", text: "The session guard drops the cookie on refresh.", score: 0.82, finding: { id: "fid:1", type: "pitfall" } },
  ] } }));
  await hookCapabilities(page, { quickChat: true });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.locator(".sb-row", { hasText: "Fix login" }).click();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("?why does login drop the session");
  const ask = page.locator(".palette-row", { hasText: "Ask in a quick chat: why does login drop the session" });
  await expect(ask).toContainText("phren · This computer");
  await expect(page.locator(".palette-row", { hasText: "session guard drops the cookie" })).toBeVisible();
  await page.waitForTimeout(200);
  await page.screenshot({ path: test.info().outputPath("desktop-palette-ask.png"), clip: { x: 380, y: 130, width: 680, height: 260 } });
  await ask.click();
  await expect(page.locator(".launch-sheet .launch-title")).toHaveText("Quick chat about phren");
  await expect(page.getByRole("textbox", { name: "First prompt" })).toHaveValue("why does login drop the session");
});

test("Home replies to an agent that is waiting on you", async ({ page }) => {
  await page.routeWebSocket(/\/api\/overview$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const msg = JSON.parse(String(message));
      for (const c of msg.merged?.computers ?? []) for (const g of c.overview?.groups ?? []) for (const child of g.children ?? []) {
        if (child.id === "sess-fix-login") Object.assign(child, { agentStatus: "waiting", lastReply: "Tests pass. Want me to open a PR?" });
      }
      ws.send(JSON.stringify(msg));
    });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const needs = page.locator('[data-block="needs"]');
  const box = needs.locator(".home-reply-row", { hasText: "Fix login" }).locator(".home-reply-input");
  await expect(box).toBeVisible();
  await expect(needs.locator(".home-reply-row", { hasText: "Ship release" })).toHaveCount(0);
  const before = hook.calls.filter((c) => c.path === "/v1/prompt").length;
  await box.fill("Yes, open it as a draft");
  await page.waitForTimeout(200);
  await needs.screenshot({ path: test.info().outputPath("desktop-home-reply.png") });
  await box.press("Enter");
  await expect(needs.locator(".home-reply-note")).toHaveText("Sent");
  await expect.poll(() => hook.calls.filter((c) => c.path === "/v1/prompt").length).toBe(before + 1);
  expect(hook.calls.filter((c) => c.path === "/v1/prompt").at(-1)!.body).toMatchObject({ text: "Yes, open it as a draft", target: { session: "sess-fix-login" } });
});

test("a session working on background tasks says so on Home and in the sidebar", async ({ page }) => {
  await page.routeWebSocket(/\/api\/overview$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      const msg = JSON.parse(String(message));
      for (const c of msg.merged?.computers ?? []) for (const g of c.overview?.groups ?? []) for (const child of g.children ?? []) {
        if (child.id === "sess-fix-login") Object.assign(child, { agentStatus: "working", backgroundTasks: 3, currentStep: undefined });
      }
      ws.send(JSON.stringify(msg));
    });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const row = page.locator('[data-block="working"] .home-row', { hasText: "Fix login" });
  await expect(row.locator(".home-row-sub")).toHaveText("3 background tasks");
  await page.waitForTimeout(300);
  const block = (await page.locator('[data-block="working"]').boundingBox())!;
  await page.screenshot({ path: test.info().outputPath("desktop-background-home.png"), clip: { x: block.x - 8, y: block.y - 8, width: block.width + 16, height: block.height + 16 } });
  await page.locator('.section-pill[data-section="agents"]').click();
  await expect(page.locator(".sb-row", { hasText: "Fix login" }).locator(".sb-background")).toHaveText("3 background tasks");
});

test("⌘K continues the open session in another agent", async ({ page }) => {
  await page.route("**/v1/harnesses", (route) => route.fulfill({ json: { harnesses: [
    { source: "claude", installed: true, usable: true }, { source: "codex", installed: true, usable: true },
  ] } }));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator("#needs-pill").waitFor();
  // No session open: the command is not offered.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(">continue");
  await expect(page.locator(".palette-row", { hasText: "Continue this session in" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.locator(".sb-row", { hasText: "Fix login" }).click();
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(">continue");
  const row = page.locator(".palette-row", { hasText: "Continue this session in" });
  await expect(row).toContainText("Fix login");
  await page.keyboard.press("Enter");
  await expect(page.locator(".move-sheet .launch-seg.selected")).toHaveText("Codex");
});

test("⌘1–⌘9 open the titlebar's pills in order", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // Chromium keeps ⌘+digit for its own tabs, so press Ctrl, which the handler also takes.
  const mod = "Control";
  await expect(page.locator('.section-pill[data-section="home"]')).toHaveAttribute("title", /Home \((⌘|Ctrl\+)1\)/);
  await page.keyboard.press(`${mod}+2`);
  await expect(page.locator('.section-pill[data-section="agents"]')).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press(`${mod}+4`); // the Projects group opens its first section
  await expect(page.locator('.section-pill[data-group="work"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".section-projects")).toBeVisible();
  await page.keyboard.press(`${mod}+1`);
  await expect(page.locator('.section-pill[data-section="home"]')).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press(`${mod}+9`); // no ninth pill: nothing changes
  await expect(page.locator('.section-pill[data-section="home"]')).toHaveAttribute("aria-selected", "true");
});

test("a file dropped on a session row opens it and waits in its composer", async ({ page }) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('.section-pill[data-section="agents"]').click();
  const row = page.locator(".sb-row", { hasText: "Fix login" });
  const image = await page.evaluateHandle(() => {
    const d = new DataTransfer();
    d.items.add(new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0))], "shot.png", { type: "image/png" }));
    return d;
  });
  await row.dispatchEvent("dragover", { dataTransfer: image });
  await expect(row).toHaveClass(/sb-drop/);
  await row.dispatchEvent("drop", { dataTransfer: image });
  await expect(row).not.toHaveClass(/sb-drop/);
  await expect(page.locator(".pc-attach img[alt='shot.png']")).toBeVisible();

  const text = await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(["notes"], "notes.md", { type: "text/markdown" })); return d; });
  await row.dispatchEvent("drop", { dataTransfer: text });
  await expect(page.getByText("Only images can be attached.")).toBeVisible();
});

test("Memory and chat recall show citation freshness with a tooltip at narrow widths", async ({ page }) => {
  // Memory is read by the daemon's store mirror; recall comes from the Hook.
  await page.route("**/api/memory/*/projects", route => route.fulfill({ json: { projects: [{ name: "phren", findings: 1 }] } }));
  await page.route("**/api/memory/*/findings?*", route => route.fulfill({ json: { items: [SAMPLE_FINDING] } }));
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto(`${url}#/memory`, { waitUntil: "domcontentloaded" });
  const tooltip = "src/router.ts changed in 3f2a9c1 “Split the router into per-host modules” (Oct 14)";
  const warning = page.locator(".mem-tag.warn");
  await expect(warning).toHaveText("May be out of date");
  await expect(warning).toHaveAttribute("title", tooltip);
  expect(await warning.evaluate(el => el.getBoundingClientRect().right <= el.parentElement!.getBoundingClientRect().right)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("desktop-memory-freshness.png") });

  await page.locator('.section-pill[data-section="agents"]').click();
  await page.locator(".sb-row", { hasText: "Fix login" }).click();
  await page.locator(".pc-input").fill("Explain the router");
  const recallWarning = page.locator(".pc-recall-freshness");
  await expect(recallWarning).toHaveText("May be out of date");
  await expect(recallWarning).toHaveAttribute("title", tooltip);
  expect(await recallWarning.evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(420);
});

test("Memory can filter to findings that may be out of date and combine it with search", async ({ page }) => {
  await page.route("**/api/memory/*/projects", route => route.fulfill({ json: { projects: [{ name: "phren", findings: 5 }] } }));
  await page.route("**/api/memory/*/findings?*", route => route.fulfill({ json: { items: [SAMPLE_FINDING, ...SAMPLE_STALE_FINDINGS] } }));
  await page.goto(`${url}#/memory`, { waitUntil: "domcontentloaded" });
  const rows = page.locator(".mem-row");
  await expect(rows).toHaveCount(5);
  const toggle = page.locator('.mem-chip[data-filter="stale"]');
  await expect(toggle).toHaveText("May be out of date (3)");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  const focusedFilter = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.filter);
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await focusedFilter()).toBe("stale");
  await expect(page.locator('.mem-chip[data-filter="all"]')).not.toHaveClass(/\bon\b/);
  await expect(rows).toHaveCount(3);
  await expect(page.locator(".mem-row .mem-tag.warn")).toHaveCount(3);
  await expect(toggle).toHaveText("May be out of date (3)");

  await page.locator(".mem-search").fill("queue");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Drain the queue");
  await page.locator(".mem-search").fill("handlers");
  await expect(page.locator(".mem-empty")).toHaveText("No matches.");

  await page.locator(".mem-search").fill("");
  await page.locator('.mem-chip[data-filter="stale"]').focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(await focusedFilter()).toBe("stale");
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await focusedFilter()).toBe("stale");
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  // The count follows the chosen type: only the decision is stale among decisions.
  await page.locator('.mem-chip[data-filter="tag:decision"]').click();
  await expect(toggle).toHaveText("May be out of date (1)");
  expect(await focusedFilter()).toBe("tag:decision");
  await page.locator('.mem-chip[data-filter="tag:decision"]').click();
  await expect(rows).toHaveCount(5);
});

test("Memory hides the out-of-date filter when no finding has freshness data", async ({ page }) => {
  await page.route("**/api/memory/*/projects", route => route.fulfill({ json: { projects: [{ name: "phren", findings: 1 }] } }));
  await page.route("**/api/memory/*/findings?*", route => route.fulfill({ json: { items: [SAMPLE_STALE_FINDINGS[3]] } }));
  await page.goto(`${url}#/memory`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".mem-row")).toHaveCount(1);
  await expect(page.locator('.mem-chip[data-filter="stale"]')).toHaveCount(0);
});
