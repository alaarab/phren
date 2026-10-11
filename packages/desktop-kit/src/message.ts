// The shared contract every kit module builds on: one visible row of an
// agent conversation, normalized from any harness's transcript. Ported from
// the phone's AgentChatMessage (Android phrenkit AgentChat.kt, iOS
// PhrenKit AgentChat.swift); field names follow the Kotlin.

export type ChatRole = "user" | "assistant" | "tool";

/** An image inside a tool result, as the Hook's /v1/transcripts/blob route addresses it. */
export interface ImageRef { block: number; inner: number | null }

export interface ChatMessage {
  /** Stable per row: `<line>` or `<line>:<block>` as the harness readers build it. */
  id: string;
  /** The transcript line this row came from (the Hook's `line`). */
  line: number;
  role: ChatRole;
  /**
   * For tool rows: the tool's name ("Bash", "apply_patch", "mcp__phren__add_finding"),
   * or one of the fixed titles "Tool result", "Changes", "Conversation compacted".
   * For user/assistant rows usually null.
   */
  title: string | null;
  /** Text, or for a tool call its JSON-encoded input. */
  text: string;
  imageBlocks: number[];
  resultImages: ImageRef[];
  /** Pictures the phone sent that Claude Code recorded only by path; stripped from `text`. */
  uploadImages: string[];
  /** Links a tool call and its result. */
  toolCallID: string | null;
  /** ISO 8601, when the transcript row had one. */
  timestamp: string | null;
  wasQueued: boolean;
  isQueued: boolean;
  queueKey: string | null;
  /** A prompt the agent's own schedule, loop or auto-continuation injected. */
  isScheduled: boolean;
  isToolError: boolean;
  /** Narration between tool calls: progress notes, not the reply. */
  isNarration: boolean;
  /** What phren's prompt hook injected into the turn, shown folded under it. */
  isHookContext: boolean;
}

/** A new message with every optional field defaulted. */
export function chatMessage(fields: Pick<ChatMessage, "id" | "line" | "role" | "text"> & Partial<ChatMessage>): ChatMessage {
  return {
    title: null, imageBlocks: [], resultImages: [], uploadImages: [], toolCallID: null, timestamp: null,
    wasQueued: false, isQueued: false, queueKey: null, isScheduled: false, isToolError: false,
    isNarration: false, isHookContext: false, ...fields,
  };
}

/** Includes content, so an edited row of the same length invalidates caches. */
export function renderKey(m: ChatMessage): string {
  return `${m.id}|${m.role}|${m.title ?? ""}|${m.text.length}|${hash(m.text)}${m.uploadImages.length ? `|u${m.uploadImages.length}` : ""}`;
}

export const isToolResult = (m: ChatMessage): boolean => m.role === "tool" && m.title === "Tool result";
/** A file a shell call changed, attached by the Hook. */
export const isChange = (m: ChatMessage): boolean => m.role === "tool" && m.title === "Changes";
export const isCompaction = (m: ChatMessage): boolean => m.role === "tool" && m.title === "Conversation compacted";

/** 32-bit FNV-1a, enough to tell edited rows apart in a cache key. */
export function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}
