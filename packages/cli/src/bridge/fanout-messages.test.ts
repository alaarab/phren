import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FanoutMessages } from "./fanout-messages.js";
import { fanoutChildren, manifestSchema } from "./fanouts.js";
import { publicChildAgents, TranscriptReader } from "./transcripts.js";
import { codex } from "../fanout/adapters/codex.js";
import { opencode } from "../fanout/adapters/opencode.js";

const parent = "aaaaaaaa-1111-4111-8111-111111111111";
const thread = "cccccccc-3333-4333-8333-333333333333";
const target = { server: "default", workspace: "w", tab: "w:t", pane: "w:p", source: "codex" as const, session: parent };
const roots: string[] = [];
const services: FanoutMessages[] = [];
afterEach(async () => {
  services.splice(0).forEach(service => service.close());
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(status: "running" | "completed" = "completed", provider: "codex" | "opencode" = "codex") {
  const scratch = path.resolve(".scratch"); await mkdir(scratch, { recursive: true });
  const store = await mkdtemp(path.join(scratch, "fanout-messages-")); roots.push(store);
  const directory = path.join(store, ".runtime/agent-fanouts/job-1");
  const worktree = path.join(store, "checkout");
  await mkdir(directory, { recursive: true }); await mkdir(worktree);
  const now = new Date().toISOString();
  const manifest = manifestSchema.parse({ schemaVersion: 1, id: "job-1", parent: { provider: "codex", session: parent },
    provider, session: provider === "codex" ? thread : "ses_worker42", taskLabel: "Parser checks", cwd: worktree, worktree,
    eventLog: "events.jsonl", model: "configured-model", createdAt: now, startedAt: now, updatedAt: now, status });
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  const original = provider === "codex"
    ? { type: "item.completed", item: { id: "original", type: "agent_message", text: "Original reply" } }
    : { type: "text", part: { type: "text", text: "Original reply" } };
  await writeFile(path.join(directory, "events.jsonl"), JSON.stringify(original) + "\n");
  const env = { ...process.env, PHREN_PATH: store };
  const validate = vi.fn(async () => ({}));
  const tree = () => fanoutChildren("codex", parent, env);
  const service = new FanoutMessages(env, { validate, tree }); services.push(service);
  const child = (await tree())[0].id;
  const finish = async () => writeFile(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest, status: "completed" }));
  // Real subprocess, fake harness: captures argv, cwd and stdin without contacting a provider.
  const bin = path.join(store, "bin"); await mkdir(bin);
  const executable = path.join(bin, provider);
  // OpenCode is served: the brief arrives through prompt_async, not stdin.
  await writeFile(executable, provider === "opencode" ? `#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
const clients = [];
const send = (type, properties) => { for (const client of clients) client.write('data: ' + JSON.stringify({ type, properties }) + '\\n\\n'); };
http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const url = new URL(req.url, 'http://fake');
    if (url.pathname === '/event') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('\\n'); clients.push(res); return; }
    if (url.pathname === '/session/ses_worker42') { res.end(JSON.stringify({ id: 'ses_worker42' })); return; }
    if (url.pathname === '/session/ses_worker42/prompt_async') {
      const data = JSON.parse(body);
      fs.writeFileSync('invocation.json', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), text: data.parts[0].text, model: data.model, agent: data.agent }));
      res.writeHead(204); res.end();
      send('session.status', { sessionID: 'ses_worker42', status: { type: 'busy' } });
      send('message.part.updated', { part: { id: 'prt_1', sessionID: 'ses_worker42', type: 'text', text: 'Resumed reply', time: { start: 1, end: 2 } } });
      send('session.status', { sessionID: 'ses_worker42', status: { type: 'idle' } });
      return;
    }
    res.writeHead(404); res.end('{}');
  });
}).listen(0, '127.0.0.1', function () { console.log('opencode server listening on http://127.0.0.1:' + this.address().port); });
` : `#!/usr/bin/env node
import fs from 'node:fs';
let text = '';
process.stdin.on('data', chunk => text += chunk);
process.stdin.on('end', () => {
  fs.writeFileSync('invocation.json', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), text }));
  console.log(JSON.stringify(${provider === "codex" ? '{ type: "item.completed", item: { id: "reply", type: "agent_message", text: "Resumed reply" } }' : '{ type: "text", part: { type: "text", text: "Resumed reply" } }'}));
});
`);
  await chmod(executable, 0o700);
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  return { store, directory, worktree, manifest, service, env, child, validate, finish };
}

describe("POST /v1/subagents/resume", () => {
  it.each(["codex", "opencode"] as const)("resumes a finished %s worker with stdin in its own worktree and keeps the same job", async provider => {
    const f = await fixture("completed", provider);
    const text = "Review the fix\n`literal` $(also literal)";
    const result = await f.service.send({ target, child: f.child, text });
    expect(f.validate).toHaveBeenCalledWith(target);
    expect(result).toMatchObject({ ok: true, message: { text, status: "running" } });
    await vi.waitFor(async () => expect((await f.service.list(target, f.child)).messages[0].status, await readFile(path.join(f.directory, "stderr.log"), "utf8")).toBe("completed"));
    const invocation = JSON.parse(await readFile(path.join(f.worktree, "invocation.json"), "utf8"));
    expect(invocation).toMatchObject({ text, cwd: f.worktree });
    expect(invocation.argv).toEqual(provider === "codex"
      ? ["exec", "resume", "--json", "-o", path.join(f.directory, "final.txt"), "-m", "configured-model", thread, "-"]
      : ["serve", "--hostname", "127.0.0.1", "--port", "0"]);
    if (provider === "opencode") expect(invocation).toMatchObject({ model: { providerID: "configured-model", modelID: "" }, agent: "build" });
    const saved = JSON.parse(await readFile(path.join(f.directory, "manifest.json"), "utf8"));
    expect(saved).toMatchObject({ id: "job-1", session: f.manifest.session, resumes: f.manifest.session, status: "completed" });
    expect(await readFile(path.join(f.directory, "rounds", result.message.id, "prompt.txt"), "utf8")).toBe(text);
    expect(await readFile(path.join(f.directory, "prompt.txt"), "utf8")).toBe(text);
    const transcript = await new TranscriptReader(path.join(f.directory, "events.jsonl"), provider).read();
    expect(JSON.stringify(transcript.entries)).toContain("Original reply");
    expect(JSON.stringify(transcript.entries)).toContain("Resumed reply");
    expect(JSON.stringify(transcript.entries)).toContain("Review the fix");
  });

  it("durably queues a running worker and resumes after it finishes, even with a new service", async () => {
    const f = await fixture("running");
    const receipt = await f.service.send({ target, child: f.child, text: "Next round" });
    expect(receipt.message.status).toBe("queued");
    await expect(readFile(path.join(f.worktree, "invocation.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const next = new FanoutMessages(f.env, { validate: f.validate, tree: () => fanoutChildren("codex", parent, f.env) }); services.push(next);
    expect((await next.list(target, f.child)).messages).toEqual([receipt.message]);
    await f.finish();
    await Promise.all([next.tick(), f.service.tick()]);
    await vi.waitFor(async () => expect((await next.list(target, f.child)).messages[0].status, await readFile(path.join(f.directory, "stderr.log"), "utf8")).toBe("completed"));
    const events = await readFile(path.join(f.directory, "events.jsonl"), "utf8");
    expect(events.split("phren/fanout-message")).toHaveLength(2);
  });

  it("refuses a worker from another store even when parent and job ids match", async () => {
    const first = await fixture(), other = await fixture();
    expect(first.child).not.toBe(other.child);
    await expect(first.service.send({ target, child: other.child, text: "Wrong store" })).rejects.toMatchObject({ status: 404 });
    expect((await other.service.list(target, other.child)).messages).toEqual([]);
    await rm(path.join(first.store, ".runtime/agent-fanouts"), { recursive: true });
    await symlink(path.join(other.store, ".runtime/agent-fanouts"), path.join(first.store, ".runtime/agent-fanouts"));
    await expect(first.service.send({ target, child: other.child, text: "Redirected store" })).rejects.toMatchObject({ status: 404 });
  });

  it("checks the live parent before writing and refuses in-process children", async () => {
    const f = await fixture();
    f.validate.mockRejectedValueOnce(new Error("Target changed"));
    await expect(f.service.send({ target, child: f.child, text: "Stale pane" })).rejects.toThrow("Target changed");
    const service = new FanoutMessages(f.env, { validate: f.validate,
      tree: async () => [{ ...(await fanoutChildren("codex", parent, f.env))[0], fanout: undefined }] });
    await expect(service.send({ target, child: f.child, text: "In process" })).rejects.toMatchObject({ status: 404 });
    expect((await f.service.list(target, f.child)).messages).toEqual([]);
  });

  it("returns an explicit failed receipt when the original worktree is gone, with no hidden queue", async () => {
    const f = await fixture();
    await rm(f.worktree, { recursive: true });
    const receipt = await f.service.send({ target, child: f.child, text: "Cannot start" });
    expect(receipt.message.status).toBe("failed");
    await f.service.tick();
    expect((await f.service.list(target, f.child)).messages).toEqual([receipt.message]);
  });

  it("publishes only a continuation capability, without the private session or job directory", async () => {
    const f = await fixture();
    const wire = JSON.stringify(publicChildAgents(await fanoutChildren("codex", parent, f.env)));
    expect(wire).toContain('"fanout":{"resumable":true}');
    expect(wire).not.toContain(thread); expect(wire).not.toContain(f.store);
  });

  it("uses the launcher resume arguments and lets OpenCode retain its configured model when absent", () => {
    const options = { job: "/home/sam/job", worktree: "/home/sam/project", model: "", resume: thread };
    expect(codex.argv(options)).toEqual(["exec", "resume", "--json", "-o", "/home/sam/job/final.txt", thread, "-"]);
    expect(opencode.argv({ ...options, resume: "ses_worker42" })).not.toContain("--model");
  });
});

describe("POST /v1/subagents/archive-finished", () => {
  it("validates the parent and archives its finished workers now", async () => {
    const f = await fixture("completed");
    await writeFile(path.join(f.directory, "exit.txt"), "0\n");
    expect(await f.service.archiveFinished({ target })).toEqual({ ok: true, archived: 1 });
    expect(f.validate).toHaveBeenCalledWith(target);
    await expect(readFile(path.join(f.directory, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fanoutChildren("codex", parent, f.env)).toEqual([]);
  });

  it("leaves a running worker and refuses a malformed body", async () => {
    const f = await fixture("running");
    expect(await f.service.archiveFinished({ target })).toEqual({ ok: true, archived: 0 });
    await expect(f.service.archiveFinished({ target, child: f.child })).rejects.toThrow();
    expect(await fanoutChildren("codex", parent, f.env)).toHaveLength(1);
  });
});
