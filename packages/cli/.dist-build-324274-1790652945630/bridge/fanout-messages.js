import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { archiveFinishedFanouts, containedFanoutRoot, fanoutChildID, manifestSchema, storeRoot } from "./fanouts.js";
import { atomic, BridgeError, targetSchema } from "./protocol.js";
import { childAgent } from "./transcripts.js";
import { countTick } from "./metrics.js";
export const fanoutMessageSchema = z.object({
    target: targetSchema,
    child: z.string().regex(/^[a-f0-9]{32}$/),
    text: z.string().min(1).max(32768).refine(value => value.trim().length > 0 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value)),
}).strict();
const receiptSchema = z.object({
    id: z.string().uuid(), text: z.string().max(32768),
    status: z.enum(["queued", "running", "completed", "failed"]),
    createdAt: z.string(),
});
/** Durable per-job messages. A running receipt is never replayed after a Hook restart. */
export class FanoutMessages {
    env;
    deps;
    timer;
    ticking = false;
    constructor(env, deps) {
        this.env = env;
        this.deps = deps;
    }
    start() {
        this.timer = setInterval(() => { countTick("fanout-messages"); void this.tick().catch(() => { }); }, 1000);
        this.timer.unref();
        void this.tick().catch(() => { });
    }
    close() { clearInterval(this.timer); }
    async jobs() {
        const root = await containedFanoutRoot(this.env);
        if (!root)
            return [];
        const jobs = [];
        for (const name of (await readdir(root)).slice(0, 1024)) {
            const directory = path.join(root, name);
            try {
                if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory)
                    continue;
                const file = path.join(directory, "manifest.json"), info = await lstat(file);
                if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
                    continue;
                const manifest = manifestSchema.parse(JSON.parse(await readFile(file, "utf8")));
                if (manifest.id === name)
                    jobs.push({ directory, manifest });
            }
            catch { /* A torn or foreign job cannot receive input. */ }
        }
        return jobs;
    }
    async selected(target, child) {
        await this.deps.validate(target);
        const relation = childAgent(await this.deps.tree(target), child);
        if (!relation?.fanout?.resumable)
            throw new BridgeError(404, "That resumable worker is not part of this conversation.");
        const root = await containedFanoutRoot(this.env);
        const job = (await this.jobs()).find(job => root && fanoutChildID(root, job.manifest) === child);
        if (!job || !job.manifest.session || !["codex", "opencode", "claude"].includes(job.manifest.provider)) {
            throw new BridgeError(404, "That worker does not belong to this store.");
        }
        return job;
    }
    async send(input) {
        const data = fanoutMessageSchema.parse(input);
        const job = await this.selected(data.target, data.child);
        const directory = await this.messageDirectory(job);
        const message = { id: randomUUID(), text: data.text, status: "queued", createdAt: new Date().toISOString() };
        const pending = (await this.records(job)).filter(row => row.message.status === "queued");
        if (pending.length >= 32)
            throw new BridgeError(429, "This worker already has 32 queued messages.");
        const file = path.join(directory, `${message.createdAt.replace(/[:.]/g, "-")}-${message.id}.queued.json`);
        await atomic(file, JSON.stringify(message));
        await this.drain(job);
        const fresh = (await this.records(job)).find(row => row.message.id === message.id)?.message;
        return { ok: true, message: fresh ?? message };
    }
    /** Archive every finished worker of one live parent now, instead of after
     * the sweep's 24 hours. The sweep's own checks apply: a job without an exit
     * stamp, with a message lock or with queued messages stays put. */
    async archiveFinished(input) {
        const { target } = z.object({ target: targetSchema }).strict().parse(input);
        await this.deps.validate(target);
        const { moved } = await archiveFinishedFanouts(this.env, { olderThanMs: 0, parent: { session: target.session, provider: target.source } });
        return { ok: true, archived: moved.length };
    }
    async list(targetValue, childValue) {
        const target = targetSchema.parse(targetValue), child = fanoutMessageSchema.shape.child.parse(childValue);
        const job = await this.selected(target, child);
        return { messages: (await this.records(job)).map(row => row.message) };
    }
    async messageDirectory(job) {
        const directory = path.join(job.directory, "messages");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if (await realpath(directory) !== directory)
            throw new BridgeError(400, "Invalid worker message directory.");
        return directory;
    }
    async records(job) {
        const directory = path.join(job.directory, "messages");
        const info = await lstat(directory).catch(() => undefined);
        if (!info)
            return [];
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) {
            throw new BridgeError(400, "Invalid worker message directory.");
        }
        const rows = [];
        for (const name of (await readdir(directory)).sort().slice(-512)) {
            if (!/^[0-9TZ-]+-[a-f0-9-]+\.(queued|sent)\.json$/.test(name))
                continue;
            const file = path.join(directory, name), info = await lstat(file);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 262144)
                continue;
            try {
                rows.push({ file, message: receiptSchema.parse(JSON.parse(await readFile(file, "utf8"))) });
            }
            catch { /* Ignore torn receipts. */ }
        }
        return rows;
    }
    async tick() {
        if (this.ticking)
            return;
        this.ticking = true;
        try {
            for (const job of await this.jobs()) {
                if (["queued", "running"].includes(job.manifest.status))
                    continue;
                if ((await this.records(job).catch(() => [])).some(row => row.message.status === "queued"))
                    await this.drain(job).catch(() => { });
            }
        }
        finally {
            this.ticking = false;
        }
    }
    async drain(job) {
        const lock = path.join(job.directory, "message-lock");
        try {
            await mkdir(lock, { mode: 0o700 });
        }
        catch {
            return;
        }
        let launched = false;
        let pending;
        let started;
        try {
            // Re-read under the job lock. The original launcher owns the manifest until it finishes.
            const fresh = (await this.jobs()).find(candidate => candidate.directory === job.directory);
            if (!fresh || ["queued", "running"].includes(fresh.manifest.status))
                return;
            if (!fresh.manifest.session || !["codex", "opencode", "claude"].includes(fresh.manifest.provider))
                return;
            const next = (await this.records(fresh)).find(row => row.message.status === "queued");
            if (!next)
                return;
            pending = next;
            if (!(await lstat(fresh.manifest.worktree)).isDirectory())
                throw new BridgeError(409, "The worker's original worktree is unavailable.");
            // Refuse redirected output files before the launcher opens them for writing.
            for (const name of [fresh.manifest.eventLog, "events.jsonl", "stderr.log", "final.txt", "exit.txt", "blocked.json", "prompt.txt"]) {
                const info = await lstat(path.join(fresh.directory, name)).catch(() => undefined);
                if (info && (!info.isFile() || info.isSymbolicLink()))
                    throw new BridgeError(400, "Invalid worker output file.");
            }
            const round = path.join(fresh.directory, "rounds");
            await mkdir(round, { recursive: true, mode: 0o700 });
            if (await realpath(round) !== round)
                throw new BridgeError(400, "Invalid worker round directory.");
            const roundDir = path.join(round, next.message.id);
            await mkdir(roundDir, { mode: 0o700 });
            await writeFile(path.join(roundDir, "prompt.txt"), next.message.text, { mode: 0o600 });
            for (const name of ["stderr.log", "final.txt", "exit.txt", "blocked.json", "prompt.txt"]) {
                await rename(path.join(fresh.directory, name), path.join(roundDir, `previous-${name}`)).catch(error => {
                    if (error.code !== "ENOENT")
                        throw error;
                });
            }
            await writeFile(path.join(fresh.directory, "prompt.txt"), next.message.text, { mode: 0o600 });
            const sentFile = next.file.replace(/\.queued\.json$/, ".sent.json");
            const message = { ...next.message, status: "running" };
            await atomic(next.file, JSON.stringify(message));
            await rename(next.file, sentFile);
            pending = { file: sentFile, message };
            const now = new Date().toISOString();
            const manifest = { ...fresh.manifest, status: "running", updatedAt: now, startedAt: now,
                resumes: fresh.manifest.session, finishedAt: undefined, exitCode: undefined };
            await atomic(path.join(fresh.directory, "manifest.json"), JSON.stringify(manifest));
            started = manifest;
            await appendFile(path.join(fresh.directory, manifest.eventLog), JSON.stringify({
                type: "phren/fanout-message", timestamp: now, id: message.id, text: message.text,
            }) + "\n", { mode: 0o600 });
            const run = this.deps.run ?? (async (job, text) => {
                const { launch } = await import("../fanout/launcher.js");
                return launch({ store: storeRoot(this.env), provider: job.manifest.provider, label: job.manifest.taskLabel,
                    reason: job.manifest.reason ?? "Continue worker", model: job.manifest.model ?? "", worktree: job.manifest.worktree,
                    resume: job.manifest.session, prompt: text }, { job: job.directory, manifest: job.manifest });
            });
            launched = true;
            void run({ ...fresh, manifest }, message.text).then(async (code) => {
                await atomic(sentFile, JSON.stringify({ ...message, status: code === 0 ? "completed" : "failed" }));
            }).catch(async () => {
                await atomic(sentFile, JSON.stringify({ ...message, status: "failed" }));
                await atomic(path.join(fresh.directory, "manifest.json"), JSON.stringify({ ...manifest, status: "failed", finishedAt: new Date().toISOString() }));
            }).finally(async () => { await rm(lock, { recursive: true, force: true }); }).catch(() => { });
        }
        catch (error) {
            if (!pending)
                throw error;
            // Once accepted, report a failed receipt instead of leaving a hidden queued
            // message behind an HTTP error that would invite the person to resend it.
            await atomic(pending.file, JSON.stringify({ ...pending.message, status: "failed" }));
            if (pending.file.endsWith(".queued.json"))
                await rename(pending.file, pending.file.replace(/\.queued\.json$/, ".sent.json"));
            if (started)
                await atomic(path.join(job.directory, "manifest.json"), JSON.stringify({
                    ...started, status: "failed", finishedAt: new Date().toISOString(),
                }));
        }
        finally {
            if (!launched)
                await rm(lock, { recursive: true, force: true });
        }
    }
}
