import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, stat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { BridgeError, bridgeRoot, object, objects, type Json, type Target } from "./protocol.js";
import { paneIdentity, validateTarget } from "./herdr.js";
import { transcriptPath } from "./transcripts.js";
import { withTranscriptIndex } from "./transcript-index.js";

const exec = promisify(execFile);
const text = z.string().trim().min(1).max(4000).refine(t => !/[\x00-\x08\x0b-\x1f\x7f]/.test(t));
const question = z.object({ title: text, options: z.array(text).max(12).nullable().optional() });
const questionSet = z.array(question).min(1).max(8);
type Question = z.infer<typeof question>;

/** Codex's asynchronous questions return {accepted:true} immediately. Their
 * answers are ordinary user messages quoting the original title, not replies
 * to item/tool/requestUserInput (that RPC is the synchronous tool). */
export function asyncQuestion(raw: Json, id: string): Question[] | undefined {
  const p = object(raw.payload);
  if (raw.type !== "response_item" || p.type !== "function_call" || p.call_id !== id
      || !["request_user_input_async", "functions.request_user_input_async"].includes(String(p.name))) return;
  try { return questionSet.parse(object(JSON.parse(String(p.arguments))).questions); } catch { return; }
}
export function questionReply(questions: Question[], answers: unknown): string {
  const parsed = z.array(z.object({ optionIndexes: z.array(z.number().int().nonnegative()).max(1), text: z.string().max(4000).optional() })).parse(answers);
  if (parsed.length !== questions.length) throw new BridgeError(400, "Answer every question.");
  return questions.map((q, index) => {
    const answer = parsed[index], typed = answer.text?.trim() ?? "", options = q.options ?? [];
    if (answer.optionIndexes.length + (typed ? 1 : 0) !== 1) throw new BridgeError(400, "Choose one answer for each question.");
    const value = typed || options[answer.optionIndexes[0]];
    if (!value || !text.safeParse(value).success) throw new BridgeError(400, "Choose an available answer.");
    return q.title.split("\n").map(line => `> ${line}`).join("\n") + "\n\n" + value;
  }).join("\n\n");
}
const answersQuestions = (reply: string, questions: Question[]) => questions.every(q => {
  const quote = q.title.split("\n").map(line => `> ${line}`).join("\n") + "\n\n";
  const index = reply.indexOf(quote);
  return index >= 0 && reply.slice(index + quote.length).trim().length > 0;
});
interface PendingQuestion { id: string; questions: Question[] }
export async function pendingAsyncQuestions(file: string, targetID?: string): Promise<PendingQuestion[]> {
  return withTranscriptIndex(file, async (handle, index) => {
    const replies: string[] = [], acknowledged = new Set<string>(), resolved = new Set<string>(), pending: PendingQuestion[] = [];
    let bytes = 0;
    for await (const row of index.rows(handle, index.lines, Math.max(0, index.lines - 10_000))) {
      // An incomplete scan is not evidence that no questions remain. Status
      // omits this field on failure, preserving the phone's known prompts.
      if (!row.bytes || (bytes += row.bytes.length) > 8_388_608) throw new BridgeError(413, "The pending question history is too large to verify.");
      let raw: Json;
      try { raw = object(JSON.parse(row.bytes.toString())); } catch { continue; }
      if (raw.type !== "response_item") continue;
      const p = object(raw.payload), id = typeof p.call_id === "string" ? p.call_id : "";
      if (p.type === "message" && p.role === "user") replies.push(objects(p.content).map(b => typeof b.text === "string" ? b.text : "").join("\n"));
      if (id && ["function_call_output", "custom_tool_call_output"].includes(String(p.type)) && !resolved.has(id) && !acknowledged.has(id)) {
        try { if (object(JSON.parse(String(p.output))).accepted === true) acknowledged.add(id); else resolved.add(id); }
        catch { resolved.add(id); }
      }
      if (targetID && resolved.has(targetID)) return [];
      if (!id || !acknowledged.has(id)) continue;
      const questions = asyncQuestion(raw, id);
      if (questions && !replies.some(reply => answersQuestions(reply, questions))) {
        pending.push({ id, questions });
        if (pending.length >= 64) throw new BridgeError(413, "Too many pending questions to verify.");
      }
      if (targetID && questions && id === targetID) return pending.filter(p => p.id === targetID);
    }
    if (index.lines > 10_000) throw new BridgeError(413, "The pending question history is too large to verify.");
    return pending.reverse();
  });
}

export async function pendingAsyncQuestion(file: string, id: string): Promise<Question[]> {
  const pending = (await pendingAsyncQuestions(file, id)).find(p => p.id === id);
  if (!pending) throw new BridgeError(409, "This question is no longer pending. Refresh the conversation.");
  return pending.questions;
}

export class CodexQuestions {
  private snapshots = new Map<string, { at: number; stamp: string; pending: PendingQuestion[] }>();
  private failedSnapshots = new Map<string, number>();
  private inboxAvailable = false;
  /** Feature discovery must never delay permission/status frames. */
  get available(): boolean { void this.supported(); return this.inboxAvailable; }
  private probe?: { at: number; result: Promise<boolean> };
  constructor(private executable = "codex") {}
  supported(): Promise<boolean> {
    if (!this.probe || Date.now() - this.probe.at > 300_000) this.probe = { at: Date.now(), result:
      exec(this.executable, ["queue", "--help"], { timeout: 5000, maxBuffer: 65_536 })
        .then(({ stdout }) => stdout.includes("--thread") && stdout.includes("--message")).catch(() => false)
        .then(available => { this.inboxAvailable = available; return available; }) };
    return this.probe.result;
  }
  async pending(target: Target): Promise<Json[]> {
    if (target.source !== "codex") return [];
    if (Date.now() - (this.failedSnapshots.get(target.session) ?? 0) < 5000) throw new BridgeError(503, "Pending question history is unavailable.");
    const file = await transcriptPath("codex", target.session);
    const cached = this.snapshots.get(target.session);
    let pending = cached?.pending;
    if (!cached || Date.now() - cached.at > 1000) {
      const metadata = await stat(file), stamp = `${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
      pending = cached?.stamp === stamp ? cached.pending : await pendingAsyncQuestions(file).catch(error => {
        if (this.failedSnapshots.size >= 64) this.failedSnapshots.delete(this.failedSnapshots.keys().next().value!);
        this.failedSnapshots.set(target.session, Date.now()); throw error;
      });
      this.failedSnapshots.delete(target.session);
      if (this.snapshots.size >= 64) this.snapshots.delete(this.snapshots.keys().next().value!);
      this.snapshots.set(target.session, { at: Date.now(), stamp, pending });
    }
    return Promise.all((pending ?? []).map(async p => {
      const key = createHash("sha256").update(JSON.stringify([target.source, target.session, p.id])).digest("hex");
      const submitted = await readFile(path.join(bridgeRoot(), "question-replies", key), "utf8").then(value => value === "submitted").catch(() => false);
      return { toolUseId: p.id, isAsync: true, submitted, questions: p.questions.map(q => ({ question: q.title,
        options: (q.options ?? []).map(label => ({ label })), ...(!q.options?.length ? { kind: "text" } : {}) })) };
    })).then(prompts => prompts.filter(p => !p.submitted));
  }
  async answer(target: Target, data: Json): Promise<void> {
    if (target.source !== "codex" || !await this.supported()) throw new BridgeError(409, "This connection needs the question answered in the terminal.");
    z.string().uuid().parse(target.session);
    const id = z.string().min(1).max(512).parse(data.toolUseId);
    const questions = await pendingAsyncQuestion(await transcriptPath("codex", target.session), id);
    const reply = questionReply(questions, data.answers);
    const pane = await validateTarget(target);
    if (await paneIdentity(target.server, pane, true) !== target.session) throw new BridgeError(409, "This pane's conversation changed. Reopen the chat.");
    // Record before invoking the provider: a timeout can mean it accepted the
    // message. Concurrent taps, reconnects, and helper restarts must not resend.
    const directory = path.join(bridgeRoot(), "question-replies");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const key = createHash("sha256").update(JSON.stringify([target.source, target.session, id])).digest("hex");
    const receiptPath = path.join(directory, key);
    const receipt = await open(receiptPath, "wx", 0o600).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new BridgeError(409, "An answer was already submitted. Check the conversation before answering again.");
      throw new BridgeError(503, "Phren could not record this answer. Nothing was sent.");
    });
    await receipt.close();
    try {
      // Explicit UUID, no session-name lookup, no shell, no terminal keystrokes.
      await exec(this.executable, ["queue", "--thread", target.session, "--message", reply], { timeout: 8000, maxBuffer: 65_536 });
      await writeFile(receiptPath, "submitted", { mode: 0o600 });
    } catch { throw new BridgeError(409, "Codex did not confirm the answer. Check the conversation; Phren has not retried it."); }
  }
}
