// Turn timing, token usage and the agent's own spinner and side answers,
// ported from the phone's AgentChatProgress.kt. Pure: JSON in, values out, no
// DOM and no Node APIs. Times are ISO 8601 strings and durations milliseconds,
// matching the rest of the kit.

import { obj, str, bool, num, int, objects, type JsonObject, type JsonValue } from "./tool-presentation.js";
import { readTranscriptFrame, type ChatSource, type TranscriptKind } from "./transcript.js";

/** Provider-reported usage for one model response, never inferred from words. */
export interface AgentTokenUsage {
  input: number;
  output: number;
  cachedInput: number | null;
  reasoningOutput: number | null;
  readonly uncachedInput: number | null;
}

export namespace AgentTokenUsage {
  /** `cachedInput` must not exceed the input, nor reasoning the output. */
  export function read(value: JsonObject | undefined, inputIncludesCache = true): AgentTokenUsage | null {
    if (value === undefined) return null;
    const input = count(value["input_tokens"]);
    if (input === null) return null;
    const output = count(value["output_tokens"]);
    if (output === null) return null;
    const cached = count(value["cached_input_tokens"] ?? value["cache_read_input_tokens"]);
    // Claude reports cache reads/writes separately; Codex includes them in input.
    const totalInput = inputIncludesCache ? input : input + (cached ?? 0) + (count(value["cache_creation_input_tokens"]) ?? 0);
    const reasoning = count(value["reasoning_output_tokens"]);
    if ((cached ?? 0) > totalInput || (reasoning ?? 0) > output) return null;
    return makeUsage(totalInput, output, cached, reasoning);
  }

  function count(value: JsonValueish): number | null {
    const d = num(value);
    if (d === undefined || d < 0 || d > 1_000_000_000_000 || Math.floor(d) !== d) return null;
    return Math.min(d, 2147483647);
  }
}

type JsonValueish = Parameters<typeof num>[0];

function makeUsage(input: number, output: number, cached: number | null, reasoning: number | null): AgentTokenUsage {
  return {
    input, output, cachedInput: cached, reasoningOutput: reasoning,
    get uncachedInput(): number | null { return cached === null ? null : input - cached; },
  };
}

export type AgentChatProgressValue =
  | { kind: "started"; date: string | null }
  | { kind: "finished"; date: string | null }
  | { kind: "stopped" }
  | { kind: "usage"; usage: AgentTokenUsage };

/** One turn-shape or usage event read from a raw transcript row. */
export interface AgentChatProgressEvent {
  line: number;
  value: AgentChatProgressValue;
  timestamp: string | null;
}

export namespace AgentChatProgressEvent {
  export function read(raw: JsonObject, source: ChatSource, line: number): AgentChatProgressEvent | null {
    if (source === "codex" && str(raw["type"]) === "event_msg") {
      const payload = obj(raw["payload"]);
      if (payload === undefined) return null;
      switch (str(payload["type"])) {
        case "task_started":
          return { line, value: { kind: "started", date: date(payload["started_at"], raw["timestamp"]) }, timestamp: null };
        case "task_complete":
        case "task_completed":
          return { line, value: { kind: "finished", date: date(payload["completed_at"], raw["timestamp"]) }, timestamp: null };
        case "turn_aborted":
        case "task_aborted":
          return { line, value: { kind: "stopped" }, timestamp: null };
        case "token_count": {
          const usage = AgentTokenUsage.read(obj(obj(payload["info"])?.["last_token_usage"]));
          return usage === null ? null : { line, value: { kind: "usage", usage }, timestamp: null };
        }
        default:
          return null;
      }
    }
    if (source === "claude" && bool(raw["isMeta"]) !== true && bool(raw["isSidechain"]) !== true) {
      const message = obj(raw["message"]);
      if (message !== undefined && str(message["role"]) === "assistant") {
        const usage = AgentTokenUsage.read(obj(message["usage"]), false);
        return usage === null ? null : { line, value: { kind: "usage", usage }, timestamp: null };
      }
    }
    if (source === "phren" || source === "opencode") {
      const data = obj(raw["data"]);
      if (data !== undefined) {
        switch (str(raw["type"])) {
          case "user/message":
            return { line, value: { kind: "started", date: date(undefined, raw["time"]) }, timestamp: null };
          case "assistant/message": {
            const usage = AgentTokenUsage.read(obj(data["usage"]));
            if (usage !== null) return { line, value: { kind: "usage", usage }, timestamp: null };
            return str(data["stop_reason"]) === "end_turn"
              ? { line, value: { kind: "finished", date: date(undefined, raw["time"]) }, timestamp: null } : null;
          }
          default:
            return null;
        }
      }
    }
    if (source === "copilot" && raw["agentId"] === undefined) {
      const data = obj(raw["data"]);
      if (data !== undefined) {
        switch (str(raw["type"])) {
          // The person's prompt starts the turn; `assistant.turn_start` opens each model call inside it.
          case "user.message":
            return data["source"] === undefined || str(data["source"]) === "user"
              ? { line, value: { kind: "started", date: date(undefined, raw["timestamp"]) }, timestamp: null } : null;
          // Copilot 1.0.87 writes no session.idle: its final answer ends the turn.
          case "assistant.message":
            return str(data["phase"]) === "final_answer"
              ? { line, value: { kind: "finished", date: date(undefined, raw["timestamp"]) }, timestamp: null } : null;
          case "session.idle":
            return bool(data["aborted"]) === true
              ? { line, value: { kind: "stopped" }, timestamp: null }
              : { line, value: { kind: "finished", date: date(undefined, raw["timestamp"]) }, timestamp: null };
          case "abort":
            return { line, value: { kind: "stopped" }, timestamp: null };
          case "assistant.usage": {
            const counts: JsonObject = {
              input_tokens: data["inputTokens"], output_tokens: data["outputTokens"], cached_input_tokens: data["cacheReadTokens"],
            };
            const usage = AgentTokenUsage.read(counts);
            return usage === null ? null : { line, value: { kind: "usage", usage }, timestamp: null };
          }
          default:
            return null;
        }
      }
    }
    return null;
  }

  /** Epoch seconds (as a number) or a fallback ISO string, as an ISO string. */
  function date(value: JsonValueish, fallback: JsonValueish): string | null {
    const n = num(value);
    if (n !== undefined && n > 0 && n < 100_000_000_000) return new Date(Math.trunc(n * 1000)).toISOString();
    return parseIso(str(fallback));
  }
}

function parseIso(value: string | undefined): string | null {
  if (value === undefined) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export type AgentChatProgressPhase = "working" | "finished" | "stopped";

/** One turn bound to transcript lines, across reconnects and older pages. */
export interface AgentChatProgressTurn {
  startLine: number;
  endLine: number | null;
  phase: AgentChatProgressPhase;
  startedAt: string | null;
  finishedAt: string | null;
}

/** The frame the tracker consumes: the transcript's shape read for progress. */
export interface ProgressFrame {
  kind: TranscriptKind;
  replacesConversation: boolean;
  progressEvents: AgentChatProgressEvent[];
}

/**
 * Turn timing bound to transcript lines across reconnects and older pages
 * (AgentChatProgress). Receives one frame at a time and keeps the live turn.
 */
export class AgentChatProgress {
  static Phase = {
    WORKING: "working" as AgentChatProgressPhase,
    FINISHED: "finished" as AgentChatProgressPhase,
    STOPPED: "stopped" as AgentChatProgressPhase,
  };

  turns: AgentChatProgressTurn[] = [];
  phase: AgentChatProgressPhase | null = null;
  startedAt: string | null = null;
  finishedAt: string | null = null;
  usage: AgentTokenUsage | null = null;
  activityLine = -1;
  private latestLine = -1;

  elapsed(now: string = new Date().toISOString()): number | null {
    return AgentChatProgress.elapsed(this.startedAt, this.finishedAt, this.phase, now);
  }

  receive(frame: ProgressFrame): void {
    if (frame.kind === "older") {
      // An older page restores finished rows without replaying current activity.
      const history = new AgentChatProgress();
      history.receiveCurrent(frame);
      const known = new Set(this.turns.map((turn) => turn.startLine));
      this.turns = [...this.turns, ...history.turns.filter((turn) => turn.phase !== "working" && !known.has(turn.startLine))]
        .sort((a, b) => a.startLine - b.startLine);
      return;
    }
    this.receiveCurrent(frame);
  }

  private receiveCurrent(frame: ProgressFrame): void {
    if (frame.replacesConversation) {
      this.turns = []; this.phase = null; this.startedAt = null; this.finishedAt = null;
      this.usage = null; this.activityLine = -1; this.latestLine = -1;
    }
    const previous = this.latestLine;
    for (const event of [...frame.progressEvents].sort((a, b) => a.line - b.line)) {
      if (event.line <= previous) continue;
      this.latestLine = event.line;
      const value = event.value;
      switch (value.kind) {
        case "started":
          this.phase = "working"; this.startedAt = value.date; this.finishedAt = null; this.usage = null; this.activityLine = event.line;
          this.turns = [...this.turns, { startLine: event.line, endLine: null, phase: "working", startedAt: value.date, finishedAt: null }];
          break;
        case "finished":
          this.phase = "finished"; this.finishedAt = value.date; this.activityLine = event.line;
          this.finishTurn(value.date, event.line, "finished");
          break;
        case "stopped":
          this.phase = "stopped"; this.finishedAt = event.timestamp; this.activityLine = event.line;
          this.finishTurn(event.timestamp, event.line, "stopped");
          break;
        case "usage":
          this.usage = value.usage;
          break;
      }
    }
  }

  private finishTurn(date: string | null, line: number, phase: AgentChatProgressPhase): void {
    const last = this.turns[this.turns.length - 1];
    if (last === undefined || last.phase !== "working") return;
    this.turns = [...this.turns.slice(0, -1), { ...last, phase, finishedAt: date, endLine: line }];
  }

  static elapsed(startedAt: string | null, finishedAt: string | null, phase: AgentChatProgressPhase | null, now: string): number | null {
    if (startedAt === null || phase === null) return null;
    const end = phase === "working" ? now : finishedAt;
    if (end === null) return null;
    const elapsed = Date.parse(end) - Date.parse(startedAt);
    return elapsed < 0 ? 0 : elapsed;
  }
}

/**
 * The transcript's own started/finished marks plus the tracker's richer events
 * read from each raw row. The desktop calls this on the raw Hook frame; the
 * transcript reader itself carries only the marks it can prove.
 */
export function readProgressFrame(raw: unknown, source: ChatSource): ProgressFrame {
  const frame = readTranscriptFrame(raw, source);
  const events: AgentChatProgressEvent[] = frame.progressEvents.map((event) => {
    const value: AgentChatProgressValue = event.value.kind === "usage"
      ? { kind: "usage", usage: makeUsage(event.value.input ?? 0, event.value.output ?? 0, event.value.cachedInput ?? null, null) }
      : event.value.kind === "started" ? { kind: "started", date: event.timestamp } : { kind: "finished", date: event.timestamp };
    return { line: event.line, value, timestamp: event.timestamp };
  });
  const entries = objects(obj(raw as JsonValue)?.["entries"]) ?? [];
  for (const entry of entries) {
    const line = int(entry["line"]);
    if (line === undefined || line < 0) continue;
    const rawEntry = obj(entry["raw"]);
    if (rawEntry === undefined) continue;
    const event = AgentChatProgressEvent.read(rawEntry, source, line);
    // The transcript stamps every progress event with its row's time; a stop's
    // frozen elapsed comes from this, so carry it on the rich events too.
    if (event !== null) events.push({ ...event, timestamp: rowTimestamp(rawEntry) });
  }
  return { kind: frame.kind, replacesConversation: frame.replacesConversation, progressEvents: events };
}

function rowTimestamp(raw: JsonObject): string | null {
  const iso = str(raw["timestamp"]);
  if (iso !== undefined) return parseIso(iso);
  const n = num(raw["timestamp"]);
  if (n !== undefined) return new Date(Math.trunc((n > 1e12 ? n / 1000 : n) * 1000)).toISOString();
  return null;
}

export type AgentSideAnswerState = "pending" | "answer" | "error" | "cancelled";

/** Claude Code's `/btw` side question, answered in a terminal panel the Hook reads. */
export interface AgentSideAnswer {
  id: string;
  question: string;
  state: AgentSideAnswerState;
  answer: string | null;
}

export namespace AgentSideAnswer {
  export const State = {
    PENDING: "pending" as AgentSideAnswerState, ANSWER: "answer" as AgentSideAnswerState,
    ERROR: "error" as AgentSideAnswerState, CANCELLED: "cancelled" as AgentSideAnswerState,
  };

  const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
  const STATES: AgentSideAnswerState[] = ["pending", "answer", "error", "cancelled"];

  export function read(frame: JsonObject): AgentSideAnswer {
    const bad = (): never => { throw new Error("The computer returned an invalid side answer."); };
    const id = str(frame["id"]);
    if (id === undefined || !UUID.test(id)) return bad();
    const question = str(frame["question"]);
    if (question === undefined || question.length === 0 || utf8Length(question) > 4_096) return bad();
    const state = STATES.find((candidate) => candidate === str(frame["state"]));
    if (state === undefined) return bad();
    const answer = str(frame["answer"]) ?? null;
    if ((answer !== null && utf8Length(answer) > 131_072) || (state === "answer" && (answer === null || answer.length === 0))) return bad();
    return { id, question, state, answer };
  }

  /** `/btw <question>` for Claude Code. */
  export function question(source: string, text: string): string | null {
    if (source !== "claude") return null;
    const trimmed = text.replace(QUESTION_EDGE, "");
    if (!trimmed.toLowerCase().startsWith("/btw") || trimmed.length <= 4 || !isQuestionWhitespace(trimmed[4])) return null;
    const rest = trimmed.slice(4).split(QUESTION_WHITESPACE).filter((part) => part !== "").join(" ");
    return rest.length === 0 ? null : rest;
  }
}

const QUESTION_WHITESPACE = /[\p{Z}\u0009-\u000D\u0085]+/u;
const QUESTION_EDGE = /^[\p{Z}\u0009-\u000D\u0085]+|[\p{Z}\u0009-\u000D\u0085]+$/gu;
function isQuestionWhitespace(c: string): boolean {
  const code = c.codePointAt(0) ?? 0;
  return (code >= 0x09 && code <= 0x0d) || code === 0x85 || /[\p{Z}]/u.test(c);
}

function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

export type SpinnerDirection = "up" | "down";

/** Claude's spinner line as the Hook reads it. Anything malformed drops the value. */
export interface AgentChatSpinner {
  verb: string;
  elapsed: number | null;
  tokens: number | null;
  direction: SpinnerDirection | null;
  thinking: boolean;
  thoughtFor: number | null;
  readonly tokenText: string | null;
  readonly details: string[];
}

export namespace AgentChatSpinner {
  export const Direction = { UP: "up" as SpinnerDirection, DOWN: "down" as SpinnerDirection };
  const VERB = /^[A-Z][\p{L}'-]{1,30}$/u;

  export function verb(value: unknown): string | null {
    const s = str(value as JsonValueish);
    return s !== undefined && VERB.test(s) ? s : null;
  }

  /** Absent -> `{ value: null }`; malformed -> undefined. */
  function count(raw: JsonValueish, limit: number): { value: number | null } | undefined {
    if (raw === undefined) return { value: null };
    const d = num(raw);
    if (d === undefined || Math.floor(d) !== d || d < 0 || d > limit) return undefined;
    return { value: d };
  }

  export function read(value: unknown): AgentChatSpinner | null {
    const o = obj(value as JsonValueish);
    if (o === undefined) return null;
    const parsedVerb = verb(o["verb"]);
    if (parsedVerb === null) return null;
    const elapsed = count(o["elapsed"], 1_000_000);
    if (elapsed === undefined) return null;
    const thoughtFor = count(o["thoughtFor"], 1_000_000);
    if (thoughtFor === undefined) return null;
    let tokens: number | null = null;
    let direction: SpinnerDirection | null = null;
    if (o["tokens"] !== undefined) {
      const t = obj(o["tokens"]);
      if (t === undefined) return null;
      const parsed = count(t["count"], 1_000_000_000);
      if (parsed === undefined) return null;
      tokens = parsed.value;
      direction = [Direction.UP, Direction.DOWN].find((candidate) => candidate === str(t["direction"])) ?? null;
      if (direction === null) return null;
    }
    let thinking = false;
    if (o["thinking"] !== undefined) {
      const parsed = bool(o["thinking"]);
      if (parsed === undefined) return null;
      thinking = parsed;
    }
    const tokenText = tokens === null ? null : `${direction === Direction.UP ? "↑" : "↓"} ${tokens < 1000 ? String(tokens) : (tokens / 1000).toFixed(1) + "k"} tokens`;
    const details: string[] = [];
    if (tokenText !== null) details.push(tokenText);
    if (thinking) details.push("thinking");
    else if (thoughtFor.value !== null) details.push(`thought for ${thoughtFor.value}s`);
    return { verb: parsedVerb, elapsed: elapsed.value, tokens, direction, thinking, thoughtFor: thoughtFor.value, tokenText, details };
  }

  /** The finished line's verb in Claude's past tense ("Brewed for"). */
  export function pastTense(verb: string): string | null { return PAST_TENSES[verb] ?? null; }

  const PAST_TENSES: Record<string, string> = {
    Accomplishing: "Accomplished", Actioning: "Actioned", Actualizing: "Actualized", Baking: "Baked",
    Booping: "Booped", Brewing: "Brewed", Calculating: "Calculated", Cerebrating: "Cerebrated",
    Channelling: "Channelled", Churning: "Churned", Clauding: "Clauded", Coalescing: "Coalesced",
    Cogitating: "Cogitated", Combobulating: "Combobulated", Computing: "Computed", Concocting: "Concocted",
    Conjuring: "Conjured", Considering: "Considered", Contemplating: "Contemplated", Cooking: "Cooked",
    Crafting: "Crafted", Creating: "Created", Crunching: "Crunched", Deciphering: "Deciphered",
    Deliberating: "Deliberated", Determining: "Determined", Discombobulating: "Discombobulated",
    Divining: "Divined", Doing: "Did", Effecting: "Effected", Elucidating: "Elucidated",
    Enchanting: "Enchanted", Envisioning: "Envisioned", Finagling: "Finagled", Flibbertigibbeting: "Flibbertigibbeted",
    Forging: "Forged", Forming: "Formed", Frolicking: "Frolicked", Generating: "Generated",
    Germinating: "Germinated", Hatching: "Hatched", Herding: "Herded", Honking: "Honked",
    Hustling: "Hustled", Ideating: "Ideated", Imagining: "Imagined", Incubating: "Incubated",
    Inferring: "Inferred", Jiving: "Jived", Manifesting: "Manifested", Marinating: "Marinated",
    Meandering: "Meandered", Moseying: "Moseyed", Mulling: "Mulled", Mustering: "Mustered",
    Musing: "Mused", Noodling: "Noodled", Percolating: "Percolated", Perusing: "Perused",
    Philosophising: "Philosophised", Pondering: "Pondered", Pontificating: "Pontificated",
    Precipitating: "Precipitated", Processing: "Processed", Puttering: "Puttered", Puzzling: "Puzzled",
    Reticulating: "Reticulated", Ruminating: "Ruminated", Sautéing: "Sautéed", Schlepping: "Schlepped",
    Shimmying: "Shimmied", Shucking: "Shucked", Simmering: "Simmered", Smooshing: "Smooshed",
    Spelunking: "Spelunked", Spinning: "Spun", Stewing: "Stewed", Sussing: "Sussed",
    Synthesizing: "Synthesized", Thinking: "Thought", Tinkering: "Tinkered", Transmuting: "Transmuted",
    Unfurling: "Unfurled", Unravelling: "Unravelled", Vibing: "Vibed", Wandering: "Wandered",
    Whirlpooling: "Whirlpooled", Whirring: "Whirred", Wibbling: "Wibbled", Wizarding: "Wizarded",
    Working: "Worked", Wrangling: "Wrangled",
  };
}

/** A key the phone may press in an agent's terminal; the Hook accepts exactly this set. */
export type AgentAnswerKeyValue =
  | "Enter" | "Up" | "Down" | "Tab" | "y" | "n" | "Escape"
  | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "p" | "AltUp";

export const AgentAnswerKey = {
  ENTER: "Enter" as AgentAnswerKeyValue, UP: "Up" as AgentAnswerKeyValue, DOWN: "Down" as AgentAnswerKeyValue,
  TAB: "Tab" as AgentAnswerKeyValue, YES: "y" as AgentAnswerKeyValue, NO: "n" as AgentAnswerKeyValue,
  ONE: "1" as AgentAnswerKeyValue, TWO: "2" as AgentAnswerKeyValue, THREE: "3" as AgentAnswerKeyValue,
  ESCAPE: "Escape" as AgentAnswerKeyValue, FOUR: "4" as AgentAnswerKeyValue, FIVE: "5" as AgentAnswerKeyValue,
  SIX: "6" as AgentAnswerKeyValue, SEVEN: "7" as AgentAnswerKeyValue, EIGHT: "8" as AgentAnswerKeyValue,
  NINE: "9" as AgentAnswerKeyValue,
  /** Codex's "yes, and don't ask again for commands that start with …". */
  PROCEED_ALWAYS: "p" as AgentAnswerKeyValue,
  /** Codex's "answer the last queued follow-up". */
  ALT_UP: "AltUp" as AgentAnswerKeyValue,
  /** What the composer row shows, in the order a prompt is usually answered. */
  row: ["y", "n", "Enter", "Up", "Down", "Escape"] as AgentAnswerKeyValue[],
  from(raw: string): AgentAnswerKeyValue | null {
    return AGENT_ANSWER_KEYS.find((candidate) => candidate === raw) ?? null;
  },
  label(key: AgentAnswerKeyValue): string {
    switch (key) {
      case "Enter": return "Enter"; case "Up": return "↑"; case "Down": return "↓"; case "Tab": return "Tab";
      case "y": return "Y"; case "n": return "N"; case "Escape": return "Esc"; case "AltUp": return "⌥↑";
      default: return key;
    }
  },
  spoken(key: AgentAnswerKeyValue): string {
    switch (key) {
      case "Enter": return "Press Enter"; case "Up": return "Move up"; case "Down": return "Move down";
      case "Tab": return "Press Tab"; case "y": return "Answer yes"; case "n": return "Answer no";
      case "Escape": return "Press Escape"; case "AltUp": return "Open the queued question";
      default: return `Press ${key}`;
    }
  },
};

const AGENT_ANSWER_KEYS: AgentAnswerKeyValue[] = [
  "Enter", "Up", "Down", "Tab", "y", "n", "1", "2", "3", "Escape", "4", "5", "6", "7", "8", "9", "p", "AltUp",
];

/** A conductor `dispatch` or `hand_off` the Hook is asking about. */
export interface ConductorCall {
  action: string;
  project: string | null;
  computer: string | null;
}

export type ApprovalDecisionValue = "approve" | "deny" | "allow-project" | "allow-everywhere";

/** The Hook's approval answers. */
export const ApprovalDecision = {
  APPROVE: "approve" as ApprovalDecisionValue,
  DENY: "deny" as ApprovalDecisionValue,
  ALLOW_PROJECT: "allow-project" as ApprovalDecisionValue,
  ALLOW_EVERYWHERE: "allow-everywhere" as ApprovalDecisionValue,
  from(raw: string | null | undefined): ApprovalDecisionValue | null {
    return APPROVAL_DECISIONS.find((candidate) => candidate === raw) ?? null;
  },
  allows(decision: ApprovalDecisionValue): boolean { return decision !== "deny"; },
};

const APPROVAL_DECISIONS: ApprovalDecisionValue[] = ["approve", "deny", "allow-project", "allow-everywhere"];

/** An approval held in the queue that a bulk "Approve all" may answer. */
export interface BulkApprovalItem {
  targetID: string;
  approvalID: string;
  isQuestion: boolean;
  choice: string | null;
}

/**
 * The held permission approvals a bulk "Approve all" may answer: each target
 * and action only once, skipping anything that needs a typed or chosen answer.
 */
export const BulkApproval = {
  id(item: BulkApprovalItem): string { return item.targetID + "/" + item.approvalID; },
  approvable(items: BulkApprovalItem[]): BulkApprovalItem[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      if (item.isQuestion || item.choice !== null) return false;
      const id = BulkApproval.id(item);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  },
};
