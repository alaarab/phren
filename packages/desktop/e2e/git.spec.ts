import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import type { Computer, MergedOverview, OverviewHub } from "../src/contract.js";
import { hookRequest, hookWebSocket } from "../src/hook-client.js";
import { createOverviewHub } from "../src/overview.js";
import { startServer } from "../src/server.js";
import { createFakeGit, FAKE_GIT_WORKING_APP, type FakeGit } from "../src/testing/fake-git.js";
import { startFakeHook, type FakeHook } from "../src/testing/fake-hook.js";

// The git surfaces against a fake Hook with a small stateful repository: the
// Monaco diff tab with staging by hunk, the branch bar, commit detail, branch
// switching and creation, pull request checks, and one session's changes.

const LOCAL: Computer = { name: "This computer", local: true, server: "default" };
const TOKEN = "desktop-git-token";
const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_SOURCE = path.resolve(SPEC_DIR, "../ui");
const UI_LINK = path.resolve(SPEC_DIR, "../../../packages/ui");
let linkedUi = false;

let dir: string;
let hook: FakeHook;
let git: FakeGit;
let hub: OverviewHub;
let closeServer: (() => Promise<void>) | undefined;
let url: string;

test.beforeEach(async () => {
  if (!existsSync(UI_LINK)) { symlinkSync(UI_SOURCE, UI_LINK, "dir"); linkedUi = true; }
  dir = await mkdtemp(path.join(tmpdir(), "desktop-git-"));
  process.env.PHREN_BRIDGE_HOME = dir;
  git = createFakeGit();
  hook = await startFakeHook({ dir, routes: git.routes, files: { "src/app.ts": FAKE_GIT_WORKING_APP } });
  hub = createOverviewHub([LOCAL], hookWebSocket);
  const ready = new Promise<void>((resolve) => { hub.on("change", (merged: MergedOverview) => { if (merged.computers[0]?.overview) resolve(); }); });
  hub.start();
  await ready;
  const server = await startServer({
    port: 0, token: TOKEN, computers: [LOCAL], hub, hookRequest, hookWebSocket,
    attachTerminal: () => ({ write() {}, resize() {}, onData() {}, onExit() {}, kill() {} }),
  });
  url = server.url;
  closeServer = server.close;
});

test.afterEach(async () => {
  hub?.stop();
  await closeServer?.();
  await hook?.close();
  await rm(dir, { recursive: true, force: true });
  delete process.env.PHREN_BRIDGE_HOME;
});

test.afterAll(() => {
  if (linkedUi) { try { unlinkSync(UI_LINK); } catch { /* already gone */ } }
});

/** Open the one fixture session with its Changes pane, collecting page errors. */
async function openSession(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.locator('.section-pill[data-section="agents"]').click();
  await page.locator(".sb-row", { hasText: "Fix login" }).click();
  await expect(page.locator(".chg-branchbar")).toBeVisible();
  return errors;
}

const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(name) });

test("the diff tab compares whole files in Monaco, steps through changes and stages one hunk", async ({ page }) => {
  const errors = await openSession(page);
  await page.locator(".chg-row", { hasText: "app.ts" }).first().click();
  const doc = page.locator(".dd-doc");
  await expect(doc.locator(".monaco-diff-editor")).toBeVisible({ timeout: 20_000 });
  await expect(doc.locator(".dd-pos")).toHaveText(/1\/2/, { timeout: 15_000 });
  await expect(doc.locator(".dd-counts")).toContainText("+3");
  await expect(doc.locator(".dd-counts")).toContainText("−2");
  // Both sides came from /v1/git/file: the index against the working file.
  expect(git.calls.filter((c) => c.route === "file").map((c) => c.body.ref)).toContain("INDEX");
  await shot(page, "diff-unstaged.png");

  await doc.locator('[data-act="next"]').click();
  await expect(doc.locator(".dd-pos")).toHaveText("2/2");
  await doc.locator('[data-act="prev"]').click();
  await expect(doc.locator(".dd-pos")).toHaveText("1/2");

  // Stage the first hunk only: the file now has staged and unstaged sides.
  await doc.locator('[data-act="hunk"]').click();
  await expect.poll(() => git.staged()).toBe(1);
  const apply = git.calls.find((c) => c.route === "apply");
  expect(String(apply?.body.patch)).toContain("+export const ready = true;");
  expect(String(apply?.body.patch)).not.toContain("toUpperCase");
  await expect(doc.locator('.dd-seg[data-mode="staged"]')).toBeVisible();
  await expect(doc.locator(".dd-pos")).toHaveText(/\/1/);
  // The Changes pane heard about it and shows the file under Staged.
  await expect(page.locator(".chg-sec", { hasText: "STAGED" })).toContainText("app.ts");

  await doc.locator('.dd-seg[data-mode="staged"]').click();
  await expect(doc.locator('[data-act="hunk"]')).toHaveText("Unstage hunk");
  await shot(page, "diff-staged-mode.png");
  await doc.locator('[data-act="hunk"]').click();
  await expect.poll(() => git.staged()).toBe(0);
  expect(git.calls.filter((c) => c.route === "apply").at(-1)?.body.reverse).toBe(true);

  // Inline view and the folded-regions toggle stick across tabs.
  await doc.locator(".dd-toggle", { hasText: "Split" }).click();
  expect(await page.evaluate(() => localStorage.getItem("phren.desktop.diff.sideBySide"))).toBe("0");
  await shot(page, "diff-inline.png");
  expect(errors).toEqual([]);
});

test("the branch bar fetches, then pulls what arrived", async ({ page }) => {
  const errors = await openSession(page);
  const bar = page.locator(".chg-branchbar");
  await expect(bar).toContainText("main");
  await expect(bar).toContainText("↑1");
  await bar.locator('[data-act="fetch"]').click();
  await expect(bar.locator('[data-act="pull"]')).toHaveText("Pull 2");
  await expect(bar).toContainText("↓2");
  await shot(page, "branchbar-behind.png");
  await bar.locator('[data-act="pull"]').click();
  await expect(page.locator(".chg-note")).toHaveText("Pulled 2 commits");
  await expect(bar.locator('[data-act="fetch"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test("history opens a commit with its message and files, and a file opens its diff at that commit", async ({ page }) => {
  const errors = await openSession(page);
  await page.locator(".chg-seg", { hasText: "History" }).click();
  await page.locator(".chg-log-row", { hasText: "Wire the login form" }).click();
  await expect(page.locator(".chg-commit-subject")).toHaveText("Wire the login form to the session store");
  await expect(page.locator(".chg-commit-body")).toContainText("keeps the signed-in user");
  await expect(page.locator(".chg-commit-meta")).toContainText("3 files");
  await expect(page.locator(".chg-row", { hasText: "logo.png" })).toContainText("binary");
  await shot(page, "commit-detail.png");
  await page.locator(".chg-row", { hasText: "login.ts" }).click();
  await expect(page.locator(".doc-tab", { hasText: "login.ts @ a1b2c3d" })).toBeVisible();
  const doc = page.locator(".dd-doc");
  await expect(doc.locator(".monaco-diff-editor")).toBeVisible({ timeout: 20_000 });
  await expect(doc.locator(".dd-sha")).toHaveText("a1b2c3d");
  await expect(doc.locator('[data-act="hunk"]')).toHaveCount(0);
  await expect(doc.locator(".dd-counts")).toContainText("+5");
  const refs = git.calls.filter((c) => c.route === "file").map((c) => c.body.ref);
  expect(refs).toEqual(expect.arrayContaining(["a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432"]));
  await shot(page, "commit-diff.png");
  await page.locator(".chg-back").click();
  // Three commits under the uncommitted summary row.
  await expect(page.locator(".chg-log-row .chg-sha")).toHaveCount(3);
  expect(errors).toEqual([]);
});

test("branches switch with a confirmation, carry edits only when told, and a new branch is checked by name", async ({ page }) => {
  const errors = await openSession(page);
  await page.locator(".chg-seg", { hasText: "Branches" }).click();
  await page.locator('.chg-branch-row[data-branch="feat/login"]').click();
  await page.locator(".chg-confirm").getByRole("button", { name: "Switch" }).click();
  // The working tree has edits: the Hook asks before carrying them.
  await expect(page.locator(".chg-confirm")).toContainText("uncommitted changes that would move to feat/login");
  await shot(page, "branch-carry.png");
  await page.locator(".chg-confirm").getByRole("button", { name: "Switch with changes" }).click();
  await expect(page.locator(".chg-branchbar")).toContainText("feat/login");
  expect(git.branch()).toBe("feat/login");
  expect(git.calls.filter((c) => c.route === "checkout").at(-1)?.body.carryChanges).toBe(true);

  // The branch's pull request with its checks, failing first.
  await expect(page.locator(".chg-bb-pr.failing")).toHaveText("#42");
  await page.locator(".chg-bb-pr").click();
  const card = page.locator(".chg-pr-card");
  await expect(card).toContainText("Changes requested · Merge blocked");
  await expect(card).toContainText("1 failing · 1 pending · 1 passing · 1 skipped");
  await expect(card.locator(".chg-check").first()).toContainText("unit (ubuntu)");
  await shot(page, "pr-checks.png");

  // A new branch: Git's naming rules are checked while typing.
  await page.locator('[data-act="new-branch"]').click();
  const input = page.locator(".chg-sheet input[data-key=name]");
  await input.fill("bad name");
  await expect(page.locator(".chg-sheet .chg-error")).toHaveText("A branch name cannot contain spaces.");
  await expect(page.getByRole("button", { name: "Create and switch" })).toBeDisabled();
  await input.fill("feat/review");
  await shot(page, "new-branch.png");
  await page.getByRole("button", { name: "Create and switch" }).click();
  await expect(page.locator(".chg-branchbar")).toContainText("feat/review");
  await expect(page.locator(".chg-branchbar")).toContainText("not pushed");
  expect(errors).toEqual([]);
});

test("a remote branch checks out as a tracking local branch", async ({ page }) => {
  await openSession(page);
  // Stage everything first so nothing has to travel.
  await page.locator(".chg-row", { hasText: "app.ts" }).first().hover();
  await page.locator(".chg-row", { hasText: "app.ts" }).first().locator('.chg-icon[title="Stage"]').click();
  await expect.poll(() => git.staged()).toBe(2);
  await page.locator(".chg-seg", { hasText: "Branches" }).click();
  await page.locator('.chg-branch-row[data-branch="origin/agent/parser"]').click();
  await expect(page.locator(".chg-confirm")).toContainText("Check out origin/agent/parser as agent/parser");
  await page.locator(".chg-confirm").getByRole("button", { name: "Check out" }).click();
  await expect(page.locator(".chg-branchbar")).toContainText("agent/parser");
  expect(git.calls.filter((c) => c.route === "checkout").at(-1)?.body).toMatchObject({ branch: "agent/parser", create: true, startPoint: "origin/agent/parser" });
});

test("the Session view lists what this agent changed, edit by edit", async ({ page }) => {
  const errors = await openSession(page);
  await page.locator(".chg-seg", { hasText: "Session" }).click();
  await expect(page.locator(".chg-session-sum")).toHaveText("3 tool calls changed 2 files · +6 −2");
  const row = page.locator(".chg-row", { hasText: "app.ts" });
  await expect(row).toContainText("2 edits · uncommitted");
  await row.click();
  await expect(page.locator(".chg-edit-label")).toHaveCount(2);
  await expect(page.locator(".chg-diff")).toContainText("toUpperCase");
  await shot(page, "session-changes.png");
  await row.hover();
  await row.locator('.chg-icon[title="Open the file\'s uncommitted diff"]').click();
  await expect(page.locator(".dd-doc .monaco-diff-editor")).toBeVisible({ timeout: 20_000 });
  expect(errors).toEqual([]);
});
