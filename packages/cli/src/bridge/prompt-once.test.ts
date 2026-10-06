import { expect, it } from "vitest";
import { BridgeError } from "./protocol.js";
import { PromptOnce, promptScope } from "./prompt-once.js";

const target = { server: "default", workspace: "w1", tab: "w1:t1", pane: "w1:p1", source: "claude", session: "aaaaaaaa-1111-4111-8111-111111111111" };

it("types a message once per id and answers repeats with the first reply", async () => {
  const once = new PromptOnce();
  let typed = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const send = async (typing: () => void) => { typing(); typed++; await gate; return { ok: true, delivered: true }; };
  const scope = promptScope(target, "hello");
  const first = once.run("id-000001", scope, send), second = once.run("id-000001", scope, send);
  release();
  expect(await first).toEqual({ ok: true, delivered: true });
  expect(await second).toEqual({ ok: true, delivered: true, replayed: true });
  expect(await once.run("id-000001", scope, send)).toEqual({ ok: true, delivered: true, replayed: true });
  expect(typed).toBe(1);
  // Without an id every request runs.
  await once.run(undefined, scope, send); await once.run(undefined, scope, send);
  expect(typed).toBe(3);
});

it("reruns an attempt that failed before typing, and replays one that failed after", async () => {
  const once = new PromptOnce();
  const scope = promptScope(target, "hello");
  let runs = 0;
  await expect(once.run("id-000002", scope, async () => { runs++; throw new BridgeError(409, "changed"); })).rejects.toThrow("changed");
  expect(await once.run("id-000002", scope, async typing => { runs++; typing(); return { ok: true }; })).toEqual({ ok: true });
  expect(runs).toBe(2);
  const blocked = new BridgeError(409, "The conversation in this pane changed; the message was not delivered.");
  await expect(once.run("id-000003", scope, async typing => { typing(); throw blocked; })).rejects.toBe(blocked);
  await expect(once.run("id-000003", scope, async () => { runs++; return { ok: true }; })).rejects.toBe(blocked);
  expect(runs).toBe(2);
});

it("binds an id to one pane and text, not to the conversation, and forgets it after ten minutes", async () => {
  let now = 0;
  const once = new PromptOnce(() => now);
  const send = async (typing: () => void) => { typing(); return { ok: true }; };
  await once.run("id-000004", promptScope(target, "hello"), send);
  // A first message that started a conversation is retried with its new session.
  expect(await once.run("id-000004", promptScope({ ...target, session: "bbbbbbbb-1111-4111-8111-111111111111" }, "hello"), send))
    .toEqual({ ok: true, replayed: true });
  await expect(once.run("id-000004", promptScope(target, "other"), send)).rejects.toMatchObject({ status: 409 });
  await expect(once.run("id-000004", promptScope({ ...target, pane: "w1:p2" }, "hello"), send)).rejects.toMatchObject({ status: 409 });
  now = 600_001;
  expect(await once.run("id-000004", promptScope(target, "other"), send)).toEqual({ ok: true });
});
