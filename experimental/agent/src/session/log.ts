/**
 * Append-only session event log.
 *
 * The log is the source of truth for model-visible history: `deriveMessages`
 * projects the message array the provider sees, and nothing else may invent
 * one ("model-visible means logged"). Pruning/compaction never deletes —
 * a `log/replace` event splices a surface range behind a summary message, so
 * the full record survives for replay, resume, and forking.
 */
import type { LlmMessage } from "../providers/types.js";

/** Bump only when an older reader could misread a newer log. */
export const SESSION_LOG_VERSION = 1;

/** Where a user-role event came from; folded into nothing, kept for audit. */
export type UserEventSource = "user" | "steer" | "system";

export interface SessionLogHeader {
  type: "header";
  version: number;
  sessionId: string;
  project?: string;
  cwd: string;
  createdAt: string;
  /** Session this log was forked/seeded from, if any. */
  parentSession?: string;
  /** Number of leading events inherited from the parent. */
  seedLength?: number;
}

export interface SessionEventMap {
  /** Direct input, steering, or a system-injected prompt (flush, plan gate, continuation). */
  "user/message": { message: LlmMessage; source: UserEventSource; turn: number };
  /** One model response (its content blocks include reasoning/tool_use). */
  "assistant/message": { message: LlmMessage; stop_reason: string; usage?: { input_tokens: number; output_tokens: number }; turn: number };
  /** The user-role message carrying a batch of tool results. */
  "tool/results": { message: LlmMessage; turn: number };
  /**
   * Splice surface events with seqs in [start, end] (inclusive) behind one
   * summary message. The shadowed events stay in the log.
   */
  "log/replace": { start: number; end: number; message: LlmMessage };
}

export type SessionEventType = keyof SessionEventMap;

export interface SessionEvent<T extends SessionEventType = SessionEventType> {
  seq: number;
  time: string;
  type: T;
  data: SessionEventMap[T];
  /**
   * A reader that does not recognize `type` may skip an event carrying
   * ignorable: true; an unrecognized event without it must refuse the log
   * (silently dropping required context would misread the session).
   */
  ignorable?: boolean;
}

const KNOWN_EVENT_TYPES = new Set<string>(["user/message", "assistant/message", "tool/results", "log/replace"]);

/** Message-producing event types (the surface fold's inputs). */
const SURFACE_TYPES = new Set<string>(["user/message", "assistant/message", "tool/results"]);

interface SurfaceNode {
  seq: number;
  message: LlmMessage;
}

/** Recursively freeze event data so history cannot be edited in place. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Fold events into the model-visible surface (seq + message per node).
 * Pure — shared by the live cache, resume, and tests.
 */
export function deriveSurface(events: readonly SessionEvent[]): SurfaceNode[] {
  const surface: SurfaceNode[] = [];
  for (const event of events) {
    if (SURFACE_TYPES.has(event.type)) {
      const data = event.data as { message: LlmMessage };
      surface.push({ seq: event.seq, message: data.message });
    } else if (event.type === "log/replace") {
      const { start, end, message } = event.data as SessionEventMap["log/replace"];
      const from = surface.findIndex((n) => n.seq >= start);
      if (from === -1) {
        surface.push({ seq: event.seq, message });
        continue;
      }
      let to = from;
      while (to < surface.length && surface[to].seq <= end) to++;
      surface.splice(from, to - from, { seq: event.seq, message });
    }
  }
  return surface;
}

/** Fold events into the model-visible message array. */
export function deriveMessages(events: readonly SessionEvent[]): LlmMessage[] {
  return deriveSurface(events).map((n) => n.message);
}

/** Validation failure loading a persisted log. */
export class SessionLogError extends Error {}

/**
 * Validate a parsed event array: contiguous seqs from 0 and no unknown
 * non-ignorable types. Fail closed — a log we cannot fully interpret would
 * silently reconstruct wrong history.
 */
export function validateEvents(events: readonly SessionEvent[]): void {
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.seq !== i) {
      throw new SessionLogError(`event log seq gap: expected ${i}, found ${event.seq}`);
    }
    if (!KNOWN_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
      throw new SessionLogError(
        `unknown session event type "${event.type}" without ignorable: true — refusing to reconstruct`,
      );
    }
  }
}

/** Receives each appended line (header first) for durable storage. */
export type SessionLogSink = (line: string) => void;

/**
 * The live log: append events, read the derived message projection.
 * Persistence is a caller-supplied sink so the loop stays storage-free.
 */
export class SessionLog {
  readonly header: SessionLogHeader;
  private events: SessionEvent[] = [];
  private sink?: SessionLogSink;
  private surface: SurfaceNode[] = [];
  private derivedAt = -1;
  private replaceGeneration = 0;
  private derivedGeneration = -1;

  constructor(header: Omit<SessionLogHeader, "type" | "version">, sink?: SessionLogSink) {
    this.header = { type: "header", version: SESSION_LOG_VERSION, ...header };
    this.sink = sink;
    this.sink?.(JSON.stringify(this.header));
  }

  /** Rebuild a log from persisted events (already validated). */
  static restore(header: SessionLogHeader, events: SessionEvent[], sink?: SessionLogSink): SessionLog {
    validateEvents(events);
    if (header.version !== SESSION_LOG_VERSION) {
      throw new SessionLogError(`unsupported session log version ${header.version}`);
    }
    const log = Object.create(SessionLog.prototype) as SessionLog;
    Object.assign(log, {
      header,
      events: events.map((e) => deepFreeze(e)),
      sink,
      surface: [],
      derivedAt: -1,
      replaceGeneration: events.filter((e) => e.type === "log/replace").length,
      derivedGeneration: -1,
    });
    return log;
  }

  get length(): number {
    return this.events.length;
  }

  /** Read-only view of the raw events. */
  get all(): readonly SessionEvent[] {
    return this.events;
  }

  append<T extends SessionEventType>(type: T, data: SessionEventMap[T]): SessionEvent<T> {
    const event: SessionEvent<T> = {
      seq: this.events.length,
      time: new Date().toISOString(),
      type,
      data,
    };
    // Frozen at commit: history edits must go through append (a log/replace),
    // never in-place mutation of an already-logged message.
    deepFreeze(event);
    this.events.push(event as SessionEvent);
    if (type === "log/replace") this.replaceGeneration++;
    this.sink?.(JSON.stringify(event));
    return event;
  }

  private refreshSurface(): void {
    if (this.derivedGeneration !== this.replaceGeneration) {
      this.surface = deriveSurface(this.events);
      this.derivedAt = this.events.length;
      this.derivedGeneration = this.replaceGeneration;
      return;
    }
    if (this.derivedAt < this.events.length) {
      for (let i = this.derivedAt; i < this.events.length; i++) {
        const event = this.events[i];
        if (SURFACE_TYPES.has(event.type)) {
          this.surface.push({ seq: event.seq, message: (event.data as { message: LlmMessage }).message });
        }
      }
      this.derivedAt = this.events.length;
    }
  }

  /** The model-visible message projection, incrementally cached. */
  getMessages(): LlmMessage[] {
    this.refreshSurface();
    return this.surface.map((n) => n.message);
  }

  /**
   * Replace the surface range [startIndex, endIndex] (message-array indices,
   * inclusive) with one summary message, as a durable log/replace event.
   */
  replaceMessageRange(startIndex: number, endIndex: number, message: LlmMessage): SessionEvent<"log/replace"> {
    this.refreshSurface();
    const start = this.surface[startIndex]?.seq;
    const end = this.surface[endIndex]?.seq;
    if (start === undefined || end === undefined || start > end) {
      throw new SessionLogError(
        `replace range [${startIndex}, ${endIndex}] outside surface (length ${this.surface.length})`,
      );
    }
    return this.append("log/replace", { start, end, message });
  }

  /**
   * Assert the cached projection still equals a fresh derivation from the
   * log — the "model-visible means logged" guarantee, run before every
   * provider request. Catches any code path that swapped or reordered the
   * projection without going through append().
   */
  assertReconstructs(): void {
    const fresh = deriveMessages(this.events);
    const cached = this.getMessages();
    if (JSON.stringify(cached) !== JSON.stringify(fresh)) {
      throw new SessionLogError(
        "session projection diverged from the event log (history was mutated outside the log)",
      );
    }
  }
}

/**
 * Seed a log from a plain message array (legacy v1 snapshot resume). Roles
 * are classified into event types; unknown roles are dropped with a warning
 * rather than corrupting the log.
 */
export function seedFromMessages(log: SessionLog, messages: LlmMessage[]): void {
  for (const message of messages) {
    if (message.role === "assistant") {
      log.append("assistant/message", { message, stop_reason: "end_turn", turn: 0 });
    } else if (message.role === "user") {
      const isToolResults =
        Array.isArray(message.content) &&
        message.content.length > 0 &&
        message.content.every((b) => b.type === "tool_result" || b.type === "text");
      if (isToolResults && Array.isArray(message.content) && message.content.some((b) => b.type === "tool_result")) {
        log.append("tool/results", { message, turn: 0 });
      } else {
        log.append("user/message", { message, source: "user", turn: 0 });
      }
    } else {
      process.stderr.write(`[session] dropping message with unknown role during seed: ${String((message as { role?: unknown }).role)}\n`);
    }
  }
}

/**
 * Fork: the events up to and including `atSeq` become a new session's seed.
 * @returns header + events for the child (caller persists them).
 */
export function forkSessionEvents(
  parent: SessionLog,
  atSeq: number,
  childSessionId: string,
): { header: SessionLogHeader; events: SessionEvent[] } {
  if (atSeq < -1 || atSeq >= parent.length) {
    throw new SessionLogError(`fork boundary ${atSeq} outside log (length ${parent.length})`);
  }
  const events = parent.all.slice(0, atSeq + 1).map((e) => ({ ...e }));
  return {
    header: {
      ...parent.header,
      sessionId: childSessionId,
      createdAt: new Date().toISOString(),
      parentSession: parent.header.sessionId,
      seedLength: events.length,
    },
    events,
  };
}
