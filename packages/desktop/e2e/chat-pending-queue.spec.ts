import { expect, test } from "@playwright/test";
import { chatRow, linkUi, openChat, overviewFrame, startHarness, type Harness } from "./helpers.js";

let harness: Harness | undefined;
let unlink: () => void;
test.beforeAll(() => { unlink = linkUi(); });
test.afterAll(() => unlink());
test.afterEach(async () => { await harness?.close(); harness = undefined; });

test("Hook-held messages survive re-opening, edit, cancel and send now through the proxy", async ({ page }) => {
  type Item = { id: string; text: string; state: string; target: unknown };
  const items: Item[] = [];
  const overview = overviewFrame([chatRow("queue-chat", "Queue parity", "working")]);
  overview.phren.capabilities = { ...overview.phren.capabilities, ...{ afterTurnQueue: true, queuedMessageActions: ["claude"] } };
  harness = await startHarness("pending-queue", {
    overviewFrames: [overview],
    transcriptFrames: [
      { raw: { type: "user", uuid: "pq-u1", message: { role: "user", content: "Fix the login flow" } } },
      { raw: { type: "assistant", uuid: "pq-a1", message: { role: "assistant", content: [{ type: "text", text: "On it. The session token is dropped before the guard runs." }] } } },
    ],
    routes: {
      "POST /v1/prompt/after-turn/list": () => ({ json: { items } }),
      "POST /v1/prompt/after-turn": (_req, body) => {
        const input = body as Item;
        const item = { ...input, state: "queued" };
        items.push(item); return { json: { item } };
      },
      "POST /v1/prompt/after-turn/edit": (_req, body) => {
        const input = body as Item;
        const item = items.find(item => item.id === input.id)!;
        item.text = input.text; return { json: { item } };
      },
      "POST /v1/prompt/after-turn/cancel": (_req, body) => {
        const item = items.find(item => item.id === (body as Item).id)!;
        item.state = "cancelled"; return { json: { item } };
      },
      "POST /v1/prompt": () => ({ json: { delivered: true, state: "delivered" } }),
      "POST /v1/prompt/status": () => ({ json: { state: "delivered" } }),
    },
  });
  await openChat(page, harness.url, "Queue parity", "The session token is dropped");
  const input = page.locator(".pc-input");
  await input.fill("Review after this turn");
  await input.press("Enter");
  await page.getByRole("button", { name: "After this turn", exact: true }).click();
  const queue = page.locator(".pc-held-queue");
  await expect(queue).toContainText("Waiting for this turn to end");
  await expect(input).toHaveValue("");
  expect(harness.hook.calls.filter(call => call.path === "/v1/prompt")).toHaveLength(0);

  await page.reload();
  await expect(queue).toContainText("Review after this turn");
  await queue.getByRole("button", { name: "Edit", exact: true }).click();
  await queue.getByRole("textbox", { name: "Edit queued message" }).fill("Review the updated draft");
  await queue.getByRole("button", { name: "Save", exact: true }).click();
  await expect(queue).toContainText("Review the updated draft");
  await queue.getByRole("button", { name: "Send now", exact: true }).click();
  await expect(queue).toBeHidden();
  await expect.poll(() => harness!.hook.calls.filter(call => call.path === "/v1/prompt").length).toBe(1);
  const sent = harness.hook.calls.find(call => call.path === "/v1/prompt")!.body as { text: string; deliveryId: string; target: { session: string } };
  expect(sent.text).toBe("Review the updated draft");
  expect(sent.target.session).toBe("queue-chat");
  expect(sent.deliveryId).not.toBe(items[0].id);

  await input.fill("Cancel this follow-up"); await input.press("Enter");
  await page.getByRole("button", { name: "After this turn", exact: true }).click();
  await expect(queue).toContainText("Cancel this follow-up");
  await queue.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(queue).toBeHidden();
  expect(harness.hook.calls.filter(call => call.path === "/v1/prompt")).toHaveLength(1);
});
