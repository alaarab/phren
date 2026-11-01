// One answer to "whose input is this?", shared by the Claude transcript
// normalizer, the lifecycle callbacks, the reply preview and the raw final-turn
// accounting. A background task's notification, a teammate's message or a
// harness envelope belongs to the turn already running: it must never be
// mistaken for the owner asking something new.
//
// The classification is deliberately built from enumerated provenance and
// leading envelopes, never from "has an origin object" or from any mention of
// a tag in ordinary prose. Only public facts cross: no task output, no system
// payload, and no prompt text is kept here.

/** Whose input a Claude row or callback is. */
export type InputCategory = "owner" | "notification" | "internal";

/** A category and a short, payload-free reason for it. */
export interface InputClassification {
  category: InputCategory;
  reason: string;
}

/** The provenances this Hook understands. Anything else is not automatic. */
const NOTIFICATION_ORIGINS = new Set(["task-notification", "teammate-message"]);
const INTERNAL_ORIGINS = new Set(["auto-continuation", "scheduled"]);

/** The facts a caller can supply. Absent facts are simply not evidence. */
export interface InputFacts {
  text?: unknown;
  hasImage?: boolean;
  origin?: unknown;
  commandMode?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  isCompactSummary?: unknown;
  /** The row's user content is only tool_result blocks. */
  toolResult?: unknown;
  /** The input arrived through the harness's notification delivery path
   * (Claude's queued_command attachment, for example). */
  notificationDelivery?: unknown;
}

const MONITOR_NOTICE = /^(?:[⏺●]\s*)?Monitor event\b/;

/** A leading Claude envelope that says the input is the harness's own. Self-contained: hook-fast.ts
 * embeds this function into the small forwarder, so it must not read module scope. */
export function classifyClaudePromptText(text: unknown): InputClassification {
  const value = typeof text === "string" ? text.trimStart().slice(0, 65_536) : "";
  if (!value) return { category: "internal", reason: "text:empty" };
  if (value.startsWith("<task-notification>")) return { category: "notification", reason: "envelope:task-notification" };
  if (value.startsWith("<system-reminder>") && value.includes("<task-notification>")) return { category: "notification", reason: "envelope:system-reminder" };
  if (value.startsWith("[SYSTEM NOTIFICATION - NOT USER INPUT]")) return { category: "notification", reason: "preamble:system-notification" };
  if (value.startsWith("<teammate-message")) return { category: "notification", reason: "envelope:teammate-message" };
  if (/^<(?:environment_context>|user_instructions>|permission_profile|system-reminder>|turn_context>)/.test(value)) return { category: "internal", reason: "text:harness-preamble" };
  return { category: "owner", reason: "text:owner-prompt" };
}

/** Classify a Claude input from every fact a caller has. Provenance comes first, then row shape,
 * then the leading text; ordinary prose that happens to name a tag stays the owner's. */
export function classifyClaudeInput(facts: InputFacts): InputClassification {
  const origin = facts.origin && typeof facts.origin === "object" && !Array.isArray(facts.origin)
    ? facts.origin as Record<string, unknown> : undefined;
  const kind = origin && typeof origin.kind === "string" ? origin.kind : undefined;
  if (kind && NOTIFICATION_ORIGINS.has(kind)) return { category: "notification", reason: `origin:${kind}` };
  if (kind && INTERNAL_ORIGINS.has(kind)) return { category: "internal", reason: `origin:${kind}` };
  if (facts.commandMode === "task-notification") return { category: "notification", reason: "delivery:task-notification" };
  const text = typeof facts.text === "string" ? facts.text : "";
  // A Monitor notice is automatic only when it came through the notification
  // delivery path; the same words typed by the owner are an ordinary prompt.
  if (facts.notificationDelivery === true && MONITOR_NOTICE.test(text.trimStart())) {
    return { category: "notification", reason: "delivery:monitor-notice" };
  }
  // An established notification envelope precedes the row's hidden/meta shape:
  // Claude sometimes files a task notification as a hidden user row.
  const leading = classifyClaudePromptText(text);
  if (leading.category === "notification") return leading;
  if (facts.toolResult === true) return { category: "internal", reason: "row:tool-result" };
  if (facts.isSidechain === true) return { category: "internal", reason: "row:sidechain" };
  if (facts.isMeta === true) return { category: "internal", reason: "row:meta" };
  if (facts.isCompactSummary === true) return { category: "internal", reason: "row:compact-summary" };
  if (facts.hasImage && leading.reason === "text:empty") return { category: "owner", reason: "row:image" };
  return leading;
}

/** The validated category a callback may carry, or undefined for anything else. */
export function parseInputCategory(value: unknown): InputCategory | undefined {
  return value === "owner" || value === "notification" || value === "internal" ? value : undefined;
}

/** Bounded payload facts shared by the generated and full forwarders. Keep
 * self-contained: the fast script embeds it without importing the bundle. */
export function claudeCallbackFacts(value: Record<string, unknown>): Record<string, unknown> {
  const origin = value.origin && typeof value.origin === "object" ? value.origin as Record<string, unknown> : {};
  const execution = value.execution_id ?? value.executionId;
  return {
    ...(typeof execution === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(execution) ? { executionId: execution } : {}),
    ...(typeof origin.kind === "string" ? { origin: { kind: origin.kind.slice(0, 80) } } : {}),
    ...(typeof value.commandMode === "string" ? { commandMode: value.commandMode.slice(0, 80) } : {}),
    ...Object.fromEntries(["isMeta", "isCompactSummary", "notificationDelivery", "toolResult", "hasImage"].filter(key => value[key] === true).map(key => [key, true])),
    ...(Array.isArray(value.content) && value.content.some(block => block && typeof block === "object" && (block as Record<string, unknown>).type === "image") ? { hasImage: true } : {}),
  };
}
