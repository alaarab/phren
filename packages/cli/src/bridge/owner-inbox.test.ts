import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fork, spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { INBOX_TITLE_LIMIT, OwnerInbox, inboxIssueTitle, inboxTargetSchema, inboxWire, issueInTitle, parseIssueLink, pushIssueTitle, titleBudget, type InboxItem, type InboxSource } from "./owner-inbox.js";
import { ownerInboxView } from "./owner-inbox-view.js";
import { hookPeers, peerRequest } from "./peers.js";
vi.mock("./peers.js", () => ({ hookPeers: vi.fn(), peerRequest: vi.fn() }));
const linked = (name: string) => ({ name, address: `${name.toLowerCase()}.example`, username: "sam", port: 22 });
const at = "2026-11-26T10:00:00.000Z";
let root: string, sources: InboxSource[];
const inbox = () => new OwnerInbox(async () => sources, path.join(root, "owner-inbox.json"));
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "phren-inbox-")); sources = []; vi.mocked(hookPeers).mockResolvedValue([]); });
afterEach(async () => { vi.useRealTimers(); vi.resetAllMocks(); await rm(root, { recursive: true, force: true }); });
describe("owner inbox", () => {
  it("adds, lists and resolves durably with idempotent adds and history", async () => {
    const box = inbox(), id = "11111111-1111-4111-8111-111111111111";
    const add = { action: "add", id, title: "Restart the router", project: "phren" };
    await Promise.all([box.run(add), box.run(add)]); expect((await box.run({})).items).toHaveLength(1);
    const updated = await box.run({ ...add, title: "Other" });
    expect(updated.updated).toBe(true);
    expect((await inbox().run({})).items).toMatchObject([{ id, title: "Other", project: "phren" }]);
    await box.run({ action: "resolve", id, resolution: "Router restarted" });
    expect((await inbox().run({})).items).toEqual([]);
    expect((await inbox().run({ includeResolved: true })).items).toMatchObject([{ state: "resolved", resolution: "Router restarted" }]);
  });
  it("validates the command, task, pr and key fields of a manual add", async () => {
    const box = inbox();
    const added = await box.run({ action: "add", title: "Merge the release", command: "gh pr merge 877 --squash\necho\tmerged", task: "bid:c2cc33d0", pr: "https://github.com/alaarab/phren/pull/877/" });
    expect(added.item).toMatchObject({ command: "gh pr merge 877 --squash\necho\tmerged", task: "bid:c2cc33d0", pr: "https://github.com/alaarab/phren/pull/877" });
    for (const bad of [
      { task: "bid:zzzzzzzz" }, { task: "c2cc33d0" }, { pr: "https://github.com/o/r/issues/5" }, { pr: "http://github.com/o/r/pull/1" },
      { pr: "https://github.com/o/r/pull/not-a-number" }, { command: "echo hi\r\necho bye" }, { command: "echo \x07bell" },
      { command: "echo\x00" }, { command: "" }, { command: Array.from({ length: 21 }, (_, i) => `line ${i + 1}`).join("\n") }, { key: "has space" },
    ]) await expect(box.run({ action: "add", title: "Bad add", ...bad })).rejects.toThrow(z.ZodError);
    const twenty = await box.run({ action: "add", title: "Twenty lines is fine", command: Array.from({ length: 20 }, (_, i) => `step ${i + 1}\t`).join("\n") });
    expect((twenty.item as InboxItem).command).toContain("step 20");
  });
  it("stores an issue link in the title, and serves it as a field only on request", async () => {
    const box = inbox(), issue = "github.com/alaarab/phren#42", key = "deploy-key";
    const added = await box.run({ action: "add", title: "Rotate the deploy key", project: "phren", key, issue, issues: true });
    expect(added.item).toMatchObject({ title: "Rotate the deploy key", issue });
    // Stored as the title every older reader parses, with no key of its own.
    const stored = JSON.parse(await readFile(path.join(root, "owner-inbox.json"), "utf8"));
    expect(stored).toEqual([expect.objectContaining({ title: "Rotate the deploy key (issue: github.com/alaarab/phren#42)", project: "phren", key })]);
    expect("issue" in (stored[0] as object)).toBe(false);
    // A reader that asks for it gets the plain title and the field.
    expect((await box.run({ issues: true })).items).toMatchObject([{ title: "Rotate the deploy key", issue }]);
    // An older reader gets the stored row, link in the title, no extra key.
    const legacy = (await box.run({})).items as Record<string, unknown>[];
    expect(legacy).toMatchObject([{ title: "Rotate the deploy key (issue: github.com/alaarab/phren#42)" }]);
    expect("issue" in legacy[0]).toBe(false);
    // The same add again writes nothing: the suffix is idempotent.
    expect((await box.run({ action: "add", title: "Rotate the deploy key", project: "phren", key, issue })).updated).toBeUndefined();
    // A re-add of the same key can change or drop the link; a repeated suffix is
    // never appended.
    await box.run({ action: "add", title: "Rotate the deploy key", project: "phren", key });
    expect((await box.run({ issues: true })).items).toMatchObject([{ title: "Rotate the deploy key" }]);
    expect("issue" in ((await box.run({ issues: true })).items as Record<string, unknown>[])[0]).toBe(false);
  });
  it("writes rows a 0.3.100 Hook reads, so a rollback keeps the inbox", async () => {
    // The row schema of that release, copied here: strict, so any key this build
    // adds would make the whole file unreadable there.
    const rowSchema03100 = z.object({
      id: z.string().uuid(), kind: z.enum(["manual", "needs-you", "blocked"]), title: z.string().min(1).max(500),
      createdAt: z.string().datetime(), updatedAt: z.string().datetime(), state: z.enum(["open", "resolved"]),
      resolvedAt: z.string().datetime().optional(), resolution: z.string().max(2000).optional(),
      project: z.string().max(200).optional(), computer: z.string().max(253).optional(),
      target: inboxTargetSchema.optional(), dispatch: z.string().uuid().optional(), actionId: z.string().max(200).optional(),
      source: z.string().max(500).optional(), live: z.boolean().optional(),
      command: z.string().min(1).max(4000).optional(), task: z.string().max(40).optional(),
      pr: z.string().max(1000).optional(), key: z.string().min(1).max(200).optional(),
    }).strict();
    const box = inbox();
    await box.run({ action: "add", title: "Rotate the deploy key", command: "true", task: "bid:c2cc33d0", issue: "github.com/alaarab/phren#42" });
    await box.run({ action: "add", title: "Approve the release", key: "release" });
    const stored = JSON.parse(await readFile(path.join(root, "owner-inbox.json"), "utf8"));
    expect(z.array(rowSchema03100).parse(stored)).toHaveLength(2);
    expect(stored[0].title).toBe("Rotate the deploy key (issue: github.com/alaarab/phren#42)");
  });
  it("folds an issue key from the previous build into the title", async () => {
    const file = path.join(root, "owner-inbox.json"), issue = "github.com/alaarab/phren#42";
    const row: InboxItem = { id: randomUUID(), kind: "manual", title: "Rotate the deploy key", state: "open", createdAt: at, updatedAt: at };
    await writeFile(file, JSON.stringify([{ ...row, issue }]));
    expect(await inbox().run({})).toMatchObject({ items: [{ title: `${row.title} (issue: ${issue})` }] });
    const stored = JSON.parse(await readFile(file, "utf8"));
    expect(stored).toEqual([{ ...row, title: `${row.title} (issue: ${issue})` }]);
    expect((await inbox().run({ issues: true })).items).toMatchObject([{ title: row.title, issue }]);
  });
  it("rejects an issue link that is not a canonical safe-integer ref", async () => {
    const box = inbox();
    for (const issue of ["alaarab/phren#42", "github.com/alaarab/phren", "github.com/alaarab/phren#0", "github.com/alaarab/phren#01",
      "github.com/alaarab#42", "github.com/alaarab/phren#42x", "https://github.com/alaarab/phren/issues/42", "GitHub.com/alaarab/phren#42",
      "github.com/alaarab/phren#9007199254740992", "github.com/../phren#42", "github.com/./phren#42", "github.com//phren#42",
      "github.com/alaarab/#42", "github.com/ala arab/phren#42", ".com/alaarab/phren#42", "github..com/alaarab/phren#42"]) {
      await expect(box.run({ action: "add", title: "Bad link", issue })).rejects.toThrow(z.ZodError);
    }
    // 300 characters is the most one link may carry, and their fields are safe
    // integers up to the platform's own bound.
    await expect(box.run({ action: "add", title: "Too long", issue: `github.com/${"a".repeat(300)}/r#1` })).rejects.toThrow(z.ZodError);
    expect(parseIssueLink("github.com/alaarab/phren#9007199254740991")).toEqual({ repo: "github.com/alaarab/phren", number: 9007199254740991 });
    expect((await box.run({ action: "add", title: "Largest", issue: "github.com/alaarab/phren#9007199254740991" })).item)
      .toMatchObject({ title: "Largest (issue: github.com/alaarab/phren#9007199254740991)" });
    // Composition is exact: a title that fits is stored whole, never trimmed.
    const budget = titleBudget("github.com/alaarab/phren#42");
    const longest = inboxIssueTitle({ title: "x".repeat(budget), issue: "github.com/alaarab/phren#42" });
    expect(longest.length).toBe(INBOX_TITLE_LIMIT);
    expect(longest).toBe(`${"x".repeat(budget)} (issue: github.com/alaarab/phren#42)`);
    expect(issueInTitle(longest)).toEqual({ title: "x".repeat(budget), issue: "github.com/alaarab/phren#42" });
  });
  it("refuses a linked title that does not fit instead of trimming it", async () => {
    const box = inbox(), issue = "github.com/alaarab/phren#42", budget = titleBudget(issue);
    await expect(box.run({ action: "add", title: "x".repeat(budget + 1), issue }))
      .rejects.toMatchObject({ status: 400, message: `Title too long with an issue link: shorten it to ${budget} characters.` });
    // A title without a link keeps its own 500-character bound.
    expect((await box.run({ action: "add", title: "y".repeat(500) })).item).toMatchObject({ title: "y".repeat(500) });
    await expect(box.run({ action: "add", title: "y".repeat(501) })).rejects.toThrow(z.ZodError);
  });
  it("keeps linked titles that differ only at the end distinct across edits", async () => {
    const box = inbox(), issue = "github.com/alaarab/phren#42", key = "deploy-key", budget = titleBudget(issue);
    const id = "55555555-5555-4555-8555-555555555555";
    // Both fit exactly, and differ only in the last character a trim would drop.
    const first = `${"a".repeat(budget - 1)}1`, second = `${"a".repeat(budget - 1)}2`;
    const one = (await box.run({ action: "add", id, title: first, key, issue })).item as InboxItem;
    const two = (await box.run({ action: "add", id, title: second, key, issue })).item as InboxItem;
    expect(one.title).toBe(`${first} (issue: ${issue})`);
    expect(two.title).toBe(`${second} (issue: ${issue})`);
    expect(two.title).not.toBe(one.title);
    // The edit is a real revision change, so a close at the old one is stale.
    expect(two.updatedAt).not.toBe(one.updatedAt);
    expect((await box.run({}))).toMatchObject({ items: [{ id, title: two.title }] });
    await expect(box.close(id, one.updatedAt, "resolve")).rejects.toMatchObject({ status: 409 });
    // A resolved item reopens when its title changes.
    await box.run({ action: "resolve", id });
    expect(await box.run({ action: "add", id, title: first, key, issue }))
      .toMatchObject({ reopened: true, item: { id, title: one.title, state: "open" } });
  });
  it("keeps the link inside APNs's 500-byte alert body", async () => {
    const issue = "github.com/alaarab/phren#42";
    // Four bytes each, and a surrogate pair each: the cut must not split one.
    const title = pushIssueTitle({ title: "😀".repeat(200), issue });
    expect(Buffer.byteLength(title, "utf8")).toBeLessThanOrEqual(500);
    expect(title.endsWith(` (issue: ${issue})`)).toBe(true);
    expect(title).not.toContain("\ufffd");
    const { ownerInboxPushBody } = await import("./push.js");
    expect(ownerInboxPushBody(title)).toBe(title);
    // A plain title is left alone.
    expect(pushIssueTitle({ title: "Rotate the deploy key" })).toBe("Rotate the deploy key");
  });
  it("matches the conformance fixture's legacy and issue-reader shapes", async () => {
    const fixture = JSON.parse(await readFile(new URL("../../fixtures/conformance/owner-inbox-issue.json", import.meta.url), "utf8"));
    // The stored row is exactly what an older reader gets back.
    expect(inboxWire(fixture.stored)).toEqual(fixture.legacyReader);
    expect(fixture.stored).toEqual(fixture.legacyReader);
    expect(inboxWire(fixture.stored, true)).toEqual(fixture.issueReader);
    // The write path derives the stored title from the plain title and the link.
    expect(inboxIssueTitle({ title: fixture.issueReader.title, issue: fixture.issueReader.issue })).toBe(fixture.stored.title);
    // The documented Item shape is strict: the stored row parses, and the
    // structured one only parses in a build that knows `issue`.
    const legacyItem = z.object({
      id: z.string().uuid(), kind: z.enum(["manual", "needs-you", "blocked"]), title: z.string(),
      state: z.enum(["open", "resolved"]), createdAt: z.string(), updatedAt: z.string(), project: z.string().optional(),
    }).strict();
    expect(legacyItem.safeParse(fixture.legacyReader).success).toBe(true);
    expect(legacyItem.safeParse(fixture.issueReader).success).toBe(false);
  });
  it("matches the normalized PR even when only one add carries a key", async () => {
    const box = inbox(), pr = "https://github.com/alaarab/phren/pull/877";
    const first = (await box.run({ action: "add", title: "Merge", pr, key: "release" })).item as InboxItem;
    const next = await box.run({ action: "add", title: "Merge now", pr: `${pr}/` });
    expect(next).toMatchObject({ updated: true, item: { id: first.id, title: "Merge now", pr } });
    expect((await box.run({})).items).toHaveLength(1);
  });
  it("rejects a key or explicit id that conflicts with another open item's PR", async () => {
    const box = inbox(), pr = "https://github.com/alaarab/phren/pull/877";
    const a = (await box.run({ action: "add", title: "Merge", pr })).item as InboxItem;
    const b = (await box.run({ action: "add", title: "Publish", key: "release" })).item as InboxItem;
    await expect(box.run({ action: "add", title: "Merge and publish", pr, key: "release" })).rejects.toMatchObject({ status: 409 });
    await box.run({ action: "resolve", id: b.id });
    await expect(box.run({ action: "add", id: b.id, title: "Merge and publish", pr })).rejects.toMatchObject({ status: 409 });
    expect((await box.run({ includeResolved: true })).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: a.id, state: "open", title: "Merge", pr }),
      expect.objectContaining({ id: b.id, state: "resolved", title: "Publish", key: "release" }),
    ]));
  });
  it("upserts by explicit key, by the default pr key and by id; an unchanged re-add writes nothing", async () => {
    const box = inbox(), file = path.join(root, "owner-inbox.json");
    const first = (await box.run({ action: "add", title: "Renew the certificate", command: "certbot renew", key: "certs:weekly" })).item as InboxItem;
    const updated = await box.run({ action: "add", title: "Renew the certificate again", command: "certbot renew --quiet", key: "certs:weekly" });
    expect(updated.updated).toBe(true);
    expect(updated.item).toMatchObject({ id: first.id, title: "Renew the certificate again", command: "certbot renew --quiet" });
    const pr = "https://github.com/alaarab/phren/pull/877";
    const prFirst = (await box.run({ action: "add", title: "Merge the release", pr })).item as InboxItem;
    const prAgain = await box.run({ action: "add", title: "Merge the release now", pr: `${pr}/` });
    expect(prAgain.updated).toBe(true);
    expect(prAgain.item).toMatchObject({ id: prFirst.id, title: "Merge the release now", pr });
    expect((await box.run({})).items).toHaveLength(2);
    const before = await readFile(file, "utf8");
    const unchanged = await box.run({ action: "add", title: "Merge the release now", pr });
    expect(unchanged.updated).toBeUndefined();
    expect(await readFile(file, "utf8")).toBe(before);
    await box.run({ action: "resolve", id: first.id, resolution: "done" });
    const fresh = await box.run({ action: "add", title: "Renew the certificate", command: "certbot renew", key: "certs:weekly" });
    expect(fresh.updated).toBeUndefined();
    expect((fresh.item as InboxItem).id).not.toBe(first.id);
  });
  it("reopens a resolved manual item when its explicit id brings changed fields; an identical retry stays resolved", async () => {
    const box = inbox(), id = "22222222-2222-4222-8222-222222222222";
    const add = { action: "add", id, title: "Renew the token", command: "phren secret login", project: "hub" };
    await box.run(add);
    await box.run({ action: "resolve", id, resolution: "done: token renewed" });
    const retry = await box.run(add);
    expect(retry.reopened).toBeUndefined();
    expect(retry.item).toMatchObject({ id, state: "resolved", title: "Renew the token", resolution: "done: token renewed" });
    const reopened = await box.run({ ...add, title: "Renew the newer token" });
    expect(reopened.reopened).toBe(true);
    expect(reopened.item).toMatchObject({ id, state: "open", title: "Renew the newer token", command: "phren secret login" });
    expect((reopened.item as InboxItem).resolvedAt).toBeUndefined();
    expect((reopened.item as InboxItem).resolution).toBeUndefined();
    // Older Hooks use a strict row schema. Keep push metadata out of it.
    const { paste: _, ...row } = reopened.item as InboxItem & { paste: string };
    expect(JSON.parse(await readFile(path.join(root, "owner-inbox.json"), "utf8"))).toEqual([row]);
    expect((await inbox().run({})).items).toMatchObject([{ id, state: "open" }]);
  });
  it("moves a previous build's inline reopen marker to durable push suppression", async () => {
    const file = path.join(root, "owner-inbox.json");
    const row: InboxItem = {
      id: randomUUID(), kind: "manual", title: "Previously reopened", state: "open", createdAt: at, updatedAt: at,
    };
    await writeFile(file, JSON.stringify([{ ...row, reopened: true }]));
    expect((await inbox().run({})).items).toEqual([row]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([row]);
    expect(await inbox().tick()).toEqual([{ ...row, firstOpen: false }]);
  });
  it("still refuses an explicit id that names an automatic row", async () => {
    sources = [{ source: "prompt:1", kind: "blocked", title: "Approve the tool" }];
    const [auto] = (await inbox().run({})).items as InboxItem[];
    await expect(inbox().run({ action: "add", id: auto.id, title: "Approve it all" })).rejects.toThrow("another item");
  });
  it.skipIf(process.platform === "win32")("only runs the pasted resolve after a successful multiline command", async () => {
    const box = inbox();
    const run = async (command: string) => {
      const { item } = await box.run({ action: "add", title: "Merge", command });
      const { paste } = item as { paste: string };
      return spawnSync("sh", ["-c", `phren() { printf 'resolved'; }\n${paste}`], { encoding: "utf8" });
    };
    const failed = await run("false\nprintf 'merged'");
    expect(failed.status).toBe(1);
    expect(failed.stdout).toBe("");
    const succeeded = await run("true\nprintf '%s ' 'merged'");
    expect(succeeded.status).toBe(0);
    expect(succeeded.stdout).toBe("merged resolved");
  });
  it("rejects pasted resolves after an update or same-id reopen, even within one millisecond", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(at));
    const box = inbox(), id = randomUUID();
    const add = { action: "add", id, title: "Approve", command: "true" };
    const revision = (item: unknown) => (item as { paste: string }).paste.match(/--if-updated-at (\S+)/)?.[1];
    const resolve = (ifUpdatedAt: string | undefined) => box.run({ action: "resolve", id, ifUpdatedAt });
    const first = revision((await box.run(add)).item);
    const second = revision((await box.run({ ...add, title: "Approve the update" })).item);
    await expect(resolve(first)).rejects.toMatchObject({ status: 409 });
    await expect(resolve(second)).resolves.toMatchObject({ item: { state: "resolved" } });
    const reopened = revision((await box.run({ ...add, title: "Approve the replacement" })).item);
    await expect(resolve(second)).rejects.toMatchObject({ status: 409 });
    expect((await box.run({})).items).toMatchObject([{ id, state: "open", title: "Approve the replacement" }]);
    await expect(resolve(reopened)).resolves.toMatchObject({ item: { state: "resolved" } });
  });
  it("auto-resolves the manual items the done probe reports, and only those", async () => {
    const done = vi.fn(async (items: InboxItem[]) => new Map<string, string>(items.filter(item => item.title === "A").map(item => [item.id, "done: PR merged"])));
    const box = new OwnerInbox(async () => sources, path.join(root, "owner-inbox.json"), done);
    const a = (await box.run({ action: "add", title: "A" })).item as InboxItem;
    const b = (await box.run({ action: "add", title: "B" })).item as InboxItem;
    await box.tick();
    expect(done.mock.calls[0][0].map(item => item.id)).toEqual([a.id, b.id]);
    expect((await box.run({})).items).toMatchObject([{ id: b.id, state: "open" }]);
    expect((await box.run({ includeResolved: true })).items).toMatchObject([
      { id: a.id, state: "resolved", resolution: "done: PR merged" }, { id: b.id, state: "open" }]);
    done.mockClear();
    await box.run({ action: "add", title: "C" });
    await box.run({ action: "resolve", id: b.id, resolution: "owner answered" });
    expect(done).not.toHaveBeenCalled();
  });
  it("leaves manual items untouched when the done probe fails", async () => {
    const failing = new OwnerInbox(async () => sources, path.join(root, "failing.json"), async () => { throw new Error("forge down"); });
    await failing.run({ action: "add", title: "Merge the release" });
    await failing.tick();
    const rows = (await failing.run({ includeResolved: true })).items as InboxItem[];
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("open");
    expect(rows[0].resolvedAt).toBeUndefined();
    expect(rows[0].resolution).toBeUndefined();
  });
  it("recomputes paste per inbox computer, overwriting a peer's", async () => {
    vi.mocked(hookPeers).mockResolvedValue([linked("Desk")] as never);
    const id = "33333333-3333-4333-8333-333333333333";
    vi.mocked(peerRequest).mockResolvedValue({ items: [
      { id, kind: "manual", state: "open", title: "Remote merge", command: "gh pr merge 9", updatedAt: at, paste: "stale from the peer" },
    ] });
    const box = inbox();
    const local = (await box.run({ action: "add", title: "Log in to the forge", command: "gh auth login" })).item as InboxItem;
    const view = await ownerInboxView(box, {});
    expect(view.items).toMatchObject([
      { title: "Log in to the forge", inboxComputer: "local", paste: `gh auth login && phren owner-inbox resolve ${local.id} --resolution done --if-updated-at ${local.updatedAt}` },
      { id, inboxComputer: "Desk", paste: `gh pr merge 9 && phren owner-inbox resolve ${id} --resolution done --if-updated-at ${at} --computer Desk` },
    ]);
  });
  it("routes a directly added remote action's paste and guarded resolve to its owning Hook", async () => {
    vi.mocked(hookPeers).mockResolvedValue([linked("Desk")] as never);
    const box = inbox(), remote = new OwnerInbox(undefined, path.join(root, "desk.json"));
    vi.mocked(peerRequest).mockImplementation(async (_peer, route, body) => {
      if (route === "/v1/health") return { capabilities: { ownerInboxActions: true } };
      if (route === "/v1/owner-inbox?local=1") return remote.run({ action: "list" });
      return remote.run(body);
    });
    const command = "gh pr merge 9";
    const added = await ownerInboxView(box, { action: "add", computer: "Desk", title: "Merge remotely", command });
    const { id, updatedAt } = added.item as InboxItem;
    expect(added.item).toMatchObject({ inboxComputer: "Desk", paste: `${command} && phren owner-inbox resolve ${id} --resolution done --if-updated-at ${updatedAt} --computer Desk` });
    expect((await ownerInboxView(box, { action: "list", computer: "Desk" })).items).toEqual([added.item]);
    const resolved = await ownerInboxView(box, { action: "resolve", computer: "Desk", id, ifUpdatedAt: updatedAt });
    expect(resolved.item).toMatchObject({ inboxComputer: "Desk", id, state: "resolved" });
    expect((await remote.run({})).items).toEqual([]);
    expect((await box.run({ includeResolved: true })).items).toEqual([]);
  });
  it("preserves legacy remote writes and reports unsupported fields before contacting the old write route", async () => {
    vi.mocked(hookPeers).mockResolvedValue([linked("Desk")] as never);
    const box = inbox(), remote = new OwnerInbox(undefined, path.join(root, "desk.json"));
    const legacy = z.object({ action: z.enum(["add", "resolve"]), id: z.string().uuid(), title: z.string().optional(), resolution: z.string().optional() }).strict();
    vi.mocked(peerRequest).mockImplementation(async (_peer, route, body) => route === "/v1/health"
      ? { capabilities: { ownerInbox: true } } : remote.run(legacy.parse(body)));
    const id = randomUUID();
    const add = { action: "add", computer: "Desk", id, title: "Approve remotely" };
    const resolve = { action: "resolve", computer: "Desk", id, resolution: "Approved" };
    await expect(ownerInboxView(box, add)).resolves.toMatchObject({ item: { inboxComputer: "Desk", id, state: "open" } });
    for (const input of [
      { ...add, command: "true" }, { ...add, task: "bid:c2cc33d0" }, { ...add, pr: "https://github.com/o/r/pull/9" },
      { ...add, key: "release" }, { ...resolve, ifUpdatedAt: at },
    ]) await expect(ownerInboxView(box, input)).rejects.toMatchObject({ status: 409, details: { code: "owner-inbox-actions-unsupported" } });
    await expect(ownerInboxView(box, resolve)).resolves.toMatchObject({ item: { inboxComputer: "Desk", id, state: "resolved" } });
    expect(vi.mocked(peerRequest).mock.calls.filter(([, route]) => route === "/v1/owner-inbox")).toHaveLength(2);
  });
  it("refuses an issue link on a peer Hook without the capability and forwards it to one that has it", async () => {
    vi.mocked(hookPeers).mockResolvedValue([linked("Desk")] as never);
    const box = inbox(), issue = "github.com/alaarab/phren#42";
    vi.mocked(peerRequest).mockImplementation(async (_peer, route) => route === "/v1/health"
      ? { capabilities: { ownerInboxActions: true } } : { ok: true, item: {} });
    await expect(ownerInboxView(box, { action: "add", computer: "Desk", title: "Rotate the deploy key", issue }))
      .rejects.toMatchObject({ status: 409, details: { code: "owner-inbox-issues-unsupported" } });

    // A peer that advertises the capability takes the link; this Hook's answer
    // flag never crosses, because an older strict schema would reject it.
    const remote = new OwnerInbox(undefined, path.join(root, "desk.json")), bodies: unknown[] = [];
    vi.mocked(peerRequest).mockImplementation(async (_peer, route, body) => {
      if (route === "/v1/health") return { capabilities: { ownerInboxActions: true, ownerInboxIssues: true } };
      bodies.push(body);
      const asked = route.includes("issues=1");
      if (route.startsWith("/v1/owner-inbox?local=1")) return remote.run({ action: "list", issues: asked });
      // An upgraded peer honors `issues=1` on the write route too.
      return remote.run({ ...(body as object), ...(asked ? { issues: true } : {}) });
    });
    const added = await ownerInboxView(box, { action: "add", computer: "Desk", title: "Rotate the deploy key", issue, issues: true });
    expect(added.item).toMatchObject({ inboxComputer: "Desk", title: "Rotate the deploy key", issue });
    expect(bodies[0]).toMatchObject({ issue });
    expect("issues" in (bodies[0] as object)).toBe(false);
    // A reader that does not ask sees the link only in the title.
    expect((await ownerInboxView(box, { action: "list", computer: "Desk" })).items)
      .toMatchObject([{ title: "Rotate the deploy key (issue: github.com/alaarab/phren#42)" }]);
    // One that does ask for it receives the stored link.
    expect((await ownerInboxView(box, { action: "list", computer: "Desk", issues: true })).items)
      .toMatchObject([{ title: "Rotate the deploy key", issue }]);
  });
  it("retires automatic waits when answered and preserves manual decisions and history", async () => {
    const box = inbox();
    await box.run({ action: "add", title: "Choose the release window" });
    sources = [{ source: "question:1", kind: "needs-you", title: "Choose a target" },
      { source: "approval:1", kind: "blocked", title: "Approve the tool", actionId: "ask1" }];
    expect((await box.run({})).items).toHaveLength(3);
    sources = [];
    await box.tick();
    expect((await box.run({})).items).toMatchObject([{ kind: "manual", title: "Choose the release window" }]);
    expect((await box.run({ includeResolved: true })).items).toMatchObject([
      { kind: "manual", state: "open" },
      { state: "resolved", live: false, resolution: "stale: source gone" },
      { state: "resolved", live: false, resolution: "stale: source gone" },
    ]);
  });
  it("updates one item despite changing prompt timestamps and countdowns; separates questions and sessions", async () => {
    const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex" as const, session: "11111111-1111-4111-8111-111111111111" };
    sources = [{ source: "prompt:old-timestamp", target, kind: "blocked", title: "Auto-resolves in 3s" }];
    const first = (await inbox().run({})).items as InboxItem[];
    sources = [{ ...sources[0], source: "prompt:new-timestamp", title: "Auto-resolves in 2s" }];
    expect((await inbox().run({})).items).toMatchObject([{ id: first[0].id, title: "Auto-resolves in 2s" }]);
    expect((await inbox().run({})).items).toHaveLength(1);
    sources = ["q1", "q2"].map(actionId => ({ ...sources[0], actionId }));
    expect((await inbox().run({})).items).toHaveLength(2);
    sources = [{ ...sources[0], target: { ...target, session: "22222222-2222-4222-8222-222222222222" } }];
    expect((await inbox().run({})).items).toMatchObject([{ target: { session: "22222222-2222-4222-8222-222222222222" } }]);
    expect((await inbox().run({})).items).toHaveLength(1);
  });
  it("keeps an owner dismissal through repeated polls, but allows a new wait after the source disappears", async () => {
    sources = [{ source: "prompt:1", kind: "blocked", title: "Approve the tool" }];
    const box = inbox(), [first] = (await box.run({})).items as InboxItem[];
    await box.run({ action: "resolve", id: first.id, resolution: "stale: dismissed by owner" });
    expect((await inbox().run({})).items).toEqual([]);
    sources = []; await inbox().tick();
    sources = [{ source: "prompt:1", kind: "blocked", title: "Next tool" }];
    const [next] = (await inbox().run({})).items as InboxItem[];
    expect(next.id).not.toBe(first.id);
    sources = []; await inbox().tick();
    sources = [{ source: "prompt:1", kind: "blocked", title: "Another wait" }];
    expect((await inbox().run({})).items).toHaveLength(1);
  });
  it("closes with the exact revision, distinguishing a stale and an already handled row", async () => {
    const box = inbox(), id = "44444444-4444-4444-8444-444444444444";
    await box.run({ action: "add", id, title: "OVH US VPS-2 is in stock" });
    const [first] = (await box.run({})).items as InboxItem[];
    await expect(box.close(id, "2020-01-01T00:00:00.000Z", "resolve")).rejects.toMatchObject({ status: 409 });
    await expect(box.close(randomUUID(), first.updatedAt, "resolve")).rejects.toMatchObject({ status: 404 });
    const resolved = await box.close(id, first.updatedAt, "resolve");
    expect(resolved).toMatchObject({ id, state: "resolved", resolution: "done" });
    expect(resolved.resolvedAt).toBe(resolved.updatedAt);
    expect(Date.parse(resolved.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));
    await expect(box.close(id, resolved.updatedAt, "dismiss")).rejects.toMatchObject({ status: 409 });
    expect((await box.run({ includeResolved: true })).items).toMatchObject([{ id, state: "resolved", resolution: "done" }]);
    const other = (await box.run({ action: "add", title: "Turn off the old VPS" })).item as InboxItem;
    expect(await box.close(other.id, other.updatedAt, "dismiss")).toMatchObject({ state: "resolved", resolution: "dismissed" });
    expect((await box.run({})).items).toEqual([]);
  });
  it("suppresses a closed live wait until it ends, and keeps that suppression through an unavailable dispatch", async () => {
    const dispatch = randomUUID();
    const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex" as const, session: randomUUID() };
    const wait: InboxSource = { source: "prompt:1", kind: "blocked", title: "Approve the tool", dispatch, computer: "Desk", target };
    const box = inbox();
    sources = [wait];
    const [first] = (await box.run({})).items as InboxItem[];
    const closed = await box.close(first.id, first.updatedAt, "dismiss");
    expect(closed).toMatchObject({ state: "resolved", resolution: "dismissed", live: true });
    // The same wait is still running; it must not come back as a new row.
    sources = [wait];
    expect((await inbox().run({})).items).toEqual([]);
    // Its dispatch cannot be read: the suppression stays.
    const offline = new OwnerInbox(async () => ({ sources: [], unavailableDispatches: [dispatch] }), path.join(root, "owner-inbox.json"));
    await offline.tick();
    expect((await offline.run({})).items).toEqual([]);
    expect((await inbox().run({})).items).toEqual([]);
    // The wait ends; a later distinct wait on the same pane is a new row.
    sources = []; await inbox().tick();
    sources = [{ ...wait, source: "prompt:2", actionId: "ask2" }];
    const [next] = (await inbox().run({})).items as InboxItem[];
    expect(next.id).not.toBe(first.id);
    expect(next).toMatchObject({ state: "open", live: true });
  });
  it("returns the open snapshot a push sweep reads from a tick", async () => {
    sources = [{ source: "prompt:1", kind: "needs-you", title: "Choose a target" }];
    const box = inbox();
    await box.run({ action: "add", title: "Restart the router" });
    const items = await box.tick();
    expect(items.map(item => item.title).sort()).toEqual(["Choose a target", "Restart the router"]);
    sources = [];
    expect(await box.tick()).toEqual([expect.objectContaining({ title: "Restart the router" })]);
  });
  it("migrates legacy stale and duplicate rows once without touching manual items", async () => {
    const at = "2026-10-06T10:00:00.000Z", target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex", session: "11111111-1111-4111-8111-111111111111" };
    const row = { kind: "blocked", title: "codex needs terminal input.", state: "open", createdAt: at, updatedAt: at };
    const manual = { ...row, id: randomUUID(), kind: "manual", title: "Owner decision" };
    await writeFile(path.join(root, "owner-inbox.json"), JSON.stringify([
      manual, { ...row, id: randomUUID(), source: "gone", live: true },
      { ...row, id: randomUUID(), source: "ended", live: false },
      { ...row, id: randomUUID(), source: "old1", target, live: true },
      { ...row, id: randomUUID(), source: "old2", target, live: true },
    ]));
    sources = [{ source: "new", target: target as InboxSource["target"], kind: "blocked", title: "Still waiting" }];
    expect((await inbox().run({})).items).toHaveLength(2);
    const migrated = await readFile(path.join(root, "owner-inbox.json"), "utf8");
    const rows = JSON.parse(migrated) as InboxItem[];
    expect(rows[0]).toEqual(manual);
    expect(rows.slice(1, 3)).toMatchObject([{ state: "resolved", resolution: "stale: source gone", live: false }, { state: "resolved", resolution: "stale: source gone", live: false }]);
    expect(rows[4]).toMatchObject({ state: "resolved", resolution: "duplicate: source" });
    await inbox().tick();
    expect(await readFile(path.join(root, "owner-inbox.json"), "utf8")).toBe(migrated);
  });
  it("hides an unverified remote wait without resolving it during an outage", async () => {
    const dispatch = randomUUID();
    sources = [{ source: "remote", dispatch, computer: "Desk", kind: "needs-you", title: "Choose a target" }];
    await inbox().tick();
    const offline = new OwnerInbox(async () => ({ sources: [], unavailableDispatches: [dispatch] }), path.join(root, "owner-inbox.json"));
    expect((await offline.run({})).items).toEqual([]);
    expect((await offline.run({ includeResolved: true })).items).toMatchObject([{ state: "open", live: false }]);
    expect((await inbox().run({})).items).toMatchObject([{ state: "open", live: true }]);
  });
  it("preserves every resolve from eight concurrent processes", async () => {
    const ids = Array.from({ length: 24 }, () => randomUUID());
    for (const id of ids) await inbox().run({ action: "add", id, title: `Decision ${id}` });
    const script = path.join(root, "writer.mjs");
    await writeFile(script, `import { OwnerInbox } from ${JSON.stringify(new URL("./owner-inbox.ts", import.meta.url).href)};
      process.send('ready');
      process.once('message', async ({ file, ids }) => {
        try {
          const box = new OwnerInbox(async () => { await new Promise(r => setTimeout(r, 40)); return []; }, file);
          for (const id of ids) await box.run({ action: 'resolve', id, resolution: 'owner answered' });
          process.disconnect();
        } catch (e) { console.error(e); process.exit(1); }
      });`);
    const children = Array.from({ length: 8 }, () => fork(script, { execArgv: ["--import", import.meta.resolve("tsx")], stdio: ["ignore", "ignore", "pipe", "ipc"] }));
    const finished = children.map(child => new Promise<void>((resolve, reject) => {
      let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr || `writer exited ${code}`)));
    }));
    try {
      await Promise.all(children.map(child => new Promise(resolve => child.once("message", resolve))));
      children.forEach((child, index) => child.send({ file: path.join(root, "owner-inbox.json"), ids: ids.slice(index * 3, index * 3 + 3) }));
      await Promise.all(finished);
    } finally { children.forEach(child => child.kill()); }
    expect((await inbox().run({})).items).toEqual([]);
    const rows = (await inbox().run({ includeResolved: true })).items as InboxItem[];
    expect(rows).toHaveLength(24);
    expect(rows.every(row => row.state === "resolved" && row.resolution === "owner answered")).toBe(true);
  }, 30_000);
  it("filters legacy stale peer rows and merges a forwarded approval with its worker inbox", async () => {
    const target = { server: "default", workspace: "w1", tab: "t1", pane: "p1", source: "codex" as const, session: "11111111-1111-4111-8111-111111111111" };
    sources = [{ source: "dispatch:1", kind: "blocked", title: "Approve test run", computer: "Desk", target, actionId: "q1" }];
    vi.mocked(hookPeers).mockResolvedValue([linked("Desk")] as never);
    vi.mocked(peerRequest).mockResolvedValue({ items: [
      { id: "stale", kind: "blocked", state: "open", live: false },
      { id: "manual", kind: "manual", state: "open", title: "Owner decision" },
      { id: "duplicate", kind: "blocked", state: "open", live: true, target, actionId: "q1" },
    ] });
    expect((await ownerInboxView(inbox(), {})).items).toMatchObject([
      { title: "Approve test run", inboxComputer: "local" }, { id: "manual", inboxComputer: "Desk" },
    ]);
    expect((await ownerInboxView(inbox(), { includeResolved: true })).items).toHaveLength(4);
  });
  it("lists peer inboxes without recursion, reports unreachable peers and routes resolution to the owning Hook", async () => {
    vi.mocked(hookPeers).mockResolvedValue([linked("Desk"), linked("Offline")] as never);
    vi.mocked(peerRequest).mockImplementation(async (peer, route, body) => {
      if (peer.name === "Offline") throw Error("offline");
      return body ? { ok: true, item: { id: "remote-id", state: "resolved" } } : { items: [{ id: "remote-id", kind: "manual", title: "Remote question" }] };
    });
    const view = await ownerInboxView(inbox(), { action: "list" });
    expect(view.items).toMatchObject([{ inboxComputer: "Desk" }]); expect(view.unreachable).toMatchObject([{ computer: "Offline" }]);
    expect(peerRequest).toHaveBeenCalledWith(expect.objectContaining({ name: "Desk" }), "/v1/owner-inbox?local=1");
    await ownerInboxView(inbox(), { action: "resolve", computer: "Desk", id: "11111111-1111-4111-8111-111111111111" });
    expect(peerRequest).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Desk" }), "/v1/owner-inbox", expect.objectContaining({ action: "resolve" }));
  });
});
