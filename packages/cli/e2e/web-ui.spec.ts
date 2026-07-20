import { test, expect, type Page } from "@playwright/test";
import { createWebUiHarness, type WebUiHarness } from "./web-ui-harness";

let harness: WebUiHarness;

async function stubExternalAssets(page: Page): Promise<void> {
  await page.route("https://cdn.jsdelivr.net/npm/marked@12/marked.min.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: [
        "window.marked = {",
        "  parse(value) {",
        "    return String(value)",
        "      .replace(/&/g, '&amp;')",
        "      .replace(/</g, '&lt;')",
        "      .replace(/>/g, '&gt;')",
        "      .replace(/\\n/g, '<br>');",
        "  }",
        "};",
      ].join("\n"),
    });
  });
  await page.route("https://fonts.bunny.net/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/css",
      body: "",
    });
  });
}

async function openWebUi(page: Page): Promise<void> {
  await stubExternalAssets(page);
  await page.goto(harness.secureUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".project-card")).toHaveCount(2);
}

test.describe.serial("web-ui browser e2e", () => {
  test.beforeAll(async () => {
    harness = await createWebUiHarness();
  });

  test.afterAll(async () => {
    await harness.cleanup();
  });

  test("navigates the major web-ui surfaces from an isolated temp store", async ({ page }) => {
    await openWebUi(page);

    // The brand renders lowercase "phren" — match case-insensitively.
    await expect(page.locator(".header-brand")).toContainText(/phren/i);
    await expect(page.locator(".project-card").filter({ hasText: "repo-a" })).toBeVisible();
    await expect(page.locator(".project-card").filter({ hasText: "repo-b" })).toBeVisible();

    await page.fill("#projects-search", "repo-b");
    await expect(page.locator(".project-card").filter({ hasText: "repo-a" })).toBeHidden();
    await expect(page.locator(".project-card").filter({ hasText: "repo-b" })).toBeVisible();
    await page.fill("#projects-search", "");
    await expect(page.locator(".project-card").filter({ hasText: "repo-a" })).toBeVisible();

    await page.locator(".project-card").filter({ hasText: "repo-a" }).click();
    await expect(page.locator(".project-detail-header h2")).toHaveText("repo-a");

    await page.locator(".project-detail-tab").filter({ hasText: "Summary" }).click();
    await expect(page.locator("#project-content")).toContainText("Repo A summary for browser smoke coverage.");

    await page.locator(".project-detail-tab").filter({ hasText: "Findings" }).click();
    await expect(page.locator("#project-content")).toContainText("Browser smoke finding");

    await page.locator(".project-detail-tab").filter({ hasText: "Task" }).click();
    await expect(page.locator("#project-content")).toContainText("Queue browser task");

    await page.locator(".project-detail-tab").filter({ hasText: "CLAUDE.md" }).click();
    await expect(page.locator("#project-content")).toContainText("Repo A instructions for browser smoke coverage.");

    await page.locator(".project-detail-tab").filter({ hasText: "Reference" }).click();
    await expect(page.locator("#project-content")).toContainText("Other Reference Docs");
    await expect(page.locator("#project-content")).toContainText("Browser Reference");
    await page.locator("#project-content .split-item").filter({ hasText: "Browser Reference" }).click();
    await expect(page.locator("#reference-reader")).toContainText("Browser reference doc.");

    await page.locator("button.nav-item").filter({ hasText: "Review" }).click();
    await expect(page.locator(".review-card")).toHaveCount(1);
    await expect(page.locator(".review-card")).toContainText("Review me first");

    await page.locator("button.nav-item").filter({ hasText: "Skills" }).click();
    await expect(page.locator("#skills-list")).toContainText("browser-checks");
    await page.locator("#skills-list .split-item").filter({ hasText: "browser-checks" }).click();
    await expect(page.locator("#skills-reader")).toContainText("Browser E2E Smoke");

    await page.locator("button.nav-item").filter({ hasText: "Hooks" }).click();
    await expect(page.locator("#hooks-list")).toContainText("claude");
    await expect(page.locator("#hooks-list")).toContainText("codex");
    await page.locator("#hooks-list .hook-item").filter({ hasText: "codex" }).click();
    await expect(page.locator("#hooks-reader")).toContainText("UserPromptSubmit");
    await expect(page.locator("#hooks-reader")).toContainText("echo codex-prompt");

    await page.locator("button.nav-item").filter({ hasText: "Graph" }).click();
    await expect(page.locator("#graph-canvas")).toBeVisible();
    const projectNav = page.getByRole("navigation", { name: "Project navigator" });
    const repoAOrb = projectNav.locator('.phren-project-orb[data-project-id="repo-a"]');
    await expect(repoAOrb).toBeVisible();
    await repoAOrb.click();
    await expect(repoAOrb).toHaveClass(/active/);
  });

  test("captures a finding from the project operation and refreshes the list", async ({ page }) => {
    await openWebUi(page);

    await page.locator(".project-card").filter({ hasText: "repo-b" }).click();
    await page.getByRole("button", { name: "+ Add finding" }).click();

    const text = `web-capture-${Date.now()}`;
    await page.locator("#finding-add-input").fill(text);
    await page.getByRole("button", { name: "Add finding", exact: true }).click();

    await expect(page.locator("#project-content")).toContainText(text);
    await expect(page.locator(".finding-detail-card summary").filter({ hasText: text })).not.toContainText("<!--");
  });

  test("captures and promotes a daily note from the project operation", async ({ page }) => {
    await openWebUi(page);

    await page.locator(".project-card").filter({ hasText: "repo-b" }).click();
    await page.getByRole("button", { name: "+ Add note" }).click();
    const text = `web-note-${Date.now()}`;
    await page.locator("#note-add-text").fill(text);
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await expect(page.locator(".note-card").filter({ hasText: text })).toBeVisible();

    page.once("dialog", async (dialog) => dialog.accept("pattern"));
    await page.locator(".note-card").filter({ hasText: text }).getByRole("button", { name: "Promote to finding" }).click();
    await expect(page.locator(".note-card").filter({ hasText: text })).toContainText("promoted");

    await page.locator(".project-detail-tab").filter({ hasText: "Findings" }).click();
    await expect(page.locator("#project-content")).toContainText(text);
  });

  test("edits and approves a queued memory end-to-end", async ({ page }) => {
    await openWebUi(page);

    await page.locator("button.nav-item").filter({ hasText: "Review" }).click();
    await expect(page.locator(".review-card")).toHaveCount(1);

    await page.getByRole("button", { name: "Edit" }).first().click();
    const updatedText = "Updated browser review item\nwith a second line";
    await page.locator('textarea[name="new_text"]').fill(updatedText);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".toast")).toContainText("Saved");
    await expect(page.locator(".review-card")).toContainText("Updated browser review item");
    await expect(page.locator(".review-card")).toContainText("with a second line");

    await page.locator(".review-card-check").click();
    await expect(page.locator("#batch-bar")).toContainText("1 selected");
    await page.getByRole("button", { name: "Approve selected" }).click();
    await expect(page.locator(".review-card")).toHaveCount(0, { timeout: 8_000 });

    await page.locator("button.nav-item").filter({ hasText: "Projects" }).click();
    await page.locator(".project-card").filter({ hasText: "repo-a" }).click();
    await page.locator(".project-detail-tab").filter({ hasText: "Findings" }).click();
    await expect(page.locator("#project-content")).toContainText("Updated browser review item");
  });
});
