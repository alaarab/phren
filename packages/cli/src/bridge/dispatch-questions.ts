import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { dispatchDestinationSchema } from "./dispatch-headless.js";
import { BridgeError, bridgeRoot, object, objects, type Json } from "./protocol.js";

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const plain = (max: number) => z.string().min(1).max(max).refine(value => !!value.trim() && !/[\x00-\x1f\x7f]/.test(value));
const questionText = plain(4000);
const answerKey = z.enum(["Escape", "Enter", "Up", "Down", "Tab", "y", "n", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
const optionSchema = z.object({ label: questionText }).strict();
const codexQuestionSchema = z.object({ question: questionText, options: z.array(optionSchema).max(12).optional(), kind: z.literal("text").optional() }).strict();
const computerSchema = z.object({ id: uuid, name: plain(100) }).strict();
const contextSchema = z.object({ dispatchId: uuid, computer: computerSchema, brief: plain(200), destination: dispatchDestinationSchema }).strict();
const baseNotificationSchema = z.object({
  schemaVersion: z.literal(1), type: z.literal("question"), phrenBackground: z.literal(true), id: z.string().regex(/^[a-f0-9]{64}$/), createdAt: timestamp,
  dispatchId: uuid, computer: computerSchema, brief: plain(200), destination: dispatchDestinationSchema,
});
const codexNotificationSchema = baseNotificationSchema.extend({
  kind: z.literal("codex"), toolUseId: plain(512), questions: z.array(codexQuestionSchema).min(1).max(8),
}).strict();
const claudeNotificationSchema = baseNotificationSchema.extend({
  kind: z.literal("claude"), actionId: uuid, input: z.record(z.string(), z.unknown()), questions: z.array(z.unknown()).min(1).max(8),
}).strict();
const terminalNotificationSchema = baseNotificationSchema.extend({
  kind: z.literal("terminal"), callId: plain(512), title: plain(200), message: z.string().max(32_768),
}).strict();
const headlessNotificationSchema = baseNotificationSchema.extend({
  kind: z.literal("headless"), provider: z.enum(["codex", "opencode"]), callId: plain(512), questions: z.array(codexQuestionSchema).max(8),
  limitation: z.literal("Headless workers do not expose an answer API."),
}).strict();
export const dispatchQuestionNotificationSchema = z.discriminatedUnion("kind", [codexNotificationSchema, claudeNotificationSchema, terminalNotificationSchema, headlessNotificationSchema]);
export type DispatchQuestionNotification = z.infer<typeof dispatchQuestionNotificationSchema>;

const answerReceiptSchema = z.object({
  schemaVersion: z.literal(1), notificationId: z.string().regex(/^[a-f0-9]{64}$/), createdAt: timestamp, updatedAt: timestamp,
  state: z.enum(["sending", "submitted", "uncertain", "rejected"]), error: z.string().max(500).optional(),
}).strict();
type AnswerReceipt = z.infer<typeof answerReceiptSchema>;

export type DispatchQuestionForward = (route: string, data: Json) => Promise<Json>;
export interface DispatchQuestionRelayOptions { root?: string; forward?: DispatchQuestionForward; }

function notificationsRoot(root: string): string { return path.join(root, "dispatch-questions"); }
function notificationPath(root: string, id: string): string { return path.join(notificationsRoot(root), "notifications", `${z.string().regex(/^[a-f0-9]{64}$/).parse(id)}.json`); }
function answerPath(root: string, id: string): string { return path.join(notificationsRoot(root), "answers", `${z.string().regex(/^[a-f0-9]{64}$/).parse(id)}.json`); }
function notificationID(context: z.infer<typeof contextSchema>, kind: string, callId: string): string {
  return createHash("sha256").update(JSON.stringify([context.dispatchId, context.destination, kind, callId])).digest("hex");
}

async function readStored<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536) return;
    return schema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch { return; }
}

async function createStored(file: string, value: unknown): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await open(file, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); return true; }
  finally { await handle.close(); }
}

async function replaceStored(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  try { await rename(temporary, file); } finally { await unlink(temporary).catch(() => {}); }
}

function statusObject(value: unknown): Json {
  const frame = object(value), nested = object(frame.agentStatus);
  const status = object(frame.status);
  return Object.keys(nested).length ? nested : Object.keys(status).length ? status : frame;
}

function currentTarget(context: z.infer<typeof contextSchema>, source: string): boolean {
  return context.destination.kind === "target" && context.destination.target.source === source;
}

function codexCandidates(context: z.infer<typeof contextSchema>, status: Json): DispatchQuestionNotification[] {
  const parsed = z.array(z.object({ toolUseId: plain(512), isAsync: z.literal(true).optional(), submitted: z.boolean().optional(),
    questions: z.array(codexQuestionSchema).min(1).max(8) }).strict()).max(64).safeParse(status.pendingQuestions);
  if (!parsed.success) return [];
  const source = String(status.source);
  if (source !== "codex") return [];
  return parsed.data.filter(item => !item.submitted).map(item => {
    const kind = context.destination.kind === "headless" ? "headless" : "codex";
    const id = notificationID(context, kind, item.toolUseId);
    const base = { schemaVersion: 1 as const, type: "question" as const, phrenBackground: true as const, id, createdAt: new Date().toISOString(), dispatchId: context.dispatchId,
      computer: context.computer, brief: context.brief, destination: context.destination };
    return kind === "headless"
      ? headlessNotificationSchema.parse({ ...base, kind, provider: "codex", callId: item.toolUseId, questions: item.questions,
        limitation: "Headless workers do not expose an answer API." })
      : codexNotificationSchema.parse({ ...base, kind, toolUseId: item.toolUseId, questions: item.questions });
  });
}

function claudeCandidate(context: z.infer<typeof contextSchema>, status: Json): DispatchQuestionNotification[] {
  if (!currentTarget(context, "claude")) return [];
  const pending = object(status.pendingApproval);
  if (pending.toolName !== "AskUserQuestion" || typeof pending.actionId !== "string") return [];
  const input = object(pending.input ?? pending.originalInput);
  const questions = objects(input.questions);
  if (!questions.length || questions.length > 8 || !uuid.safeParse(pending.actionId).success) return [];
  if (Buffer.byteLength(JSON.stringify(input)) > 32_768 || "answers" in input || "response" in input) return [];
  const id = notificationID(context, "claude", pending.actionId);
  return [claudeNotificationSchema.parse({ schemaVersion: 1, type: "question", phrenBackground: true, id, createdAt: new Date().toISOString(), dispatchId: context.dispatchId,
    computer: context.computer, brief: context.brief, destination: context.destination, kind: "claude", actionId: pending.actionId, input, questions })];
}

function terminalCandidate(context: z.infer<typeof contextSchema>, status: Json): DispatchQuestionNotification[] {
  if (context.destination.kind !== "target" || status.source !== context.destination.target.source) return [];
  const prompt = object(status.terminalPrompt);
  if (!Object.keys(prompt).length || typeof prompt.message !== "string") return [];
  const callId = typeof prompt.callId === "string" && plain(512).safeParse(prompt.callId).success
    ? prompt.callId : createHash("sha256").update(JSON.stringify([prompt.toolName, prompt.message])).digest("hex");
  const title = typeof prompt.toolName === "string" && plain(200).safeParse(prompt.toolName).success ? prompt.toolName : "Terminal question";
  const id = notificationID(context, "terminal", callId);
  return [terminalNotificationSchema.parse({ schemaVersion: 1, type: "question", phrenBackground: true, id, createdAt: new Date().toISOString(), dispatchId: context.dispatchId,
    computer: context.computer, brief: context.brief, destination: context.destination, kind: "terminal", callId, title, message: prompt.message })];
}

/** Projects B's remote status frames into durable, one-time Background question rows. */
export class DispatchQuestionRelay {
  private readonly root: string;
  private readonly forward?: DispatchQuestionForward;
  constructor(options: DispatchQuestionRelayOptions = {}) { this.root = options.root ?? bridgeRoot(); this.forward = options.forward; }

  async consume(contextValue: unknown, frame: unknown): Promise<DispatchQuestionNotification[]> {
    const context = contextSchema.parse(contextValue), status = statusObject(frame);
    const notifications = [
      ...codexCandidates(context, status),
      ...claudeCandidate(context, status),
      ...terminalCandidate(context, status),
    ].filter(notification => context.destination.kind === "headless" || notification.kind === "terminal" || currentTarget(context, notification.kind));
    const emitted: DispatchQuestionNotification[] = [];
    for (const notification of notifications) {
      if (await createStored(notificationPath(this.root, notification.id), notification)) emitted.push(notification);
    }
    return emitted;
  }

  async notification(value: unknown): Promise<DispatchQuestionNotification> {
    const id = z.object({ notificationId: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(value).notificationId;
    const notification = await readStored(notificationPath(this.root, id), dispatchQuestionNotificationSchema);
    if (!notification) throw new BridgeError(404, "That dispatch question is no longer available.");
    return notification;
  }

  async answer(value: unknown): Promise<Json> {
    const notification = await this.notification(value);
    const request = questionAnswerRequest(notification, object(value).answer);
    if (!this.forward) throw new BridgeError(503, "The dispatch question relay has no remote answer transport.");
    const file = answerPath(this.root, notification.id), existing = await readStored(file, answerReceiptSchema);
    if (existing) throw new BridgeError(409, existing.state === "uncertain"
      ? "This answer may have been delivered. Check the remote conversation before answering again."
      : "An answer was already sent for this question. Check the remote conversation.");
    const at = new Date().toISOString();
    const receipt: AnswerReceipt = { schemaVersion: 1, notificationId: notification.id, createdAt: at, updatedAt: at, state: "sending" };
    if (!await createStored(file, receipt)) throw new BridgeError(409, "An answer is already being sent for this question.");
    try {
      const result = await this.forward(request.route, request.data);
      if (result.deliveryUncertain === true) throw new BridgeError(504, "The remote Hook did not confirm the answer.");
      await replaceStored(file, { ...receipt, state: "submitted", updatedAt: new Date().toISOString() });
      return { ok: true };
    } catch (error) {
      const definite = error instanceof BridgeError && [400, 409].includes(error.status);
      const updated: AnswerReceipt = { ...receipt, state: definite ? "rejected" : "uncertain", updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message.slice(0, 500) : "The remote Hook did not confirm the answer." };
      await replaceStored(file, updated).catch(() => {});
      if (definite) throw error;
      throw new BridgeError(409, "This answer may have been delivered. Check the remote conversation before answering again.");
    }
  }
}

const codexAnswerSchema = z.array(z.object({
  optionIndexes: z.array(z.number().int().nonnegative()).min(1).max(12).optional(),
  text: questionText.optional(),
}).strict().refine(answer => !!answer.optionIndexes || !!answer.text)).min(1).max(8);
const claudeAnswerSchema = z.object({
  answers: z.record(questionText, z.union([questionText, z.array(questionText).min(1).max(24)])).refine(answers => Object.keys(answers).length > 0),
  response: questionText.optional(),
}).strict();

/** Build, but never reinterpret, the existing remote answer route's payload. */
export function questionAnswerRequest(notificationValue: unknown, answer: unknown): { route: string; data: Json } {
  const notification = dispatchQuestionNotificationSchema.parse(notificationValue);
  if (notification.kind === "headless" || notification.destination.kind === "headless") {
    const providerName = notification.kind === "headless" ? notification.provider : "headless";
    throw new BridgeError(409, `${providerName} headless workers do not expose an answer API.`);
  }
  const target = notification.destination.target;
  if (notification.kind === "codex") {
    const answers = codexAnswerSchema.parse(answer);
    if (answers.length !== notification.questions.length) throw new BridgeError(400, "Answer every question.");
    return { route: "/v1/questions/answer", data: { target, toolUseId: notification.toolUseId, answers } };
  }
  if (notification.kind === "claude") {
    const parsed = claudeAnswerSchema.parse(answer);
    const asked = new Set(notification.questions.map(question => typeof object(question).question === "string" ? object(question).question : ""));
    if (Object.keys(parsed.answers).some(question => !asked.has(question))) throw new BridgeError(400, "The answer names a question that was not asked.");
    const updatedInput = { ...notification.input, answers: parsed.answers, ...(parsed.response ? { response: parsed.response } : {}) };
    return { route: "/v1/approvals/answer", data: { target, actionId: notification.actionId, decision: "approve", updatedInput } };
  }
  const keys = z.array(answerKey).min(1).max(4).parse(object(answer).keys ?? answer);
  return { route: "/v1/keys", data: { target, keys } };
}
