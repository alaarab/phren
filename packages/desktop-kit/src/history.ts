// Merges reconnect snapshots, live appends and older pages by absolute line
// (the phone's AgentChatHistory.kt): one contiguous, pageable window with
// queued prompts and scheduled turns reconciled as frames arrive.

import type { QueueConsumption, TranscriptFrame, TranscriptMessage } from "./transcript.js";
import { copyMessage, utf8Length } from "./transcript.js";

interface RetiredQueue { id: string; line: number; key: string }
interface ProgressMark { line: number; finished: boolean }

/** Geometry deciding whether a followed transcript needs to move (ChatScrollMetrics). */
export class ChatScrollMetrics {
  contentHeight: number;
  viewportHeight: number;
  offsetY: number;

  constructor(contentHeight: number, viewportHeight: number, offsetY: number) {
    this.contentHeight = contentHeight;
    this.viewportHeight = viewportHeight;
    this.offsetY = offsetY;
  }

  /** The largest valid offset; insets change the viewport, not the transcript's end. */
  get bottomOffset(): number { return Math.max(0, this.contentHeight - this.viewportHeight); }
  get distanceFromBottom(): number { return this.bottomOffset - this.offsetY; }

  static correctiveOffset(metrics: ChatScrollMetrics): number | null {
    return metrics.viewportHeight > 0.5 && metrics.offsetY > metrics.bottomOffset + 0.5 ? metrics.bottomOffset : null;
  }
  static clamp(target: number, metrics: ChatScrollMetrics): number {
    return Math.max(0, Math.min(target, metrics.bottomOffset));
  }
  /** A content height that jumped far past the viewport at once: a lazy stack's estimate. */
  static isEstimateJump(oldMetrics: ChatScrollMetrics, newMetrics: ChatScrollMetrics): boolean {
    return newMetrics.viewportHeight > 0.5 && newMetrics.contentHeight - oldMetrics.contentHeight > 3 * newMetrics.viewportHeight;
  }
  /** Re-pin for transcript growth or an already invalid offset; a viewport-only change doesn't. */
  static shouldRepin(oldMetrics: ChatScrollMetrics, newMetrics: ChatScrollMetrics, userDriven: boolean): number | null {
    const grew = newMetrics.contentHeight > oldMetrics.contentHeight + 0.5;
    const past = newMetrics.offsetY > newMetrics.bottomOffset + 0.5;
    if (userDriven || newMetrics.contentHeight <= newMetrics.viewportHeight + 0.5 || !(grew || past)) return null;
    return newMetrics.bottomOffset;
  }
  /** Where, as a fraction of the viewport from its top, a reply read aloud begins when it lands. */
  static readonly READING_LINE = 0.4;
  /** [shouldRepin] while talk mode reads the reply: growth follows only to the reading line. */
  static revealTarget(oldMetrics: ChatScrollMetrics, newMetrics: ChatScrollMetrics, userDriven: boolean): number | null {
    const bottom = ChatScrollMetrics.shouldRepin(oldMetrics, newMetrics, userDriven);
    if (bottom === null) return null;
    if (newMetrics.offsetY > newMetrics.bottomOffset + 0.5) return bottom;
    const start = oldMetrics.contentHeight - newMetrics.viewportHeight * ChatScrollMetrics.READING_LINE;
    return Math.min(bottom, Math.max(newMetrics.offsetY, start));
  }
}

const IMAGE_MARKER = /\[Image #\p{Nd}+\]|\[Image attachment\]/gu;
const WHITESPACE = /[\p{Z}\t\n\r\u000B\u000C\u0085]+/u;
const FOOTER = "Attached files on this computer:";

/** Queued-prompt text handling: normalization for pairing a pending row with its real turn. */
export const AgentQueuedMessages = {
  /** The instruction, without Claude's pasted-image labels and attachment footer. */
  normalizedText(text: string): string {
    let value = text.replace(IMAGE_MARKER, "");
    for (;;) {
      const footer = value.indexOf(FOOTER);
      if (footer < 0) break;
      let rest = value.slice(footer + FOOTER.length);
      for (;;) {
        let first = -1;
        for (let i = 0; i < rest.length; i++) { const c = rest[i]; if (c !== "\n" && c !== "\r" && c !== " " && c !== "\t" && c !== "\u000B" && c !== "\u000C" && c !== "\u0085") { first = i; break; } }
        if (first < 0) break;
        const line = rest.slice(first);
        if (!(line.startsWith("/") || line.startsWith("~/"))) break;
        let nl = -1;
        for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === "\n" || c === "\r" || c === " " || c === "\t" || c === "\u000B" || c === "\u000C" || c === "\u0085") { nl = i; break; } }
        rest = nl >= 0 ? line.slice(nl) : "";
      }
      value = `${value.slice(0, footer)}\n${rest}`;
    }
    return value.split(WHITESPACE).filter(part => part.length > 0).join(" ");
  },

  /** Pairs one real turn with one earlier queue row, preferring its key; text fallback only within the page. */
  replacements(messages: TranscriptMessage[], pageIDs: Set<string>, acknowledgedRealIDs: Set<string>): Map<string, string> {
    const pending: TranscriptMessage[] = [];
    const normalized = new Map<string, string>();
    const replaced = new Map<string, string>();
    for (const message of messages) {
      if (message.role !== "user" || message.localCommand !== null) continue;
      if (message.wasQueued) {
        pending.push(message);
        if (pageIDs.has(message.id)) normalized.set(message.id, AgentQueuedMessages.normalizedText(message.text));
        continue;
      }
      if (pending.length === 0 || acknowledgedRealIDs.has(message.id)) continue;
      let index: number | null = null;
      if (message.queueKey !== null) { const found = pending.findIndex(q => q.queueKey === message.queueKey); if (found >= 0) index = found; }
      if (index === null && pageIDs.has(message.id)) {
        const text = AgentQueuedMessages.normalizedText(message.text);
        if (text.length > 0) {
          const found = pending.findIndex(q => (message.queueKey === null || q.queueKey === null) && normalized.get(q.id) === text);
          if (found >= 0) index = found;
        }
      }
      if (index !== null) replaced.set(pending.splice(index, 1)[0].id, message.id);
    }
    return replaced;
  },
};

function eventKey(event: QueueConsumption): string {
  return `${event.line}\0${event.key}\0${event.scheduled}\0${event.returned}`;
}

/**
 * Merges reconnect snapshots, live appends and older pages by absolute line.
 * `copy()` gives an independent history; messages are never mutated in place.
 */
export class AgentChatHistory {
  messages: TranscriptMessage[] = [];
  startLine: number | null = null;
  totalLines = 0;
  hasMore = false;
  hasNewer = false;
  private consumedQueueEvents = new Map<string, QueueConsumption>();
  private assignedQueueEvents = new Set<string>();
  private consumedQueueMessages = new Set<string>();
  private replacedQueueMessages = new Map<string, string>();
  private retiredQueue: RetiredQueue[] = [];
  private acknowledgementIDs = new Map<string, string>();
  private progressMarks: ProgressMark[] = [];
  private scheduledQueueMessages = new Set<string>();

  copy(): AgentChatHistory {
    const clone = new AgentChatHistory();
    clone.messages = [...this.messages];
    clone.startLine = this.startLine;
    clone.totalLines = this.totalLines;
    clone.hasMore = this.hasMore;
    clone.hasNewer = this.hasNewer;
    clone.consumedQueueEvents = new Map(this.consumedQueueEvents);
    clone.assignedQueueEvents = new Set(this.assignedQueueEvents);
    clone.consumedQueueMessages = new Set(this.consumedQueueMessages);
    clone.replacedQueueMessages = new Map(this.replacedQueueMessages);
    clone.retiredQueue = this.retiredQueue.map(entry => ({ ...entry }));
    clone.acknowledgementIDs = new Map(this.acknowledgementIDs);
    clone.progressMarks = this.progressMarks.map(mark => ({ ...mark }));
    clone.scheduledQueueMessages = new Set(this.scheduledQueueMessages);
    return clone;
  }

  equals(other: AgentChatHistory): boolean {
    return JSON.stringify(this.messages) === JSON.stringify(other.messages) && this.startLine === other.startLine
      && this.totalLines === other.totalLines && this.hasMore === other.hasMore && this.hasNewer === other.hasNewer
      && sameMap(this.consumedQueueEvents, other.consumedQueueEvents) && sameSet(this.assignedQueueEvents, other.assignedQueueEvents)
      && sameSet(this.consumedQueueMessages, other.consumedQueueMessages) && sameMap(this.replacedQueueMessages, other.replacedQueueMessages)
      && JSON.stringify(this.retiredQueue) === JSON.stringify(other.retiredQueue) && sameMap(this.acknowledgementIDs, other.acknowledgementIDs)
      && JSON.stringify(this.progressMarks) === JSON.stringify(other.progressMarks) && sameSet(this.scheduledQueueMessages, other.scheduledQueueMessages);
  }

  acknowledgementID(messageID: string): string {
    return this.acknowledgementIDs.get(messageID) ?? messageID;
  }

  receive(frame: TranscriptFrame): void {
    if (frame.kind === "preview") return;
    // Only a backlog (a first page, resume or reconnect) can prove that a
    // newer page is disjoint from the retained window. An append continues the
    // Hook's own reader and may start past totalLines after invisible rows.
    const disjointNewerPage = !this.hasNewer && this.messages.length > 0 && frame.kind === "backlog"
      && frame.totalLines > this.totalLines && (frame.startLine ?? 0) > this.totalLines;
    if ((frame.replacesConversation && frame.kind !== "older") || disjointNewerPage) {
      this.messages = []; this.startLine = null; this.totalLines = 0; this.hasMore = false; this.hasNewer = false;
      this.consumedQueueEvents = new Map(); this.assignedQueueEvents = new Set(); this.consumedQueueMessages = new Set();
      this.replacedQueueMessages = new Map(); this.retiredQueue = []; this.acknowledgementIDs = new Map();
      this.progressMarks = []; this.scheduledQueueMessages = new Set();
    }
    if (frame.progressEvents.length > 0) {
      const marks = new Map<string, ProgressMark>();
      for (const mark of this.progressMarks) marks.set(`${mark.line}\0${mark.finished}`, mark);
      for (const event of frame.progressEvents) {
        if (event.value.kind === "started") marks.set(`${event.line}\0false`, { line: event.line, finished: false });
        else if (event.value.kind === "finished") marks.set(`${event.line}\0true`, { line: event.line, finished: true });
      }
      this.progressMarks = [...marks.values()].sort((a, b) => a.line - b.line || Number(a.finished) - Number(b.finished)).slice(-4_000);
    }
    const merged = new Map<string, TranscriptMessage>();
    for (const m of this.messages) merged.set(m.id, m);
    for (const message of frame.messages) {
      if (this.replacedQueueMessages.has(message.id)) continue;
      // Browsing beyond the live window: incoming output must not evict older messages.
      if (!this.hasNewer || frame.kind === "older" || merged.has(message.id)) merged.set(message.id, message);
    }
    let list = [...merged.values()].sort((a, b) => a.line - b.line || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const event of frame.queueEvents) this.consumedQueueEvents.set(eventKey(event), event);
    const consumedMessages = new Set(this.consumedQueueMessages);
    const assigned = new Set(this.assignedQueueEvents);
    const scheduled = new Set(this.scheduledQueueMessages);
    // Repeated real turns are legitimate. Only pair pending handoffs.
    for (let i = 0; i < list.length; i++) {
      if (list[i].wasQueued) list[i] = copyMessage(list[i], { isQueued: !consumedMessages.has(list[i].id), isScheduled: this.scheduledQueueMessages.has(list[i].id) });
    }
    for (const event of [...this.consumedQueueEvents.values()].sort((a, b) => a.line - b.line)) {
      const key = eventKey(event);
      if (assigned.has(key)) continue;
      if (event.returned) {
        const index = list.findIndex(m => m.wasQueued && m.queueKey === event.key && m.line < event.line);
        if (index >= 0 && !this.replacedQueueMessages.has(list[index].id)) { consumedMessages.add(list[index].id); list.splice(index, 1); }
        else { const retired = this.retiredQueue.find(r => r.key === event.key && r.line < event.line); if (retired !== undefined) consumedMessages.add(retired.id); }
        continue;
      }
      const index = list.findIndex(m => m.isQueued && m.queueKey === event.key && m.line < event.line);
      const retired = this.retiredQueue.find(r => r.key === event.key && r.line < event.line && !consumedMessages.has(r.id));
      if (retired !== undefined && retired.line < (index >= 0 ? list[index].line : Number.MAX_SAFE_INTEGER)) {
        assigned.add(key); consumedMessages.add(retired.id); if (event.scheduled) scheduled.add(retired.id);
      } else if (index >= 0) {
        list[index] = copyMessage(list[index], { isQueued: false });
        assigned.add(key); consumedMessages.add(list[index].id);
        list[index] = copyMessage(list[index], { isScheduled: event.scheduled });
        if (event.scheduled) scheduled.add(list[index].id); else scheduled.delete(list[index].id);
      } else {
        const earlier = list.findIndex(m => m.wasQueued && m.queueKey === event.key && m.line < event.line);
        if (earlier >= 0) {
          assigned.add(key);
          list[earlier] = copyMessage(list[earlier], { isScheduled: event.scheduled });
          if (event.scheduled) scheduled.add(list[earlier].id); else scheduled.delete(list[earlier].id);
        }
      }
    }
    const pageIDs = new Set((frame.kind === "append" ? list : frame.messages).map(m => m.id));
    const replacements = AgentQueuedMessages.replacements(list, pageIDs, new Set(this.acknowledgementIDs.keys()));
    for (const [pendingID, realID] of replacements) this.replacedQueueMessages.set(pendingID, realID);
    const acks = new Map(this.acknowledgementIDs);
    const retiredList = [...this.retiredQueue];
    for (const message of list) {
      const realID = replacements.get(message.id);
      if (realID === undefined) continue;
      acks.set(realID, message.id);
      if (message.queueKey !== null) retiredList.push({ id: message.id, line: message.line, key: message.queueKey });
    }
    retiredList.sort((a, b) => a.line - b.line);
    // Older Hooks cannot identify removals: stop drawing an unkeyed row as pending after the next real turn.
    let hasRealTurn = false;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.role === "user" && !m.wasQueued && m.localCommand === null) hasRealTurn = true;
      if (hasRealTurn && m.wasQueued && m.queueKey === null) { list[i] = copyMessage(m, { isQueued: false }); consumedMessages.add(m.id); }
    }
    if (frame.source === "claude") this.consumeQueuedByTurn(list, consumedMessages, scheduled);
    this.scheduledQueueMessages = scheduled;
    list = list.filter(m => !this.replacedQueueMessages.has(m.id));
    this.acknowledgementIDs = acks;
    this.retiredQueue = retiredList;
    if (this.replacedQueueMessages.size > 4_000) {
      const retained = new Set(list.map(m => m.id));
      this.replacedQueueMessages = new Map([...this.replacedQueueMessages].filter(([, v]) => retained.has(v)));
      this.acknowledgementIDs = new Map([...this.acknowledgementIDs].filter(([k]) => retained.has(k)));
      this.retiredQueue = this.retiredQueue.slice(-4_000);
    }
    if (this.scheduledQueueMessages.size > 4_000) {
      const ids = new Set(list.map(m => m.id));
      this.scheduledQueueMessages = new Set([...this.scheduledQueueMessages].filter(id => ids.has(id)));
    }
    // An older page's totalLines is the Hook's view of that range, never the resume cursor.
    if (frame.kind !== "older") this.totalLines = Math.max(this.totalLines, frame.totalLines);
    const placeholder = frame.reset && frame.totalLines === 0 && frame.messages.length === 0;
    const start = frame.startLine;
    if (!placeholder && (frame.kind !== "append" || disjointNewerPage) && start !== null && start <= (this.startLine ?? Number.MAX_SAFE_INTEGER)) {
      this.startLine = start; this.hasMore = frame.hasMore;
    }
    if (frame.kind === "older" && !frame.hasMore) this.hasMore = false;
    this.assignedQueueEvents = assigned;
    this.consumedQueueMessages = consumedMessages;
    if (this.consumedQueueEvents.size > 4_000) {
      const kept = new Map([...this.consumedQueueEvents].sort((a, b) => b[1].line - a[1].line).slice(0, 4_000));
      this.consumedQueueEvents = kept;
      const keys = new Set(kept.keys());
      this.assignedQueueEvents = new Set([...this.assignedQueueEvents].filter(k => keys.has(k)));
      const ids = new Set([...list.map(m => m.id), ...this.retiredQueue.map(r => r.id)]);
      this.consumedQueueMessages = new Set([...this.consumedQueueMessages].filter(id => ids.has(id)));
    }
    let bytes = 0, keep = 0;
    const retainOlder = frame.kind === "older" || this.hasNewer;
    for (const m of (retainOlder ? list : [...list].reverse())) {
      bytes += utf8Length(m.text);
      if (bytes > 12 * 1_024 * 1_024 || keep >= 4_000) break;
      keep++;
    }
    if (keep < list.length) {
      if (retainOlder) { this.hasNewer = true; this.messages = list.slice(0, keep); }
      else {
        const kept = list.slice(list.length - keep);
        this.startLine = kept.length > 0 ? kept[0].line : null;
        this.hasMore = (this.startLine ?? 0) > 0;
        this.messages = kept;
      }
    } else {
      this.messages = list;
    }
  }

  /**
   * A keyed queued prompt whose turn has run and that nothing else claimed was
   * injected by the agent itself. Claude frames only; other harnesses report
   * their own consumption.
   */
  private consumeQueuedByTurn(list: TranscriptMessage[], consumed: Set<string>, scheduled: Set<string>): void {
    const outputLines = list.filter(m => m.role === "assistant" && !m.isHookContext).map(m => m.line);
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m.isQueued || m.queueKey === null || this.replacedQueueMessages.has(m.id)) continue;
      const previous = [...this.progressMarks].reverse().find(mark => mark.line < m.line);
      const running = (previous !== undefined && !previous.finished)
        || outputLines.some(line => line > (previous?.line ?? -1) && line < m.line);
      let after = m.line;
      if (running) {
        const finished = this.progressMarks.find(mark => mark.finished && mark.line > m.line);
        if (finished === undefined) continue;
        after = finished.line;
      }
      if (!outputLines.some(line => line > after)) continue;
      list[i] = copyMessage(m, { isQueued: false, isScheduled: true });
      consumed.add(m.id);
      scheduled.add(m.id);
    }
  }
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
}
function sameMap<V>(left: Map<string, V>, right: Map<string, V>): boolean {
  return left.size === right.size && [...left].every(([key, value]) => JSON.stringify(right.get(key)) === JSON.stringify(value));
}
