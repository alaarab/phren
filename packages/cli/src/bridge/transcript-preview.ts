import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { codexThreadPreview } from "./codex-threads.js";
import { readPaneText } from "./pane-text.js";
import { object, objects, type Json, type Target } from "./protocol.js";
import { withTranscriptIndex } from "./transcript-index.js";
import type { Entry } from "./transcripts.js";
import { stripTerminal } from "../terminal-text.js";

export interface TranscriptPreview { turnStartedAt: string; text: string }
export const PREVIEW_INTERVAL_MS = 500;
const MAX_TEXT = 32_768;
// A JSON-escaped UTF-16 code unit takes at most six bytes, plus metadata.
const MAX_PREVIEW_BYTES = MAX_TEXT * 6 + 1_024;

/** Only the last Claude reply after the current prompt is eligible. A missing
 * prompt anchor is deliberately silent: scrollback could belong to an old turn. */
export function claudePanePreview(rendered: string, prompt: string, previous = ""): string {
  const raw = stripTerminal(rendered).split("\n");
  // The rule above the input box can carry the session title
  // ("───── Claude sesh ─"); it ends the reply, it is never part of it.
  // A narrow pane leaves the titled rule a single dash ("…title… ─"), so a
  // line that ends in a rule dash right above the input prompt ends it too.
  const lines = raw.map((line, index) => (/[─━═]{3,}/.test(line) && !/^\s*[│┃║]/.test(line))
    || (/[─━═]\s*$/.test(line) && /^\s*[❯>]\s*$/.test(raw[index + 1] ?? "")) ? "❯" : line.replace(/[\u2500-\u257f]/g, "").trimEnd());
  const firstPrompt = prompt.trim().split(/\r?\n/)[0]?.trim();
  if (!firstPrompt) return "";
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*[❯>]\s*\S/.test(lines[i])) continue;
    const shown = lines[i].replace(/^\s*[❯>]\s*/, "").trim();
    if (shown === firstPrompt || (shown.length >= 12 && firstPrompt.startsWith(shown))) start = i + 1;
  }
  // Once anchored, a reply can scroll its prompt off screen. Extend only
  // through a matching text overlap; unrelated terminal lines cannot replace it.
  const scrolled = start < 0;
  if (scrolled && !previous) return "";
  const reply: string[] = [];
  let writing = scrolled;
  const body = lines.slice(Math.max(0, start)), rawBody = raw.slice(Math.max(0, start));
  // A "⏺" block whose next line is a "⎿" result is a tool call, collapsed
  // ("⏺ Running 1 shell command…") or not; it lands as its own entry.
  const toolBlock = (index: number) => {
    let wrapped = false;
    for (let next = index + 1; next < body.length; next++) {
      if (!body[next].trim()) continue;
      // A result ("⎿") or a sub-agent tree ("├─ Plan · 0 tool uses") follows a tool call.
      // A narrow pane wraps the call's description ("⏺ Finding retire wording
      // around Power" / "Portal reports"); its "⎿", indented under the call as
      // Claude draws it, comes after the wrap. A new block, the prompt or a
      // blank line after text ends the search.
      if ((wrapped ? /^\s+(?:│\s*)?[⎿├└]/ : /^\s*(?:│\s*)?[⎿├└]/).test(rawBody[next])) return true;
      wrapped = true;
      if (/^\s*[⏺●❯>]/.test(body[next])) return false;
      if (!body[next + 1]?.trim()) return false;
    }
    return false;
  };
  for (const [index, line] of body.entries()) {
    if (/^\s*[❯>]/.test(line) || /esc(?:ape)? to interrupt/i.test(line)) break;
    if (/^\s*[✻✽✶✢✳✦·⠁-⣿]/u.test(line) || parseClaudeSpinnerLine(line)) continue;
    // A running tool group ("⏺ Running 2 agents…") and a tool call
    // ("⏺ Bash(ls)", "⏺ phren - search (MCP)(…)") are not reply
    // text; it lands as its own entry a moment later.
    if (/^\s*[⏺●]\s*[\w.:-]+(?: - [\w.:-]+)?(?: \(MCP\))?\(/.test(line) || (/^\s*[⏺●]/.test(line) && toolBlock(index))
      || /^\s*[⏺●]\s*(?:Running|Calling|Reading|Searching|Writing|Editing|Fetching|Updating|Listing|Creating)\b[^.!?]*(?:…|\.\.\.)/.test(line)) { writing = false; continue; }
    if (/^\s*[⏺●]/.test(line)) { reply.length = 0; writing = true; }
    if (!writing) continue;
    const clean = line.replace(/^\s*[⏺●]\s?/, "").replace(/[⠁-⣿✻✽✶✢✳]/gu, "");
    if (/^\s*(?:↳|⎿|ctrl\+|shift\+|\? for shortcuts)/i.test(clean) || claudeChrome(clean)) continue;
    reply.push(clean.replace(/^ {2}/, ""));
  }
  const text = unwrapTerminalLines(reply).trim().slice(0, MAX_TEXT);
  if (!scrolled) return text;
  if (text.startsWith(previous)) return text;
  const overlap = previous.lastIndexOf(text.split("\n", 1)[0].slice(0, 80));
  return overlap >= 0 && text.startsWith(previous.slice(overlap))
    ? (previous.slice(0, overlap) + text).slice(0, MAX_TEXT) : previous;
}

/**
 * Claude Code's own screen text, never part of a reply: the update and
 * restart notices, status lines it marks ✔ / ✗ / ⚠ / ※, tips, and the
 * context and auto-accept hints drawn around the input box.
 */
export function claudeChrome(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  return /^[✔✓✗✘⚠※]\s/.test(text)
    || /\b(?:Update installed|Restart to update|Auto-update failed|Update available|Run \/doctor|Claude Code has been updated)\b/i.test(text)
    || /^(?:Tip|Hint):\s/i.test(text)
    || /^(?:⏵⏵|⏸)\s/.test(text)
    || /\b(?:auto-accept edits|plan mode) (?:on|off)\b/i.test(text)
    || /^Context left until auto-compact\b/i.test(text)
    || /^(?:esc to (?:interrupt|cancel)|press esc)\b/i.test(text);
}

/** A block line that starts its own row even inside a paragraph: a list
 * item, heading, quote, table row or code fence. */
/** No terminal pane Claude draws in is narrower than this. */
const MIN_WRAP_WIDTH = 40;
const BLOCK_START = /^\s*(?:[-*+•]\s|\d+[.)]\s|#{1,6}\s|>|\||```|~~~)/;

/**
 * Undoes the terminal's word wrap. Claude draws a paragraph wrapped to the
 * pane's width, so the phone would show each wrap as a hard break. A line is
 * joined to the next when the next line's first word would not have fitted
 * on it, which is exactly what a soft wrap looks like; the widest line
 * stands in for the pane width, and below 40 columns nothing is joined. Blank lines, block starts and fenced code
 * keep their breaks.
 */
export function unwrapTerminalLines(lines: readonly string[]): string {
  const width = Math.max(0, ...lines.map(line => line.length));
  // Too narrow to be a pane's wrap: short replies keep their own lines.
  if (width < MIN_WRAP_WIDTH) return lines.join("\n");
  const out: string[] = [];
  let fenced = false;
  lines.forEach((line, index) => {
    const fence = /^\s*(?:```|~~~)/.test(line);
    const before = index > 0 ? lines[index - 1] : undefined;
    const firstWord = line.trimStart().split(/\s/, 1)[0] ?? "";
    const wrapped = !fenced && !fence && before !== undefined && out.length > 0
      && before.trim() !== "" && line.trim() !== "" && !BLOCK_START.test(line)
      && before.trimEnd().length + 1 + firstWord.length > width;
    if (wrapped) out[out.length - 1] += " " + line.trim();
    else out.push(line);
    if (fence) fenced = !fenced;
  });
  return out.join("\n");
}

/** Claude's spinner line, as structured fields: the verb, the turn's elapsed
 * seconds, the token count and its direction, and whether it is thinking.
 * "✻ Whirlpooling… (27s · ↓ 2.3k tokens · thinking)". */
export interface ClaudeSpinner {
  verb: string;
  elapsed?: number;
  tokens?: { count: number; direction: "up" | "down" };
  thinking: boolean;
  /** "thought for 4s": how long the finished thinking took. */
  thoughtFor?: number;
}

const SPINNER_LINE = /^\s*[✻✽✶✢✳✦·*⠁-⣿]\s+([A-Z][\p{L}'-]{1,30})(?:…|\.\.\.)\s*\(([^)]*)\)/u;

function spinnerSeconds(text: string): number | undefined {
  const match = /^(?:(\d{1,4})h\s*)?(?:(\d{1,4})m\s*)?(?:(\d{1,5})s)?$/.exec(text.trim());
  if (!match || (!match[1] && !match[2] && !match[3])) return undefined;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

/** One spinner line, or undefined for anything else. The parenthesis must
 * start with a time or say "esc to interrupt", as Claude's does. */
export function parseClaudeSpinnerLine(line: string): ClaudeSpinner | undefined {
  const match = SPINNER_LINE.exec(line);
  if (!match) return undefined;
  const parts = match[2].split("·").map(part => part.trim()).filter(Boolean);
  if (!/^\d/.test(parts[0] ?? "") && !parts.some(part => /esc to interrupt/i.test(part))) return undefined;
  const spinner: ClaudeSpinner = { verb: match[1], thinking: false };
  for (const part of parts) {
    const seconds = spinnerSeconds(part);
    const tokens = /^([↑↓])\s*(\d{1,6}(?:[.,]\d{1,3})?)\s*([kKmM]?)\s+tokens?$/.exec(part);
    const thought = /^thought for (.+)$/i.exec(part);
    if (seconds !== undefined && spinner.elapsed === undefined) spinner.elapsed = seconds;
    else if (tokens) {
      const scale = /k/i.test(tokens[3]) ? 1_000 : /m/i.test(tokens[3]) ? 1_000_000 : 1;
      const count = Math.round(Number(tokens[2].replace(",", ".")) * scale);
      if (Number.isFinite(count) && count <= 1e9) spinner.tokens = { count, direction: tokens[1] === "↑" ? "up" : "down" };
    } else if (/^thinking\b/i.test(part)) spinner.thinking = true;
    else if (thought) {
      const value = spinnerSeconds(thought[1]);
      if (value !== undefined) spinner.thoughtFor = value;
    }
  }
  return spinner;
}

/** The newest spinner line on screen. */
export function claudeSpinner(rendered: string): ClaudeSpinner | undefined {
  const lines = stripTerminal(rendered).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const spinner = parseClaudeSpinnerLine(lines[i]);
    if (spinner) return spinner;
  }
  return undefined;
}

/** The word Claude's own spinner shows ("✻ Pondering… (12s · esc to interrupt)"). */
export function claudeSpinnerVerb(rendered: string): string | undefined {
  return claudeSpinner(rendered)?.verb;
}

export function readPreviewPane(target: Target): Promise<string> {
  return readPaneText(target.server, target.pane,
    { method: "agent.read", source: "visible", lines: 80, timeoutMs: 2_000, what: "Preview pane read" });
}

/** Older Codex rollouts may carry public text deltas between response items.
 * Keep a bounded raw cursor, since history intentionally filters these out. */
export class CodexRolloutPreview {
  private revision?: string;
  private cursor = 0;
  private startedAt?: string;
  private text = "";
  async read(file: string): Promise<TranscriptPreview | null> {
    return withTranscriptIndex(file, async (handle, index) => {
      if (this.revision !== index.revision) { this.cursor = Math.max(0, index.lines - 2_000); this.startedAt = undefined; this.text = ""; }
      const rows: Json[] = [];
      for await (const row of index.rows(handle, index.lines, Math.max(this.cursor, index.lines - 2_000))) {
        if (!row.bytes) continue;
        try { rows.push(object(JSON.parse(row.bytes.toString()))); } catch { /* Incomplete or malformed event. */ }
      }
      for (const raw of rows.reverse()) {
        const payload = object(raw.payload), params = object(raw.params);
        if (raw.type === "event_msg" && payload.type === "task_started") {
          const time = payload.started_at;
          this.startedAt = typeof raw.timestamp === "string" ? raw.timestamp
            : typeof time === "number" ? new Date(time > 1e12 ? time : time * 1000).toISOString() : undefined;
          this.text = "";
        } else if (raw.type === "event_msg" && ["task_complete", "task_completed", "turn_aborted", "task_aborted", "error"].includes(String(payload.type))) {
          this.startedAt = undefined; this.text = "";
        } else if (raw.type === "response_item" && payload.type === "message" && payload.role === "assistant") this.text = "";
        else if (this.startedAt && ((raw.type === "event_msg" && payload.type === "agent_message_delta" && payload.channel !== "analysis")
          || (raw.method === "item/agentMessage/delta" && params.threadId !== undefined))) {
          const delta = raw.method ? params.delta : payload.delta;
          if (typeof delta === "string") this.text = (this.text + delta).slice(0, MAX_TEXT);
        }
      }
      this.cursor = index.lines; this.revision = index.revision;
      return this.startedAt && Number.isFinite(Date.parse(this.startedAt)) && this.text ? { turnStartedAt: this.startedAt, text: this.text } : null;
    });
  }
}

export async function readDeltaPreview(target: Target, file?: string, rollout?: CodexRolloutPreview): Promise<TranscriptPreview | null> {
  if (target.source === "codex") return await codexThreadPreview(target.session)
    ?? (file && rollout ? await rollout.read(file).catch(() => null) : null);
  if (target.source !== "opencode" || !file) return null;
  try {
    const handle = await open(file + ".preview.json", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_PREVIEW_BYTES) return null;
      // Bound the read too: the file can grow between stat and read.
      const buffer = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_PREVIEW_BYTES) return null;
      bytes = buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
    const value = object(JSON.parse(bytes.toString("utf8")));
    if (typeof value.turnStartedAt !== "string" || !Number.isFinite(Date.parse(value.turnStartedAt))
        || typeof value.text !== "string" || !value.text || value.text.length > MAX_TEXT) return null;
    return { turnStartedAt: value.turnStartedAt, text: value.text };
  } catch { return null; }
}

/** Socket-local, ephemeral state. It never writes transcript rows or advances
 * the history cursor. Final rows bypass the text throttle and clear atomically. */
export class TranscriptPreviewStream {
  private startedAt?: string;
  private prompt = "";
  private landed = false;
  private ended = false;
  /** Claude's own spinner word for the running turn, sent beside frames as
   * `activityVerb` for older phones. */
  verb: string | undefined;
  /** The whole spinner line for the running turn, sent as `activity`;
   * phones without it ignore the field. */
  activity: ClaudeSpinner | undefined;
  private sentActivity = "";
  private lastRead = -Infinity;
  private lastSent = -Infinity;
  private current: TranscriptPreview | null = null;
  private observedLine = -1;
  private wasWorking = false;
  private readonly rollout = new CodexRolloutPreview();
  constructor(private readonly target: Target,
    private readonly pane: () => Promise<string> = () => readPreviewPane(target),
    private readonly delta: (file?: string) => Promise<TranscriptPreview | null> = file => readDeltaPreview(target, file, this.rollout)) {}

  observe(entries: Entry[], reset = false): void {
    if (reset) { this.observedLine = -1; this.startedAt = undefined; this.landed = false; this.ended = false; this.wasWorking = false; }
    for (const { raw, line } of entries) {
      if (line <= this.observedLine) continue;
      this.observedLine = line;
      if (this.target.source === "codex") {
        // Codex brackets a turn with task_started and task_complete; its
        // delta source is only read between them.
        const payload = object(raw.payload);
        if (raw.type === "event_msg" && payload.type === "task_started") this.ended = false;
        else if (raw.type === "response_item" && payload.type === "message" && payload.role === "user") this.ended = false;
        else if (raw.type === "event_msg" && ["task_complete", "task_completed", "turn_aborted", "task_aborted"].includes(String(payload.type))) this.ended = true;
        continue;
      }
      if (this.target.source !== "claude") continue;
      const message = object(raw.message), blocks = objects(message.content);
      if (raw.type === "user" && !raw.phrenQueued && !raw.isMeta && !blocks.some(b => b.type === "tool_result")) {
        const prompt = typeof message.content === "string" ? message.content : blocks.filter(b => b.type === "text").map(b => String(b.text ?? "")).join("\n");
        if (prompt.trim() && typeof raw.timestamp === "string" && Number.isFinite(Date.parse(raw.timestamp))) {
          this.startedAt = raw.timestamp; this.prompt = prompt; this.landed = false; this.ended = false; this.wasWorking = false; this.verb = undefined; this.activity = undefined;
        }
      } else if (this.startedAt && ((raw.type === "assistant" && message.stop_reason === "end_turn")
        || (raw.type === "system" && raw.subtype === "turn_duration"))) {
        // The transcript says the turn is over before the shared snapshot
        // (up to 2.5 s old) stops saying "working": stop reading the pane now.
        this.landed = true; this.ended = true; this.verb = undefined; this.activity = undefined;
      } else if (this.startedAt && (raw.type === "assistant" || blocks.some(b => b.type === "tool_result"))) this.landed = true;
    }
  }

  async update(status: unknown, file?: string, now?: number): Promise<{ preview: TranscriptPreview | null } | undefined> {
    const readAt = now ?? Date.now();
    let next: TranscriptPreview | null = null;
    if (status === "working") {
      this.wasWorking = true;
      if (this.target.source === "codex" || this.target.source === "opencode") {
        // These harnesses own a delta source. Never scrape their pane, even
        // when the source is temporarily empty or unavailable.
        if (!this.ended) next = await this.delta(file);
      } else if (this.target.source === "claude" && this.startedAt && !this.ended) {
        if (readAt - this.lastRead < PREVIEW_INTERVAL_MS) return undefined;
        this.lastRead = readAt;
        // The reply text stops once a real entry lands; Claude's spinner
        // verb keeps naming the work until the turn ends.
        const pane = await this.pane();
        const text = this.landed ? "" : claudePanePreview(pane, this.prompt,
          this.current?.turnStartedAt === this.startedAt ? this.current.text : "");
        const spinner = claudeSpinner(pane);
        if (spinner) { this.activity = spinner; this.verb = spinner.verb; }
        if (text) next = { turnStartedAt: this.startedAt, text };
      }
    } else if (this.target.source === "claude" && this.wasWorking) { this.landed = true; this.ended = true; this.verb = undefined; this.activity = undefined; }
    const sentAt = now ?? Date.now();
    // The phone ticks the clock itself: only the verb, tokens and thinking
    // state are worth a frame of their own.
    const activity = this.activity ? JSON.stringify({ ...this.activity, elapsed: undefined }) : "";
    const previewChanged = next?.text !== this.current?.text || next?.turnStartedAt !== this.current?.turnStartedAt;
    const activityChanged = activity !== this.sentActivity;
    if (!previewChanged && !activityChanged) return undefined;
    if ((next || !previewChanged) && sentAt - this.lastSent < PREVIEW_INTERVAL_MS) return undefined;
    this.current = next; this.sentActivity = activity;
    if (next || activityChanged) this.lastSent = sentAt;
    return { preview: next };
  }
}
