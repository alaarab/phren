import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DispatchConnections, type DispatchStream } from "./dispatch-connections.js";
import { ClaudeBackgroundInbox, CodexBackgroundInbox, DispatchOutbox, pruneDispatchArtifacts, type BackgroundDelivery, type OutboxItem } from "./dispatch-outbox.js";
import { hookPeers, peerRequest, type HookPeer } from "./peers.js";
import { bridgeRoot, object, objects, provider, startingTargetSchema, targetSchema, type Json, type Provider, type Target } from "./protocol.js";

const computerIdentity = z.object({ id: z.string().uuid(), name: z.string().min(1).max(100) }).strict();
const parentIdentity = z.object({ provider, session: z.string().min(1).max(200), computer: z.string().uuid() }).strict();
const remoteTarget = z.union([targetSchema, startingTargetSchema]);
export const reportReceiptSchema = z.object({
  id: z.string().uuid(), computer: z.string().min(1).max(100), label: z.string().min(1).max(200),
  harness: z.enum(["codex", "claude", "opencode"]), state: z.enum(["accepted", "uncertain"]),
  target: remoteTarget, remoteComputer: computerIdentity, parent: parentIdentity,
}).passthrough();
export type ReportReceipt = z.infer<typeof reportReceiptSchema>;

const finalReportSchema = z.object({
  dispatchId: z.string().uuid(), turnId: z.string().regex(/^[a-f0-9]{32}$/), text: z.string().max(4000)
    .refine(value => Buffer.byteLength(value) <= 4000), truncated: z.boolean(), createdAt: z.string().datetime(),
  transcript: z.object({ computer: computerIdentity, target: targetSchema, line: z.number().int().nonnegative(), turnId: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
  claims: z.object({ tests: z.literal("unknown"), merge: z.literal("unknown"), integration: z.literal("unknown") }).strict(),
}).strict();
export type FinalDispatchReport = z.infer<typeof finalReportSchema>;

const watchSchema = z.object({
  version: z.literal(1), dispatchId: z.string().uuid(), computer: z.string().min(1).max(100),
  label: z.string().min(1).max(200), harness: z.enum(["codex", "claude", "opencode"]),
  remoteComputer: computerIdentity, parent: parentIdentity, parentTarget: targetSchema, target: remoteTarget,
  cursor: z.number().int().min(-1), lastAssistant: z.string().max(16_000),
  reportState: z.enum(["watching", "reportPending", "deliveryUncertain", "completed"]),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.string().datetime().optional(), error: z.string().max(500).optional(),
  outboxId: z.string().regex(/^[a-f0-9]{64}$/).optional(), report: finalReportSchema.optional(),
}).strict();
export type DispatchWatch = z.infer<typeof watchSchema>;

export interface DispatchReportsOptions {
  computer: { id: string; name: string };
  validateParent: (target: Target) => Promise<boolean>;
  peers?: () => Promise<HookPeer[]>;
  request?: typeof peerRequest;
  connections?: DispatchConnections;
  outbox?: DispatchOutbox;
  inboxes?: Partial<Record<Provider, BackgroundDelivery>>;
  root?: string;
  now?: () => number;
}

function atomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  return writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" }).then(() => rename(temporary, file));
}

function truncateUtf8(value: string, limit = 4000): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return { text: value, truncated: false };
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

function xml(value: string): string {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "\uFFFD")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function boundedXml(value: string, limit: number): string {
  let result = "";
  for (const character of value) {
    const escaped = xml(character);
    if (result.length + escaped.length > limit) break;
    result += escaped;
  }
  return result;
}

export function reportEnvelope(report: FinalDispatchReport, computerName: string): string {
  const summary = boundedXml(`${computerName}: ${report.text.replace(/\s+/g, " ").trim() || "worker turn completed."}`, 500);
  return `<task-notification>\n<task-id>${xml(report.dispatchId)}</task-id>\n<tool-use-id>dispatch:${xml(report.dispatchId)}:${xml(report.turnId)}</tool-use-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>`;
}

/** Rebuild the allowlisted envelope before projecting any provider inbox row. */
export function allowlistedReportEnvelope(content: string): string | undefined {
  const body = /<task-notification>([\s\S]*?)<\/task-notification>/.exec(content)?.[1];
  if (!body) return;
  const values = new Map<string, string>();
  for (const match of body.matchAll(/<([a-z-]+)>([\s\S]*?)<\/\1>/g)) {
    if (!["task-id", "tool-use-id", "status", "summary"].includes(match[1]) || match[2].includes("<") || values.has(match[1])) continue;
    values.set(match[1], match[2]);
  }
  const task = values.get("task-id"), tool = values.get("tool-use-id"), status = values.get("status"), summary = values.get("summary");
  if (!task || !tool?.startsWith(`dispatch:${task}:`) || status !== "completed" || !summary
      || task.length > 200 || tool.length > 200 || status.length > 200 || summary.length > 500
      || [task, tool, status, summary].some(value => /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))) return;
  return `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>${tool}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;
}

export function reportBackgroundEvent(content: string, timestamp?: unknown): Json | undefined {
  const envelope = allowlistedReportEnvelope(content);
  return envelope ? { type: "system", phrenBackground: true, ...(typeof timestamp === "string" ? { timestamp } : {}),
    message: { role: "user", content: envelope } } : undefined;
}

function publicAssistant(raw: Json, source: Provider): string | undefined {
  if (source === "codex") {
    const payload = object(raw.payload);
    if (raw.type !== "response_item" || payload.type !== "message" || payload.role !== "assistant" || payload.channel === "analysis") return;
    const text = typeof payload.content === "string" ? payload.content : objects(payload.content)
      .filter(block => ["text", "output_text"].includes(String(block.type))).map(block => String(block.text ?? "")).join("\n");
    return text.trim() || undefined;
  }
  if (source === "claude") {
    const message = object(raw.message);
    if (raw.type !== "assistant" || message.role !== "assistant") return;
    const text = typeof message.content === "string" ? message.content : objects(message.content)
      .filter(block => block.type === "text").map(block => String(block.text ?? "")).join("\n");
    return text.trim() || undefined;
  }
  if (source === "opencode") {
    const data = object(raw.data), message = object(data.message);
    if (raw.type !== "assistant/message" || message.role !== "assistant") return;
    const text = typeof message.content === "string" ? message.content : objects(message.content)
      .filter(block => block.type === "text").map(block => String(block.text ?? "")).join("\n");
    return text.trim() || undefined;
  }
  return;
}

function terminalTurn(raw: Json, source: Provider, session: string, line: number): string | undefined {
  const payload = object(raw.payload), message = object(raw.message), data = object(raw.data);
  const openCodeMessage = object(data.message), openCodeText = objects(openCodeMessage.content)
    .filter(block => block.type === "text").map(block => String(block.text ?? "")).join("\n");
  const terminal = source === "codex" ? raw.type === "event_msg" && ["task_complete", "task_completed"].includes(String(payload.type))
    : source === "claude" ? raw.type === "assistant" && message.stop_reason === "end_turn"
    : source === "opencode" ? data.stop_reason === "end_turn"
      || (raw.type === "system" && openCodeText === "Step finished: end_turn") : false;
  if (!terminal) return;
  const providerID = [payload.turn_id, payload.id, raw.uuid, data.turn, data.id, openCodeMessage.id, raw.timestamp, raw.time]
    .find(value => typeof value === "string" || typeof value === "number");
  return createHash("sha256").update(`${source}\0${session}\0${String(providerID ?? `line:${line}`)}`).digest("hex").slice(0, 32);
}

function targetQuery(target: Target): string {
  return new URLSearchParams(Object.entries(target).map(([key, value]) => [key, String(value)])).toString();
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, milliseconds); timer.unref?.();
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

const unavailable: BackgroundDelivery = { supported: async () => false, enqueue: async () => "unavailable" };

/** Origin-side report follower. Receipts are restored, never relaunched. */
export class DispatchReports {
  private readonly root: string;
  private readonly directory: string;
  private readonly peers: () => Promise<HookPeer[]>;
  private readonly request: typeof peerRequest;
  private readonly connections: DispatchConnections;
  private readonly outbox: DispatchOutbox;
  private readonly now: () => number;
  private readonly inboxes: Partial<Record<Provider, BackgroundDelivery>>;
  private readonly running = new Map<string, AbortController>();
  private readonly followers = new Set<Promise<void>>();
  private readonly delivering = new Set<string>();
  private readonly deliveryRuns = new Set<Promise<void>>();
  private readonly deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(private readonly options: DispatchReportsOptions) {
    this.root = options.root ?? bridgeRoot(); this.directory = path.join(this.root, "dispatch-reports");
    this.peers = options.peers ?? hookPeers; this.request = options.request ?? peerRequest;
    this.connections = options.connections ?? new DispatchConnections();
    this.outbox = options.outbox ?? new DispatchOutbox(this.root); this.now = options.now ?? Date.now;
    this.inboxes = { codex: new CodexBackgroundInbox(), claude: new ClaudeBackgroundInbox(), ...options.inboxes };
    computerIdentity.parse(options.computer);
  }

  private file(id: string): string { return path.join(this.directory, `${z.string().uuid().parse(id)}.json`); }

  private async save(watch: DispatchWatch): Promise<void> {
    watch.updatedAt = new Date(this.now()).toISOString();
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); await atomic(this.file(watch.dispatchId), watch);
  }

  private async read(id: string): Promise<DispatchWatch | undefined> {
    const file = this.file(id), info = await lstat(file).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > 65_536) return;
    try { return watchSchema.parse(JSON.parse(await readFile(file, "utf8"))); } catch { return; }
  }

  private async all(): Promise<DispatchWatch[]> {
    const names = (await readdir(this.directory).catch(() => [] as string[])).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
    const values = await Promise.all(names.map(name => this.read(name.slice(0, -5))));
    return values.filter((value): value is DispatchWatch => value !== undefined);
  }

  private async receipts(): Promise<ReportReceipt[]> {
    const directory = path.join(this.root, "dispatches");
    const names = (await readdir(directory).catch(() => [] as string[])).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
    const values = await Promise.all(names.map(async name => {
      const file = path.join(directory, name), info = await lstat(file).catch(() => undefined);
      if (!info?.isFile() || info.isSymbolicLink() || info.size > 16_384) return;
      try {
        const value = object(JSON.parse(await readFile(file, "utf8")));
        const state = ["launching", "sending"].includes(String(value.state)) ? "uncertain" : value.state;
        const parsed = reportReceiptSchema.safeParse({ ...value, state }); return parsed.success ? parsed.data : undefined;
      } catch { return; }
    }));
    return values.filter((value): value is ReportReceipt => value !== undefined);
  }

  async watch(receiptValue: unknown, parentTargetValue: unknown): Promise<void> {
    const receipt = reportReceiptSchema.parse(receiptValue), parentTarget = targetSchema.parse(parentTargetValue);
    if (receipt.parent.provider !== parentTarget.source || receipt.parent.session !== parentTarget.session
        || receipt.parent.computer !== this.options.computer.id) throw new Error("The dispatch parent does not match this conversation.");
    const existing = await this.read(receipt.id);
    if (existing) { if (!this.running.has(existing.dispatchId) && existing.reportState === "watching") this.start(existing); return; }
    const stamp = new Date(this.now()).toISOString();
    const state: DispatchWatch = { version: 1, dispatchId: receipt.id, computer: receipt.computer, label: receipt.label,
      harness: receipt.harness, remoteComputer: receipt.remoteComputer, parent: receipt.parent, parentTarget,
      target: receipt.target, cursor: -1, lastAssistant: "", reportState: "watching", createdAt: stamp, updatedAt: stamp, attempts: 0 };
    await this.save(state); this.start(state);
  }

  async restore(): Promise<void> {
    const known = new Set((await this.all()).map(state => state.dispatchId));
    for (const receipt of await this.receipts()) {
      if (!known.has(receipt.id)) await this.watch(receipt, object(receipt).parentTarget).catch(() => {});
    }
    const outbox = await this.outbox.recover(), byID = new Map(outbox.map(item => [item.id, item]));
    for (const state of await this.all()) {
      const item = state.outboxId ? byID.get(state.outboxId) : undefined;
      if (item) await this.applyOutboxState(state, item);
      if (state.reportState === "watching") this.start(state);
      else if (state.reportState === "reportPending" && item) void this.deliver(state, item).catch(() => {});
    }
  }

  private start(state: DispatchWatch): void {
    if (this.stopped || this.running.has(state.dispatchId)) return;
    const controller = new AbortController(); this.running.set(state.dispatchId, controller);
    const follower = this.follow(state, controller.signal).finally(() => {
      this.running.delete(state.dispatchId); this.followers.delete(follower);
    });
    this.followers.add(follower); void follower.catch(() => {});
  }

  private async resolveTarget(peer: HookPeer, state: DispatchWatch): Promise<Target> {
    if ("session" in state.target) return targetSchema.parse(state.target);
    const result = await this.request(peer, "/v1/dispatch/target", { target: state.target });
    const target = targetSchema.parse(result.target);
    if (target.server !== state.target.server || target.workspace !== state.target.workspace || target.tab !== state.target.tab
        || target.pane !== state.target.pane || target.source !== state.target.source) throw new Error("The launched pane no longer has its starting conversation.");
    state.target = target; await this.save(state); return target;
  }

  private async resolvePeer(state: DispatchWatch): Promise<HookPeer> {
    const peers = await this.peers(), preferred = peers.find(value => value.name === state.computer);
    const identify = async (peer: HookPeer) => {
      try { return computerIdentity.parse((await this.request(peer, "/v1/health")).computer); } catch { return undefined; }
    };
    const preferredIdentity = preferred ? await identify(preferred) : undefined;
    if (preferred && preferredIdentity?.id === state.remoteComputer.id) return preferred;
    const candidates = peers.filter(value => value !== preferred);
    const identities = await Promise.all(candidates.map(async peer => ({ peer, identity: await identify(peer) })));
    const matched = identities.find(value => value.identity?.id === state.remoteComputer.id);
    if (!matched) throw new Error(preferredIdentity ? "The configured report peer has a different computer identity."
      : "No connected report peer has the receipt's computer identity.");
    state.computer = matched.peer.name; state.remoteComputer.name = matched.peer.name; await this.save(state);
    return matched.peer;
  }

  private async follow(state: DispatchWatch, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && state.reportState === "watching") {
      let transcript: DispatchStream | undefined, status: DispatchStream | undefined;
      try {
        const peer = await this.resolvePeer(state);
        const target = await this.resolveTarget(peer, state), query = targetQuery(target);
        const transcriptRoute = `/v1/transcripts?${query}${state.cursor >= 0 ? `&afterLine=${state.cursor}` : ""}`;
        let disconnected!: (error?: Error) => void, completed = false;
        const stopped = new Promise<Error | undefined>(resolve => { disconnected = resolve; });
        let chain = Promise.resolve(), processingError: Error | undefined;
        transcript = await this.connections.open(peer, transcriptRoute,
          frame => { chain = chain.then(async () => { completed ||= await this.transcriptFrame(state, target, frame); if (completed) disconnected(); })
            .catch(error => { processingError = error instanceof Error ? error : new Error("The report frame could not be persisted."); disconnected(processingError); }); });
        status = await this.connections.open(peer, `/v1/status?${query}`, frame => {
          const observed = object(frame.agentStatus);
          if ((observed.source && observed.source !== target.source) || (observed.session && observed.session !== target.session)) {
            disconnected(new Error("The remote conversation was replaced."));
          }
        });
        state.attempts = 0; delete state.nextAttemptAt; delete state.error; await this.save(state);
        const first = await Promise.race([transcript.closed, status.closed, stopped]); await chain;
        transcript.close(); status.close();
        if (completed || state.reportState !== "watching") return;
        if (processingError) throw processingError;
        if (first) throw first;
        throw new Error("The remote report stream closed.");
      } catch (error) {
        transcript?.close(); status?.close();
        if (signal.aborted) return;
        state.attempts++; state.error = error instanceof Error ? error.message.slice(0, 500) : "The remote report stream failed.";
        const wait = Math.min(60_000, 1000 * 2 ** Math.min(state.attempts - 1, 6));
        state.nextAttemptAt = new Date(this.now() + wait).toISOString(); await this.save(state);
        try { await delay(wait, signal); } catch { return; }
      }
    }
  }

  /** Process one public transcript frame. Exposed for deterministic recovery
   * tests; network followers serialize calls through the same method. */
  async transcriptFrame(state: DispatchWatch, target: Target, frame: Json): Promise<boolean> {
    const total = z.number().int().nonnegative().catch(0).parse(frame.totalLines);
    if (frame.reset === true || total - 1 < state.cursor) { state.cursor = -1; state.lastAssistant = ""; }
    let completed = false;
    const entries = objects(frame.entries).map(entry => ({ line: Number(entry.line), raw: object(entry.raw) }))
      .filter(entry => Number.isSafeInteger(entry.line) && entry.line >= 0).sort((a, b) => a.line - b.line);
    for (const entry of entries) {
      if (entry.line <= state.cursor) continue;
      const assistant = publicAssistant(entry.raw, target.source);
      if (assistant) state.lastAssistant = truncateUtf8(assistant, 16_000).text;
      const turnId = terminalTurn(entry.raw, target.source, target.session, entry.line);
      state.cursor = entry.line;
      if (!turnId) continue;
      const bounded = truncateUtf8(state.lastAssistant || "Worker turn completed without a public assistant report.");
      const report: FinalDispatchReport = { dispatchId: state.dispatchId, turnId, ...bounded,
        createdAt: new Date(this.now()).toISOString(), transcript: { computer: state.remoteComputer, target, line: entry.line, turnId },
        claims: { tests: "unknown", merge: "unknown", integration: "unknown" } };
      const item = await this.outbox.enqueue({ dispatchId: state.dispatchId, turnId, parentTarget: state.parentTarget,
        envelope: reportEnvelope(report, state.computer) });
      state.report = report; state.outboxId = item.id; state.reportState = "reportPending"; delete state.nextAttemptAt; delete state.error;
      await this.save(state); await this.deliver(state, item); completed = true; break;
    }
    if (!completed) {
      await this.save(state);
    }
    return completed;
  }

  private async deliver(state: DispatchWatch, current: OutboxItem): Promise<void> {
    if (this.stopped || this.delivering.has(current.id)) return;
    this.delivering.add(current.id);
    const run = (async () => {
      if (!await this.options.validateParent(state.parentTarget)) {
        state.reportState = "reportPending"; state.error = "The parent conversation was replaced; the report was not delivered."; await this.save(state); return;
      }
      const adapter = this.inboxes[state.parentTarget.source] ?? unavailable;
      const item = await this.outbox.deliver(current.id, adapter); await this.applyOutboxState(state, item);
      if (item.state === "pending") this.scheduleDelivery(state, item);
    })();
    this.deliveryRuns.add(run);
    try { await run; } finally { this.delivering.delete(current.id); this.deliveryRuns.delete(run); }
  }

  private scheduleDelivery(state: DispatchWatch, item: OutboxItem): void {
    if (this.stopped || this.deliveryTimers.has(item.id)) return;
    const wait = Math.max(0, Date.parse(item.nextAttemptAt ?? "") - this.now()) || 1000;
    const timer = setTimeout(() => {
      this.deliveryTimers.delete(item.id);
      void this.outbox.items().then(items => {
        const current = items.find(value => value.id === item.id);
        if (current && current.state === "pending") return this.deliver(state, current);
      }).catch(() => {});
    }, Math.min(60_000, wait));
    timer.unref?.(); this.deliveryTimers.set(item.id, timer);
  }

  private async applyOutboxState(state: DispatchWatch, item: OutboxItem): Promise<void> {
    state.outboxId = item.id;
    state.reportState = item.state === "delivered" ? "completed" : item.state === "deliveryUncertain" || item.state === "submitting" ? "deliveryUncertain" : "reportPending";
    state.error = item.error; state.nextAttemptAt = item.nextAttemptAt;
    await this.save(state);
  }

  async status<T extends Json>(receipts: T[]): Promise<Array<T & Json>> {
    const states = new Map((await this.all()).map(state => [state.dispatchId, state]));
    const result = receipts.map(receipt => {
      const state = typeof receipt.id === "string" ? states.get(receipt.id) : undefined;
      if (!state) return receipt;
      return { ...receipt, reportState: state.reportState, ...(state.report ? { report: state.report } : {}),
        ...(state.error ? { reportError: state.error } : {}) };
    });
    await pruneDispatchArtifacts(this.root, this.now()); return result;
  }

  async close(): Promise<void> {
    this.stopped = true;
    for (const controller of this.running.values()) controller.abort(new Error("Dispatch reports closed."));
    this.running.clear();
    for (const timer of this.deliveryTimers.values()) clearTimeout(timer);
    this.deliveryTimers.clear(); this.connections.close();
    await Promise.allSettled([...this.followers, ...this.deliveryRuns]);
  }
}
