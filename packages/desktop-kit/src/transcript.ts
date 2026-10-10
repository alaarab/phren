// The transcript reader: raw Hook rows for every harness into ChatMessage[],
// ported from the phone's AgentChat.kt. Pure: JSON in, values out, no DOM and
// no Node APIs, so it runs in the desktop UI and the daemon alike.

import type { ChatMessage, ChatRole, ImageRef } from "./message.js";

export type ChatSource = "codex" | "claude" | "copilot" | "phren" | "opencode";

export const CHAT_SOURCES: ChatSource[] = ["codex", "claude", "copilot", "phren", "opencode"];

/** One raw transcript row as the Hook sends it. */
export interface TranscriptRow {
  line: number;
  raw: unknown;
}

export type TranscriptKind = "backlog" | "append" | "older" | "preview" | "side-answer" | "delivery";

const TRANSCRIPT_KINDS: TranscriptKind[] = ["backlog", "append", "older", "preview", "side-answer", "delivery"];

/** A slash command or `!` shell line typed at Claude Code's own prompt. */
export interface LocalCommand {
  kind: "command" | "shell" | "output";
  text: string;
}

/** The model and branch the newest transcript rows report (AgentSessionContext). */
export interface AgentSettingsState {
  fast: boolean | null;
  permissionMode: string | null;
}

export interface SessionContext {
  modelName: string | null;
  branch: string | null;
  line: number;
  effort: string | null;
  settings: AgentSettingsState;
  replacesPermissionMode: boolean;
}

/** A queued prompt the agent's own schedule/loop/auto-continuation fired or pulled back. */
export interface QueueConsumption {
  line: number;
  key: string;
  scheduled: boolean;
  returned: boolean;
}

export interface ProgressValue {
  kind: "started" | "finished" | "usage";
  input?: number;
  output?: number;
  cachedInput?: number | null;
}

export interface ProgressEvent {
  line: number;
  value: ProgressValue;
  timestamp: string | null;
}

/** An agent's own dialog event; the reader leaves this to a later module. */
export interface QuestionEvent {
  line: number;
}

export interface ChatPreview {
  turnStartedAt: string;
  text: string;
  streamed: boolean;
}

/**
 * A TranscriptMessage is a ChatMessage plus two things the base contract keeps
 * as functions instead of fields: the prompt-command decode the phone stores
 * beside each row, and the row-kind predicates its readers and history use.
 */
export interface TranscriptMessage extends ChatMessage {
  localCommand: LocalCommand | null;
  isToolResult: boolean;
  isChange: boolean;
  isCompaction: boolean;
}

export interface TranscriptRead {
  messages: TranscriptMessage[];
  context: SessionContext;
  questionEvents: QuestionEvent[];
  progressEvents: ProgressEvent[];
  queueEvents: QueueConsumption[];
}

export interface ReadOptions {
  sidechain?: boolean;
}

export interface ReadFrameOptions extends ReadOptions {
  session?: string;
}

/** One normalized frame, with the same fields the Kotlin `read` returns. */
export interface TranscriptFrame {
  kind: TranscriptKind;
  messages: TranscriptMessage[];
  hasMore: boolean;
  totalLines: number;
  startLine: number | null;
  reset: boolean;
  questionEvents: QuestionEvent[];
  progressEvents: ProgressEvent[];
  queueEvents: QueueConsumption[];
  context: SessionContext;
  preview: ChatPreview | null;
  updatesPreview: boolean;
  activityVerb: string | null;
  sideAnswer: unknown | null;
  activity: unknown | null;
  source: string;
  delivery: unknown | null;
  replacesConversation: boolean;
}

export class UnsupportedTranscriptError extends Error {
  constructor() { super("The computer returned an unsupported chat transcript."); this.name = "UnsupportedTranscriptError"; }
}
export class InvalidPreviewError extends Error {
  constructor() { super("The computer returned an invalid reply preview."); this.name = "InvalidPreviewError"; }
}
export class TooLargeTranscriptError extends Error {
  constructor() { super("The chat transcript is too large."); this.name = "TooLargeTranscriptError"; }
}
export class TooManyMessagesError extends Error {
  constructor() { super("This conversation has too many message blocks to load. Open the terminal to view it."); this.name = "TooManyMessagesError"; }
}

export const MAXIMUM_MESSAGES = 4_000;
export const MAXIMUM_UPLOAD_IMAGES = 8;

// --- JSON access, matching JsonAccess.kt's type rules -----------------------------------------

export function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function arr(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
export function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function int(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}
export function objects(value: unknown): Record<string, unknown>[] | undefined {
  const a = arr(value);
  if (a === undefined || !a.every(item => obj(item) !== undefined)) return undefined;
  return a as Record<string, unknown>[];
}
export function get(value: unknown, key: string): unknown {
  const o = obj(value);
  return o === undefined ? undefined : o[key];
}
export function hasKey(value: unknown, key: string): boolean {
  const o = obj(value);
  return o !== undefined && Object.prototype.hasOwnProperty.call(o, key);
}

// --- Strings ----------------------------------------------------------------------------------

/** UTF-8 byte length without Buffer or TextEncoder: pure, for the daemon and the UI alike. */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** The first `limit` code points; adjacent to Swift's Character prefix (graphemes). */
export function prefixCharacters(text: string, limit: number): string {
  if (limit < 0) throw new RangeError("limit must be non-negative");
  if (text.length <= limit) return text;
  let count = 0, i = 0;
  while (i < text.length && count < limit) {
    const c = text.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1;
    count++;
  }
  return text.slice(0, i);
}

/** A message over 64,000 UTF-8 bytes keeps its first 64,000 characters. */
export function boundedMessageText(value: string): string {
  return utf8Length(value) <= 64_000 ? value : prefixCharacters(value, 64_000);
}

/** Unix control or format characters, as Swift's CharacterSet.controlCharacters rejects them. */
export function hasControlCharacters(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return true;
  }
  return false;
}

// --- Apple-style pretty JSON (readable tool arguments and results) ----------------------------

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  const o = obj(value);
  if (o !== undefined) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
    return out;
  }
  return value;
}

function escapeJsonString(value: string, escapeSlashes: boolean): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    switch (ch) {
      case '"': out += '\\"'; break;
      case "\\": out += "\\\\"; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      case "\b": out += "\\b"; break;
      case "\f": out += "\\f"; break;
      default:
        if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
        else if (escapeSlashes && ch === "/") out += "\\/";
        else out += ch;
    }
  }
  return `${out}"`;
}

function applePretty(value: unknown, indent: number, escapeSlashes: boolean): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return escapeJsonString(value, escapeSlashes);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const pad = "  ".repeat(indent + 1), close = "  ".repeat(indent);
    return `[\n${value.map(v => pad + applePretty(v, indent + 1, escapeSlashes)).join(",\n")}\n${close}]`;
  }
  const o = obj(value);
  if (o === undefined) return "null";
  const entries = Object.entries(o);
  if (entries.length === 0) return "{}";
  const pad = "  ".repeat(indent + 1), close = "  ".repeat(indent);
  return `{\n${entries.map(([k, v]) => `${pad}${escapeJsonString(k, escapeSlashes)} : ${applePretty(v, indent + 1, escapeSlashes)}`).join(",\n")}\n${close}}`;
}

/** Pretty-printed with sorted keys, as Foundation's JSONSerialization does. */
export function prettyJson(value: unknown, escapeSlashes = false): string {
  return applePretty(sortKeys(value), 0, escapeSlashes);
}

export function readable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return "";
  return prettyJson(value);
}

/** Flatten a content value into text, treating image blocks as markers. */
export function text(value: unknown): string {
  if (typeof value === "string") return value;
  const blocks = arr(value);
  if (blocks === undefined) return "";
  const out: string[] = [];
  for (const block of blocks) {
    const type = str(get(block, "type"));
    if (type === "text" || type === "input_text" || type === "output_text") {
      const t = str(get(block, "text"));
      if (t !== undefined) out.push(t);
    } else if (type === "image" || type === "input_image") {
      out.push("[Image attachment]");
    }
  }
  return out.join("\n\n");
}

function innerImages(content: unknown): number[] {
  const blocks = objects(content) ?? [];
  const out: number[] = [];
  blocks.forEach((block, index) => {
    const type = str(block.type);
    if (type === "image" || type === "input_image") out.push(index);
  });
  return out;
}

// --- Timestamps and IDs -----------------------------------------------------------------------

function parseIso(value: string | undefined): string | null {
  if (value === undefined) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function jsonTimestamp(value: unknown): string | null {
  const s = str(value);
  if (s !== undefined) return parseIso(s);
  const n = num(value);
  if (n !== undefined) return new Date(Math.trunc((n > 1e12 ? n / 1000 : n) * 1000)).toISOString();
  return null;
}

function timestamp(raw: Record<string, unknown>): string | null {
  return jsonTimestamp(raw.timestamp);
}

function validQueueKey(key: string): boolean {
  return key.length === 64 && /^[0-9a-f]+$/.test(key);
}

// --- LocalCommand -----------------------------------------------------------------------------

const LOCAL_TAGS = ["<command-name>", "<local-command-stdout>", "<local-command-stderr>", "<bash-input>", "<bash-stdout>", "<bash-stderr>"];

/** A slash command or `!` shell line typed at Claude Code's own prompt. */
export function parseLocalCommand(raw: string): LocalCommand | null {
  const trimmed = raw.trim();
  if (!LOCAL_TAGS.some(tag => trimmed.startsWith(tag))) return null;
  const content = (name: string): string | null => {
    const open = trimmed.indexOf(`<${name}>`);
    if (open < 0) return null;
    const start = open + name.length + 2;
    const close = trimmed.indexOf(`</${name}>`, start);
    if (close < 0) return null;
    return trimmed.slice(start, close).trim();
  };
  const commandName = content("command-name");
  if (commandName !== null) {
    const args = content("command-args") ?? "";
    return { kind: "command", text: args.length === 0 ? commandName : `${commandName} ${args}` };
  }
  const bashInput = content("bash-input");
  if (bashInput !== null) return { kind: "shell", text: bashInput };
  const output = ["local-command-stdout", "local-command-stderr", "bash-stdout", "bash-stderr"]
    .map(content).filter((value): value is string => value !== null && value.length > 0).join("\n");
  return { kind: "output", text: output };
}

// --- Session context --------------------------------------------------------------------------

export function emptySettings(): AgentSettingsState {
  return { fast: null, permissionMode: null };
}

export function emptySessionContext(line = -1): SessionContext {
  return { modelName: null, branch: null, line, effort: null, settings: emptySettings(), replacesPermissionMode: false };
}

function settingsIsEmpty(settings: AgentSettingsState): boolean {
  return settings.fast === null && settings.permissionMode === null;
}

function overlaySettings(base: AgentSettingsState, other: AgentSettingsState): AgentSettingsState {
  return {
    fast: other.fast !== null ? other.fast : base.fast,
    permissionMode: other.permissionMode !== null ? other.permissionMode : base.permissionMode,
  };
}

/** Codex's turn_context carries the sandbox/approval settings; the catalogue knows the modes. */
function codexSettings(payload: Record<string, unknown>): AgentSettingsState {
  const mode = str(payload.approval_policy) ?? str(payload.sandbox_policy) ?? null;
  return { fast: null, permissionMode: mode };
}

const EFFORT_WORD = /^[a-z]{1,16}$/;

function effortValue(value: unknown): string | null {
  const s = str(value);
  return s !== undefined && EFFORT_WORD.test(s) ? s : null;
}

function nameValue(value: unknown, limit = 100): string | null {
  const s = str(value);
  if (s === undefined) return null;
  const trimmed = s.replace(/^[\s\u0085]+|[\s\u0085]+$/g, "");
  return trimmed.length === 0 ? null : prefixCharacters(trimmed, limit);
}

/** Reads the model/branch/effort a raw row reports (AgentSessionContext.read). */
export function readSessionContext(raw: Record<string, unknown>, source: ChatSource, line: number): SessionContext {
  const found = emptySessionContext(line);
  if (source === "claude" && bool(raw.isMeta) !== true && bool(raw.isSidechain) !== true) {
    const message = obj(raw.message);
    if (message !== undefined && str(message.role) === "assistant") {
      found.modelName = nameValue(message.model);
      found.effort = effortValue(raw.effort);
      const speed = str(get(message.usage, "speed"));
      found.settings = { fast: speed === "fast" ? true : speed === "standard" ? false : null, permissionMode: null };
    }
    found.branch = nameValue(raw.gitBranch, 200);
  } else if (source === "codex" && str(raw.type) === "turn_context") {
    const payload = obj(raw.payload);
    found.modelName = nameValue(payload?.model);
    found.effort = effortValue(payload?.effort);
    if (payload !== undefined) { found.settings = codexSettings(payload); found.replacesPermissionMode = true; }
  }
  return found;
}

/** Takes `other`'s values when it is at least as new as what is held. */
export function mergeSessionContext(into: SessionContext, other: SessionContext): void {
  if ((other.modelName === null && other.effort === null && other.branch === null && settingsIsEmpty(other.settings) && !other.replacesPermissionMode)
    || other.line < into.line) return;
  if (other.modelName !== null) into.modelName = other.modelName;
  if (other.effort !== null) into.effort = other.effort;
  if (other.branch !== null) into.branch = other.branch;
  const overlaid = overlaySettings(into.settings, other.settings);
  into.settings = other.replacesPermissionMode ? { ...overlaid, permissionMode: other.settings.permissionMode } : overlaid;
  into.line = other.line;
}

// --- Message construction ---------------------------------------------------------------------

interface Part {
  role: ChatRole;
  title: string | null;
  text: string;
  imageBlocks: number[];
  resultImages: ImageRef[];
  uploadImages: string[];
  toolCallID: string | null;
  idIndex: number | null;
  isToolError: boolean;
  isNarration: boolean;
}

function part(role: ChatRole, text: string, fields: Partial<Omit<Part, "role" | "text">> = {}): Part {
  return {
    role, text, title: null, imageBlocks: [], resultImages: [], uploadImages: [], toolCallID: null,
    idIndex: null, isToolError: false, isNarration: false, ...fields,
  };
}

function makeMessage(fields: { id: string; line: number; role: ChatRole; title: string | null; text: string }
  & Partial<Pick<TranscriptMessage, "imageBlocks" | "resultImages" | "uploadImages" | "toolCallID">>): TranscriptMessage {
  return {
    id: fields.id, line: fields.line, role: fields.role, title: fields.title, text: fields.text,
    imageBlocks: fields.imageBlocks ?? [], resultImages: fields.resultImages ?? [], uploadImages: fields.uploadImages ?? [],
    toolCallID: fields.toolCallID ?? null, timestamp: null, wasQueued: false, isQueued: false, queueKey: null,
    isScheduled: false, isToolError: false, isNarration: false, isHookContext: false,
    isToolResult: fields.role === "tool" && fields.title === "Tool result",
    isChange: fields.role === "tool" && fields.title === "Changes",
    isCompaction: fields.role === "tool" && fields.title === "Conversation compacted",
    localCommand: fields.role === "user" ? parseLocalCommand(fields.text) : null,
  };
}

/** A message with a few prompt-state fields replaced, sharing everything else. */
export function copyMessage(message: TranscriptMessage, patch: Partial<Pick<TranscriptMessage,
  "isQueued" | "wasQueued" | "queueKey" | "isScheduled">>): TranscriptMessage {
  return { ...message, ...patch };
}

// --- Part transforms --------------------------------------------------------------------------

const UPLOAD_IMAGE_MARKER = /\[Image: source: ([^\]\n]+)\]/g;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

function extensionOf(path: string): string {
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
}

/** Records `[Image: source: /path]` markers naming images and takes them out of the words. */
export function uploadImageMarkers(source: string): { text: string; paths: string[] } {
  if (!source.includes("[Image: source: ")) return { text: source, paths: [] };
  const paths: string[] = [];
  let stripped = "";
  let cursor = 0;
  UPLOAD_IMAGE_MARKER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = UPLOAD_IMAGE_MARKER.exec(source)) !== null) {
    const path = match[1].trim();
    const valid = path.startsWith("/") && utf8Length(path) <= 4_096
      && IMAGE_EXTENSIONS.has(extensionOf(path)) && !hasControlCharacters(path);
    if (!valid) continue;
    if (paths.length < MAXIMUM_UPLOAD_IMAGES) paths.push(path);
    stripped += source.slice(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  if (paths.length === 0) return { text: source, paths: [] };
  stripped += source.slice(cursor);
  return { text: stripped.trim(), paths };
}

function withUploadImages(parts: Part[]): Part[] {
  return parts.map(p => {
    if (p.role !== "user") return p;
    const { text: stripped, paths } = uploadImageMarkers(p.text);
    if (paths.length === 0) return p;
    return { ...p, text: stripped.length === 0 ? "[Image attachment]" : stripped, uploadImages: paths };
  });
}

/** One turn from the person is one bubble: text and image parts fold into the first. */
function mergedUserParts(parts: Part[]): Part[] {
  const userIndices = parts.map((p, i) => (p.role === "user" ? i : -1)).filter(i => i >= 0);
  if (userIndices.length <= 1) return parts;
  const first = userIndices[0];
  const texts: string[] = [];
  const imageBlocks: number[] = [];
  const uploadImages: string[] = [];
  for (const i of userIndices) {
    const p = parts[i];
    imageBlocks.push(...p.imageBlocks);
    uploadImages.push(...p.uploadImages);
    if (p.text !== "[Image attachment]" && p.text.length > 0) texts.push(p.text);
  }
  const base = parts[first];
  const merged: Part = {
    ...base,
    text: texts.length === 0 ? "[Image attachment]" : texts.join("\n\n"),
    imageBlocks,
    uploadImages: uploadImages.slice(0, MAXIMUM_UPLOAD_IMAGES),
    title: base.title,
    resultImages: base.resultImages,
    toolCallID: base.toolCallID,
    idIndex: base.idIndex,
  };
  const out: Part[] = [];
  parts.forEach((p, i) => {
    if (i === first) out.push(merged);
    else if (p.role !== "user") out.push(p);
  });
  return out;
}

const HARNESS_PREAMBLES = ["<environment_context>", "<filesystem>", "<permission_profile", "<system-reminder>", "<user_instructions>", "<turn_context>"];

/** Text a harness injects as if the person typed it. */
export function isHarnessPreamble(value: string): boolean {
  const t = value.trim();
  return HARNESS_PREAMBLES.some(prefix => t.startsWith(prefix));
}

/** A user turn that is only Claude Code's background completion envelope. */
export function isTaskNotification(value: string): boolean {
  const t = value.trim();
  if (!t.includes("<task-notification>") || !t.includes("<tool-use-id>")) return false;
  return t.startsWith("<task-notification>") || t.startsWith("<system-reminder>");
}

/** What a shell call changed, as Phren Hook attaches it (`phren_changes`, keyed by call id). */
function changesParts(raw: Record<string, unknown>, after: Part[]): Part[] {
  const attached = obj(raw.phren_changes);
  if (attached === undefined) return [];
  const extra: Part[] = [];
  for (const p of after) {
    if (p.title !== "Tool result" || p.toolCallID === null) continue;
    const files = objects(attached[p.toolCallID]);
    if (files === undefined) continue;
    for (const file of files.slice(0, 40)) {
      const path = str(file.path), patch = str(file.patch);
      if (path === undefined || patch === undefined) continue;
      if (path.length === 0 || utf8Length(path) > 4_096 || patch.length === 0) continue;
      const status = str(file.status) ?? "M";
      const header = status === "A" ? "*** Add File: " : status === "D" ? "*** Delete File: " : "*** Update File: ";
      const lines = patch.split("\n");
      const firstHunk = lines.findIndex(line => line.startsWith("@@"));
      const hunks = (firstHunk < 0 ? [] : lines.slice(firstHunk)).join("\n");
      extra.push(part("tool", `${header}${path}\n${hunks}`, { title: "Changes", toolCallID: p.toolCallID }));
    }
  }
  return extra;
}

/** Copilot's shown summary, without markdown bold markers or private reasoning fields. */
export function copilotThought(value: string | null | undefined): string {
  let thought = (value ?? "").trim();
  const heading = /^\*\*([^*\n]+)\*\*\s*\n+/.exec(thought);
  if (heading !== null) {
    let title = heading[0].replace(/\*\*/g, "").trim();
    const last = title.slice(-1);
    if (![".", "!", "?", ":"].includes(last)) title += ".";
    thought = `${title} ${thought.slice(heading.index + heading[0].length)}`;
  }
  return thought.replace(/\*\*/g, "");
}

/** A compaction boundary and its summary draw as one row. */
function collapsedCompactions(messages: TranscriptMessage[]): TranscriptMessage[] {
  const result: TranscriptMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    if (!isCompaction(messages[index])) { result.push(messages[index]); index++; continue; }
    let end = index;
    while (end < messages.length && isCompaction(messages[end])) end++;
    const group = messages.slice(index, end);
    result.push(group.find(m => m.text.length > 0) ?? group[0]);
    index = end;
  }
  return result;
}

function isCompaction(message: TranscriptMessage): boolean {
  return message.role === "tool" && message.title === "Conversation compacted";
}

// --- Per-harness parsers ----------------------------------------------------------------------

function roleOf(value: unknown): ChatRole | undefined {
  const s = str(value);
  return s === "user" || s === "assistant" || s === "tool" ? s : undefined;
}

/** The skill tool whose body answers the call that loaded it. */
function recognizesSkillCall(title: string): boolean {
  return title === "skill" || title.endsWith("__skill");
}

function codexParts(raw: Record<string, unknown>): Part[] {
  if (str(raw.type) !== "response_item") return [];
  const payload = obj(raw.payload);
  if (payload === undefined) return [];
  switch (str(payload.type)) {
    case "message": {
      const role = roleOf(payload.role);
      if (role === undefined || role === "tool") return [];
      const images = (objects(payload.content) ?? [])
        .map((block, index) => (str(block.type) === "input_image" || str(block.type) === "image" ? index : -1))
        .filter(index => index >= 0);
      const body = text(payload.content);
      if (role === "user" && images.length === 0 && isHarnessPreamble(body)) return [];
      return [part(role, body, { imageBlocks: images })];
    }
    case "function_call":
    case "custom_tool_call": {
      const args = Object.prototype.hasOwnProperty.call(payload, "arguments") ? payload.arguments : payload.input;
      return [part("tool", readable(args), { title: str(payload.name) ?? "Tool", toolCallID: str(payload.call_id) ?? null })];
    }
    case "function_call_output":
    case "custom_tool_call_output":
      return [part("tool", readable(payload.output), { title: "Tool result",
        resultImages: innerImages(payload.output).map(block => ({ block, inner: null })), toolCallID: str(payload.call_id) ?? null })];
    default:
      return [];
  }
}

/** phren-agent's event log, as Phren Hook exports it. */
function phrenParts(raw: Record<string, unknown>): Part[] {
  const type = str(raw.type);
  const message = obj(get(obj(raw.data), "message"));
  if (type === undefined || message === undefined) return [];
  const role: ChatRole | undefined = type === "user/message" ? "user"
    : type === "assistant/message" ? "assistant" : type === "tool/results" ? "tool" : undefined;
  if (role === undefined) return [];
  const contentString = str(message.content);
  if (contentString !== undefined) return role === "tool" ? [] : [part(role, contentString)];
  const blocks = objects(message.content);
  if (blocks === undefined) return [];
  const out: Part[] = [];
  blocks.forEach((block, index) => {
    switch (str(block.type)) {
      case "text": {
        const t = str(block.text);
        if (role === "tool" || t === undefined || t.length === 0) return;
        out.push(part(role, t, { idIndex: index }));
        return;
      }
      case "image":
        if (role === "tool") return;
        out.push(part(role, "[Image attachment]", { imageBlocks: [index], idIndex: index }));
        return;
      case "tool_use":
        out.push(part("tool", readable(block.input), { title: str(block.name) ?? "Tool", toolCallID: str(block.id) ?? null, idIndex: index }));
        return;
      case "tool_result":
        out.push(part("tool", text(block.content), { title: "Tool result",
          resultImages: innerImages(block.content).map(inner => ({ block: index, inner })),
          toolCallID: str(block.tool_use_id) ?? null, idIndex: index, isToolError: bool(block.is_error) === true }));
        return;
      default:
        return;
    }
  });
  return out;
}

function copilotParts(raw: Record<string, unknown>, skillCalls: Map<string, string>): Part[] {
  if (hasKey(raw, "agentId") || bool(raw.ephemeral) === true) return [];
  const data = obj(raw.data);
  if (data === undefined) return [];
  switch (str(raw.type)) {
    case "user.message": {
      if (!hasKey(data, "source") || str(data.source) === "user") return [part("user", text(data.content))];
      return [];
    }
    case "assistant.message": {
      const thought = copilotThought(str(data.reasoningText));
      const reply = part("assistant", text(data.content), { idIndex: 0 });
      if (thought.length === 0) return [reply];
      return [part("assistant", thought, { idIndex: -1, isNarration: true }), reply];
    }
    case "tool.execution_start": {
      const server = str(data.mcpServerName), tool = str(data.mcpToolName);
      const title = server !== null && server !== undefined && tool !== null && tool !== undefined
        ? `mcp__${server}__${tool}` : str(data.toolName) ?? "Tool";
      const id = str(data.toolCallId) ?? null;
      if (id !== null && recognizesSkillCall(title)) {
        const skill = str(get(data.arguments, "skill"));
        if (skill !== undefined) skillCalls.set(skill.replace(/^\//, ""), id);
      }
      return [part("tool", readable(data.arguments), { title, toolCallID: id })];
    }
    case "skill.invoked": {
      const name = str(data.name);
      const id = name === undefined ? undefined : skillCalls.get(name);
      const content = str(data.content);
      if (id === undefined || content === undefined || content.length === 0) return [];
      return [part("tool", content, { title: "Tool result", toolCallID: id })];
    }
    case "tool.execution_complete": {
      const result = obj(data.result), error = obj(data.error);
      return [part("tool", text(result?.content) + text(error?.message), { title: "Tool result",
        toolCallID: str(data.toolCallId) ?? null, isToolError: bool(data.success) === false || error !== undefined })];
    }
    default:
      return [];
  }
}

function claudeParts(raw: Record<string, unknown>, maximumParts: number): Part[] {
  if (str(raw.type) === "system" && bool(raw.phrenCompacted) === true) return [part("tool", "", { title: "Conversation compacted" })];
  if (bool(raw.phrenBackground) === true) {
    const content = str(get(obj(raw.message), "content"));
    if (content !== undefined) return [part("tool", content, { title: "Background notification" })];
  }
  if (bool(raw.isMeta) === true || bool(raw.isSidechain) === true) return [];
  const message = obj(raw.message);
  if (message === undefined) return [];
  const role = roleOf(message.role);
  if (role === undefined || role === "tool") return [];
  if (role === "user" && bool(raw.isCompactSummary) === true)
    return [part("tool", text(message.content).slice(0, 4_000), { title: "Conversation compacted" })];
  const contentString = str(message.content);
  if (contentString !== undefined) {
    if (role === "user" && isTaskNotification(contentString)) return [part("tool", contentString, { title: "Background notification" })];
    if (role === "user" && contentString.startsWith("This session is being continued from a previous conversation"))
      return [part("tool", contentString.slice(0, 4_000), { title: "Conversation compacted" })];
    if (role === "user" && isHarnessPreamble(contentString)) return [];
    if (contentString.length > 0 && maximumParts <= 0) throw new TooManyMessagesError();
    return [part(role, contentString)];
  }
  const blocks = objects(message.content);
  if (blocks === undefined) return [];
  let visible = 0;
  for (const block of blocks) {
    const type = str(block.type);
    if (type === "text") { if (str(block.text) === undefined || str(block.text) === "") continue; }
    else if (type !== "image" && type !== "tool_use" && type !== "tool_result") continue;
    visible++;
    if (visible > maximumParts) throw new TooManyMessagesError();
  }
  let normalizedIndex = 0;
  const out: Part[] = [];
  blocks.forEach((block, index) => {
    const type = str(block.type);
    if (type !== "text" && type !== "image" && type !== "tool_use" && type !== "tool_result") return;
    const idIndex = normalizedIndex++;
    if (type === "text") {
      const t = str(block.text);
      if (t === undefined || t.length === 0) return;
      if (role === "user" && isTaskNotification(t)) out.push(part("tool", t, { title: "Background notification", idIndex }));
      else out.push(part(role, t, { idIndex, isNarration: role === "assistant" && bool(block.narration) === true }));
      return;
    }
    if (type === "image") { out.push(part(role, "[Image attachment]", { imageBlocks: [index], idIndex })); return; }
    if (type === "tool_use") {
      out.push(part("tool", readable(block.input), { title: str(block.name) ?? "Tool", toolCallID: str(block.id) ?? null, idIndex }));
      return;
    }
    out.push(part("tool", text(block.content), { title: "Tool result",
      resultImages: innerImages(block.content).map(inner => ({ block: index, inner })),
      toolCallID: str(block.tool_use_id) ?? null, idIndex, isToolError: bool(block.is_error) === true }));
  });
  return out;
}

// --- Progress and question events -------------------------------------------------------------

/**
 * The agent's own dialog events arrive through a separate reader on the phone
 * (AgentQuestionEvent); this package does not carry it yet, so no frame yields one.
 */
function readQuestionEvents(_raw: Record<string, unknown>, _source: ChatSource): QuestionEvent[] {
  return [];
}

/**
 * Turn-shape usage events (AgentChatProgressEvent) are computed by a tracker
 * outside this reader; only the started/finished marks the transcript itself
 * can prove are derived below, so per-row usage is not read here.
 */
function readProgressEvent(_raw: Record<string, unknown>, _source: ChatSource, _line: number): ProgressEvent | undefined {
  return undefined;
}

function spinnerVerb(_value: unknown): string | null {
  return null;
}

function addOnce(seen: Set<string>, id: string): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  return true;
}

// --- The reading entry ------------------------------------------------------------------------

/** Process the visible rows of one frame into messages and per-frame events. */
export function readTranscriptRows(source: ChatSource, rows: TranscriptRow[], options: ReadOptions = {}): TranscriptRead {
  const sidechain = options.sidechain === true;
  const messages: TranscriptMessage[] = [];
  const questionEvents: QuestionEvent[] = [];
  const progressEvents: ProgressEvent[] = [];
  const queueEvents: QueueConsumption[] = [];
  const context = emptySessionContext();
  const seen = new Set<string>();
  const copilotSkillCalls = new Map<string, string>();
  let inputWasNotification = false;
  for (const row of rows) {
    const line = int(row.line);
    if (line === undefined || line < 0) continue;
    let raw = obj(row.raw);
    if (raw === undefined) continue;
    if (source === "claude" && str(raw.type) === "phren_turn_input") { inputWasNotification = bool(raw.notification) === true; continue; }
    if (source === "claude" && str(raw.type) === "phren_hook_context") {
      const wasNotification = inputWasNotification;
      inputWasNotification = false;
      const content = str(raw.content);
      if (wasNotification || content === undefined || content.length === 0 || !addOnce(seen, `${line}:hook`)) continue;
      const message = makeMessage({ id: `${line}:hook`, line, role: "assistant", title: "phren context", text: boundedMessageText(content) });
      message.timestamp = timestamp(raw);
      message.isHookContext = true;
      messages.push(message);
      continue;
    }
    if (sidechain && bool(raw.isSidechain) === true) { raw = { ...raw }; delete raw.isSidechain; }
    if (source === "claude" || source === "codex") {
      const type = str(raw.type);
      if (type === "phren_queue_consumed" || type === "phren_queue_returned") {
        const key = str(raw.key);
        if (key !== undefined && validQueueKey(key)) queueEvents.push({ line, key, scheduled: bool(raw.scheduled) === true, returned: type === "phren_queue_returned" });
        continue;
      }
    }
    mergeSessionContext(context, readSessionContext(raw, source, line));
    let parts = source === "codex" ? codexParts(raw)
      : source === "copilot" ? copilotParts(raw, copilotSkillCalls)
      : source === "phren" || source === "opencode" ? phrenParts(raw)
      : claudeParts(raw, MAXIMUM_MESSAGES - messages.length);
    parts = mergedUserParts(withUploadImages(parts));
    parts = parts.concat(changesParts(raw, parts));
    questionEvents.push(...readQuestionEvents(raw, source));
    const progress = readProgressEvent(raw, source, line);
    if (progress !== undefined) progressEvents.push({ ...progress, timestamp: timestamp(raw) });
    if (source === "claude") {
      if (bool(raw.phrenQueued) !== true && parts.some(p => p.role === "user" && parseLocalCommand(p.text) === null))
        progressEvents.push({ line, value: { kind: "started" }, timestamp: timestamp(raw) });
      const message = obj(raw.message);
      if (message !== undefined && str(message.stop_reason) === "end_turn" && bool(raw.isMeta) !== true && bool(raw.isSidechain) !== true)
        progressEvents.push({ line, value: { kind: "finished" }, timestamp: timestamp(raw) });
    } else if ((source === "phren" || source === "opencode") && str(raw.type) === "assistant/message") {
      const data = obj(raw.data);
      if (data !== undefined && hasKey(data, "usage") && str(data.stop_reason) === "end_turn")
        progressEvents.push({ line, value: { kind: "finished" }, timestamp: parseIso(str(raw.time)) });
    }
    parts.forEach((p, index) => {
      const id = `${line}:${p.idIndex ?? index}`;
      if ((p.text.length === 0 && p.role !== "tool") || !addOnce(seen, id)) return;
      const toolCallID = p.toolCallID !== null && p.toolCallID.length > 0 && utf8Length(p.toolCallID) <= 512 ? p.toolCallID : null;
      const message = makeMessage({ id, line, role: p.role, title: p.title, text: boundedMessageText(p.text),
        imageBlocks: p.imageBlocks, resultImages: p.resultImages, uploadImages: p.uploadImages, toolCallID });
      message.timestamp = timestamp(raw);
      message.isToolError = p.isToolError;
      message.isNarration = p.isNarration;
      if (p.role === "user") {
        const queueKey = str(raw.phrenQueueKey);
        if (queueKey !== undefined && validQueueKey(queueKey)) message.queueKey = queueKey;
      }
      if ((source === "claude" || source === "codex") && p.role === "user" && bool(raw.phrenQueued) === true) {
        message.wasQueued = true;
        message.isQueued = true;
        const queueKey = str(raw.phrenQueueKey);
        if (queueKey !== undefined && validQueueKey(queueKey)) message.queueKey = queueKey;
      }
      messages.push(message);
    });
  }
  return { messages, context, questionEvents, progressEvents, queueEvents };
}

function minEntryLine(entries: Record<string, unknown>[]): number | null {
  const lines = entries.map(entry => int(entry.line)).filter((line): line is number => line !== undefined);
  return lines.length === 0 ? null : Math.min(...lines);
}

function makeFrame(fields: Partial<TranscriptFrame> & Pick<TranscriptFrame, "kind" | "source">): TranscriptFrame {
  const messages = fields.messages ?? [];
  const totalLines = fields.totalLines ?? 0;
  const reset = fields.reset ?? false;
  return {
    kind: fields.kind, source: fields.source, messages, hasMore: fields.hasMore ?? false, totalLines, startLine: fields.startLine ?? null,
    reset, questionEvents: fields.questionEvents ?? [], progressEvents: fields.progressEvents ?? [], queueEvents: fields.queueEvents ?? [],
    context: fields.context ?? emptySessionContext(), preview: fields.preview ?? null, updatesPreview: fields.updatesPreview ?? false,
    activityVerb: fields.activityVerb ?? null, sideAnswer: fields.sideAnswer ?? null, activity: fields.activity ?? null,
    delivery: fields.delivery ?? null, replacesConversation: reset && (totalLines > 0 || messages.length > 0),
  };
}

/** The full read over one Hook frame, mirroring AgentChatTranscript.read. */
export function readTranscriptFrame(frame: unknown, source: ChatSource, options: ReadFrameOptions = {}): TranscriptFrame {
  if (!CHAT_SOURCES.includes(source)) throw new UnsupportedTranscriptError();
  const f = obj(frame);
  if (f === undefined) throw new UnsupportedTranscriptError();
  const kind = TRANSCRIPT_KINDS.find(candidate => candidate === str(f.type));
  if (kind === undefined) throw new UnsupportedTranscriptError();
  if (str(f.source) !== source) throw new UnsupportedTranscriptError();
  if (options.session !== undefined && str(f.session) !== options.session) throw new UnsupportedTranscriptError();
  if (hasKey(f, "entries") && objects(f.entries) === undefined) throw new UnsupportedTranscriptError();
  if (kind === "delivery") return makeFrame({ kind, source, delivery: f });
  if (kind === "side-answer") return makeFrame({ kind, source, sideAnswer: f });
  const entries = objects(f.entries) ?? [];
  const updatesPreview = kind !== "older" && hasKey(f, "preview");
  let preview: ChatPreview | null = null;
  if (updatesPreview && f.preview !== null && f.preview !== undefined) {
    const value = obj(f.preview);
    const start = parseIso(str(value?.turnStartedAt));
    const previewText = str(value?.text);
    if (start === null || previewText === undefined || previewText.length === 0 || utf8Length(previewText) > 131_072) throw new InvalidPreviewError();
    preview = { turnStartedAt: start, text: previewText, streamed: bool(value?.streamed) === true || str(value?.delta) !== undefined };
  }
  if (kind === "preview") {
    if (!updatesPreview || entries.length > 0) throw new InvalidPreviewError();
    return makeFrame({ kind, source, preview, updatesPreview: true,
      activityVerb: spinnerVerb(f.activityVerb), activity: f.activity ?? null });
  }
  if (entries.length > 2_000) throw new TooLargeTranscriptError();
  const rows: TranscriptRow[] = entries.map(entry => ({ line: int(entry.line) ?? -1, raw: entry.raw }));
  const read = readTranscriptRows(source, rows, { sidechain: options.sidechain });
  const ordered = [...read.messages].sort((a, b) => a.line - b.line);
  return makeFrame({
    kind, source, messages: collapsedCompactions(ordered),
    hasMore: bool(f.hasMore) ?? false, totalLines: int(f.totalLines) ?? 0,
    startLine: int(f.startLine) ?? minEntryLine(entries), reset: bool(f.reset) ?? false,
    questionEvents: read.questionEvents, progressEvents: read.progressEvents, queueEvents: read.queueEvents, context: read.context,
    preview, updatesPreview, activityVerb: spinnerVerb(f.activityVerb), activity: f.activity ?? null,
  });
}


