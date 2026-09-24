import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteText } from "../phren-paths.js";
import type { LaunchOptions } from "./adapters/types.js";

/** How long a worker waits for the owner to answer a permission before it is
 * told nobody did. A test shortens it. */
function approvalWindow(): number {
  const value = Number(process.env.PHREN_FANOUT_APPROVAL_MS);
  return Number.isFinite(value) && value >= 100 && value <= 24 * 3_600_000 ? Math.floor(value) : 3_600_000;
}
const ANSWER_POLL_MS = 250;
const LISTEN_TIMEOUT_MS = 30_000;
const SESSION = /^ses_[0-9A-Za-z]{1,64}$/;
/** The same rules `opencode run` gives a session it creates: nobody is there
 * to answer a question or approve a plan switch. */
const HEADLESS_RULES = ["question", "plan_enter", "plan_exit"].map(permission => ({ permission, action: "deny", pattern: "*" }));
export const DENIED_FEEDBACK = "The owner denied this request from the phone. Do not retry it; continue without it and say in your final report what you could not do because of it.";
export const UNANSWERED_FEEDBACK = "Nobody answered this permission request in time. Do not retry it; continue without it and say in your final report what you could not do because of it.";

export interface DriveOptions extends LaunchOptions {
  store: string;
  label: string;
  prompt: string;
  jobId: string;
  password: string;
  /** One `opencode run --format json` event line for the job's event log. */
  emit(line: string): void;
  /** The worker's session, as soon as it exists. */
  session(id: string): void;
}

interface Asked { id: string; sessionID: string; permission: string; patterns: string[] }
/** The fields of OpenCode's bus events the driver reads. */
interface ServerEvent {
  type?: string;
  properties?: {
    id?: string; sessionID?: string; permission?: string; patterns?: unknown;
    info?: { id?: string; parentID?: string };
    part?: { sessionID?: string; type?: string; state?: { status?: string }; time?: { end?: number } };
    status?: { type?: string };
    error?: { name?: string; data?: { message?: string } };
  };
}

/** Waits for `opencode serve` to print its address. */
function listening(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => done(new Error("opencode serve did not start listening.")), LISTEN_TIMEOUT_MS);
    const done = (error?: Error, url?: string) => {
      clearTimeout(timer); child.stdout?.off("data", data); child.off("exit", exit);
      if (error) reject(error); else resolve(url!);
    };
    const data = (chunk: Buffer) => {
      buffered = (buffered + chunk.toString("utf8")).slice(-8_192);
      const match = /listening on (http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+)/.exec(buffered);
      if (match) done(undefined, match[1]);
    };
    const exit = () => done(new Error("opencode serve exited before listening."));
    child.stdout?.on("data", data);
    child.once("exit", exit);
  });
}

/** Drives one fan-out worker through `opencode serve` and its HTTP API rather
 * than `opencode run`, which rejects every permission ask on its own. The
 * events it writes are the ones `opencode run --format json` prints, so the
 * Hook's transcript readers and the loop watchdog read them unchanged. A
 * permission ask becomes the same request file the Phren plugin writes for a
 * pane, the Hook shows it on the phone under the worker's parent, and the
 * owner's answer resumes the same session: Allow runs the call, Deny rejects it
 * with feedback so the worker carries on and reports the refusal. */
export async function driveOpencode(child: ChildProcess, o: DriveOptions): Promise<number> {
  const base = await listening(child);
  const auth = "Basic " + Buffer.from(`opencode:${o.password}`).toString("base64");
  const query = `directory=${encodeURIComponent(o.worktree)}`;
  const call = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`${base}${route}${route.includes("?") ? "&" : "?"}${query}`, { method,
      headers: { Authorization: auth, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    if (!response.ok) throw new Error(`opencode ${method} ${route.split("?")[0]} failed with ${response.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  };
  const events = await fetch(`${base}/event?${query}`, { headers: { Authorization: auth, Accept: "text/event-stream" } });
  if (!events.ok || !events.body) throw new Error(`opencode event stream failed with ${events.status}.`);
  const session = o.resume ? (await call("GET", `/session/${encodeURIComponent(o.resume)}`)).id
    : (await call("POST", "/session", { permission: HEADLESS_RULES })).id;
  if (typeof session !== "string" || !SESSION.test(session)) throw new Error("opencode did not return a session.");
  o.session(session);
  const line = (type: string, fields: Record<string, unknown>) => o.emit(JSON.stringify({ type, timestamp: Date.now(), sessionID: session, ...fields }) + "\n");
  const family = new Set([session]);
  let error: string | undefined, busy = false, asks = Promise.resolve();
  const stop = new AbortController();
  const ask = async (asked: Asked) => {
    // OpenCode's own loop detector asks too; the launcher's watchdog stops a
    // real loop and says why, which is clearer than a refused permission.
    if (asked.permission === "doom_loop") { await call("POST", `/permission/${encodeURIComponent(asked.id)}/reply`, { reply: "once" }); return; }
    const decision = await relay(o, session, asked, stop.signal);
    if (decision === "stopped") return;
    line("phren/permission", { permission: asked.permission, patterns: asked.patterns, decision });
    await call("POST", `/permission/${encodeURIComponent(asked.id)}/reply`, decision === "approve" ? { reply: "once" }
      : { reply: "reject", message: decision === "deny" ? DENIED_FEEDBACK : UNANSWERED_FEEDBACK });
  };
  const reader = events.body.getReader(), decoder = new TextDecoder();
  let pending = "";
  const read = async (): Promise<void> => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("opencode closed its event stream.");
      pending += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const block = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const data = block.split("\n").filter(row => row.startsWith("data:")).map(row => row.slice(5).trimStart()).join("\n");
        if (!data) continue;
        let event: ServerEvent;
        try { event = JSON.parse(data); } catch { continue; }
        const p = event.properties ?? {};
        if (event.type === "session.created" && p.info?.parentID && family.has(p.info.parentID) && p.info.id) family.add(p.info.id);
        else if (event.type === "message.part.updated" && p.part?.sessionID === session) {
          const part = p.part;
          busy = true;
          if (part.type === "tool" && ["completed", "error"].includes(String(part.state?.status))) line("tool_use", { part });
          else if (part.type === "step-start") line("step_start", { part });
          else if (part.type === "step-finish") line("step_finish", { part });
          else if (part.type === "text" && part.time?.end) line("text", { part });
        } else if (event.type === "session.error" && p.sessionID === session && p.error) {
          const message = String(p.error.data?.message ?? p.error.name);
          error = error ? `${error}\n${message}` : message;
          line("error", { error: p.error });
        } else if (event.type === "session.status" && p.sessionID === session) {
          if (p.status?.type === "busy") busy = true;
          else if (p.status?.type === "idle" && busy) return;
        } else if (event.type === "permission.asked" && p.sessionID && family.has(p.sessionID) && typeof p.id === "string") {
          const asked: Asked = { id: p.id, sessionID: p.sessionID, permission: String(p.permission ?? "action"),
            patterns: Array.isArray(p.patterns) ? p.patterns.filter((value: unknown): value is string => typeof value === "string") : [] };
          // One question on the phone at a time, in the order they came.
          asks = asks.then(() => ask(asked)).catch(failure => { error = String(failure); });
        }
      }
    }
  };
  const loop = read();
  await call("POST", `/session/${session}/prompt_async`, { agent: o.review ? "plan" : "build", parts: [{ type: "text", text: o.prompt }],
    ...(o.model ? { model: { providerID: o.model.split("/")[0], modelID: o.model.split("/").slice(1).join("/") } } : {}),
    ...(o.variant ? { variant: o.variant } : {}) });
  try { await loop; } finally { stop.abort(); await reader.cancel().catch(() => {}); }
  await asks;
  return error ? 1 : 0;
}

/** Publishes one ask where the Hook looks for OpenCode approvals and waits
 * for the phone's answer. The request carries the fan-out job so the Hook
 * can find the worker's parent conversation. */
async function relay(o: DriveOptions, session: string, asked: Asked, signal: AbortSignal): Promise<"approve" | "deny" | "timeout" | "stopped"> {
  const directory = path.join(o.store, ".runtime", "approvals");
  const request = path.join(directory, `opencode-${session}.request.json`), answer = path.join(directory, `opencode-${session}.answer.json`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.rmSync(answer, { force: true });
  const created = Date.now(), deadline = created + approvalWindow(), pattern = asked.patterns.join(", ");
  atomicWriteText(request, JSON.stringify({ id: asked.id, sessionID: session, type: asked.permission,
    title: `Allow ${asked.permission} for ${o.label}?`.slice(0, 300), message: (pattern ? `${asked.permission}: ${pattern}` : `${o.label} asks to use ${asked.permission}.`).slice(0, 2000),
    fanout: o.jobId, createdAt: new Date(created).toISOString(), expiresAt: new Date(deadline).toISOString() }), { mode: 0o600 });
  try {
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, ANSWER_POLL_MS));
      if (signal.aborted) return "stopped";
      try {
        const value = JSON.parse(fs.readFileSync(answer, "utf8")) as { id?: unknown; decision?: unknown };
        if (value.id === asked.id && (value.decision === "approve" || value.decision === "deny")) return value.decision;
      } catch { /* Not answered yet. */ }
    }
    return "timeout";
  } finally {
    fs.rmSync(answer, { force: true });
    fs.rmSync(request, { force: true });
  }
}
