import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type Handler = (input: unknown, output?: unknown) => Promise<void>;

const saved = { store: process.env.PHREN_PATH, job: process.env.PHREN_FANOUT_JOB };
const roots: string[] = [];
afterEach(async () => {
  if (saved.store === undefined) delete process.env.PHREN_PATH; else process.env.PHREN_PATH = saved.store;
  if (saved.job === undefined) delete process.env.PHREN_FANOUT_JOB; else process.env.PHREN_FANOUT_JOB = saved.job;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("records the conversation this OpenCode process shows by PID, never a subagent's", async () => {
  const store = await mkdtemp(path.join(tmpdir(), "phren-oc-pid-")); roots.push(store);
  process.env.PHREN_PATH = store;
  delete process.env.PHREN_FANOUT_JOB;
  const url = new URL("../../plugins/opencode/phren-transcript.js", import.meta.url);
  const { PhrenTranscriptPlugin } = await import(url.href) as { PhrenTranscriptPlugin: () => Promise<Record<string, Handler>> };
  const handlers = await PhrenTranscriptPlugin();
  const file = path.join(store, ".runtime", "sessions", `opencode-pid-${process.pid}.json`);
  const bound = async () => JSON.parse(await readFile(file, "utf8")).session as string;
  const message = (sessionID: string) => handlers["chat.message"]({ sessionID }, { message: { id: `msg_${sessionID}`, role: "user" }, parts: [] });

  await message("ses_parent1");
  expect(await bound()).toBe("ses_parent1");
  await handlers.event({ event: { type: "session.created", properties: { info: { id: "ses_child2", parentID: "ses_parent1" } } } });
  await message("ses_child2");
  expect(await bound()).toBe("ses_parent1");
  await message("ses_next3");
  expect(await bound()).toBe("ses_next3");
});
