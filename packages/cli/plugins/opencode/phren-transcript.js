// Installed by Phren Hook and replaced on every update. Copy it under another name to customize.
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const PHREN_STORE = "__PHREN_STORE__";
const FLUSH_MS = 250;
const MAX_TOOL_OUTPUT = 200_000;
const STOP_REASONS = { stop: "end_turn", "tool-calls": "tool_use", length: "max_tokens" };
const OPENCODE_SESSION = /^ses_[0-9A-Za-z]{1,64}$/;
const APPROVAL_POLL_MS = 200;
const APPROVAL_DEADLINE_MS = 50_000;

function storeRoot() {
  if (PHREN_STORE && !PHREN_STORE.startsWith("__")) return PHREN_STORE;
  const configured = process.env.PHREN_PATH?.trim();
  if (!configured) return path.join(homedir(), ".phren");
  const expanded = configured === "~" ? homedir() : configured.startsWith("~/") ? path.join(homedir(), configured.slice(2)) : configured;
  return path.resolve(expanded);
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function approvalDirectory() {
  return path.join(storeRoot(), ".runtime", "approvals");
}

function fanoutDirectory() {
  const configured = process.env.PHREN_FANOUT_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(storeRoot(), ".runtime", "agent-fanouts", text(process.env.PHREN_FANOUT_JOB));
}

function fanoutPatterns(input) {
  const value = input?.pattern;
  if (Array.isArray(value)) return value.filter(entry => typeof entry === "string" && entry);
  return typeof value === "string" && value ? [value] : [];
}

/** The worktree's grandparent is the scratch root the fan-out launcher owns:
 * external reads and writes are allowed only inside it. */
function underScratchRoot(value) {
  const scratch = path.dirname(path.dirname(path.resolve(process.cwd())));
  if (scratch === path.parse(scratch).root) return false;
  const resolved = path.resolve(scratch, value);
  return resolved === scratch || resolved.startsWith(scratch + path.sep);
}

function under(parent, value) {
  if (!parent || parent === path.parse(parent).root) return false;
  const root = path.resolve(parent), resolved = path.resolve(root, value);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** Beyond the scratch root, a worker legitimately reads its own machine: the
 * node_modules its worktree links into the main checkout, the store it was
 * briefed from, the toolchains a build shells out to, and the temporary
 * directories those builds write. Everything outside this set is refused. */
function fanoutReadable(value) {
  if (underScratchRoot(value)) return true;
  const home = process.env.HOME || "";
  const roots = [home, storeRoot(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders",
                 "/Applications/Xcode.app", "/Library/Developer"];
  return roots.some(root => under(root, value));
}

/** A headless fan-out worker may edit, run commands and fetch, and continue
 * when OpenCode's own loop detector asks (the launcher's watchdog stops a real
 * loop and says why, which is a clearer failure than a refused permission).
 * Anything else is refused outright. */
function fanoutAllowed(input) {
  const kind = text(input?.type);
  if (kind === "edit" || kind === "bash" || kind === "webfetch" || kind === "doom_loop") return true;
  if (kind !== "external_directory") return false;
  const patterns = fanoutPatterns(input);
  return patterns.length > 0 && patterns.every(fanoutReadable);
}

function writeBlocked(input) {
  try {
    const directory = fanoutDirectory();
    mkdirSync(directory, { recursive: true });
    writeJsonAtomic(path.join(directory, "blocked.json"), {
      type: text(input?.type) || "action",
      pattern: fanoutPatterns(input).join(", "),
      message: permissionMessage(input),
      at: new Date().toISOString(),
    });
  } catch {}
}

function approvalPaths(sessionID) {
  const base = path.join(approvalDirectory(), `opencode-${sessionID}`);
  return { request: `${base}.request.json`, answer: `${base}.answer.json` };
}

function writeJsonAtomic(file, value) {
  const staging = `${file}.${process.pid}.tmp`;
  writeFileSync(staging, JSON.stringify(value), { mode: 0o600 });
  renameSync(staging, file);
}

function removeFile(file) {
  try { unlinkSync(file); } catch {}
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function setStatus(output, status) {
  if (output && typeof output === "object") output.status = status;
}

function permissionMessage(input) {
  const type = text(input?.type) || "action";
  const pattern = Array.isArray(input?.pattern)
    ? input.pattern.filter(value => typeof value === "string").join(", ")
    : text(input?.pattern);
  const metadata = input?.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const detail = [pattern, text(metadata.command), text(metadata.description), text(metadata.path), text(metadata.url)].find(value => value);
  return (detail ? `${type}: ${detail}` : `opencode asks to use ${type}.`).slice(0, 2000);
}

function toolOutput(state) {
  if (!state || typeof state !== "object") return "";
  const output = state.output ?? state.metadata?.output ?? state.result ?? "";
  const value = typeof output === "string" ? output : JSON.stringify(output ?? "");
  return value.length > MAX_TOOL_OUTPUT ? value.slice(0, MAX_TOOL_OUTPUT) : value;
}

function blocksFor(message) {
  const blocks = [];
  for (const id of message.partOrder) {
    const part = message.parts.get(id);
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string" && part.text.length) {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "tool" && typeof part.callID === "string") {
      blocks.push({ type: "tool_use", id: part.callID, name: text(part.tool) || "tool", input: part.state?.input ?? {} });
    }
  }
  return blocks;
}

function toolResults(message) {
  const results = [];
  for (const id of message.partOrder) {
    const part = message.parts.get(id);
    if (!part || part.type !== "tool" || typeof part.callID !== "string") continue;
    const status = part.state?.status;
    if (status !== "completed" && status !== "error") continue;
    results.push({ type: "tool_result", tool_use_id: part.callID, content: toolOutput(part.state), is_error: status === "error" });
  }
  return results;
}

function linesFor(session) {
  const messages = session.order
    .map(id => session.messages.get(id))
    .filter(Boolean)
    .sort((a, b) => (a.info?.time?.created ?? 0) - (b.info?.time?.created ?? 0) || String(a.info?.id).localeCompare(String(b.info?.id)));
  const lines = [];
  let seq = 0;
  const emit = (type, data, created) => {
    lines.push(JSON.stringify({ seq: seq++, time: new Date(created || Date.now()).toISOString(), type, data }));
  };
  for (const message of messages) {
    const info = message.info ?? {};
    if (info.role === "user") {
      const blocks = blocksFor(message);
      if (blocks.length) emit("user/message", { source: "user", message: { role: "user", content: blocks } }, info.time?.created);
    } else if (info.role === "assistant") {
      const complete = Boolean(info.time?.completed || info.finish);
      const blocks = blocksFor(message).filter(block => complete || block.type !== "text");
      const data = { stop_reason: STOP_REASONS[info.finish] || info.finish || "end_turn", message: { role: "assistant", content: blocks } };
      if (info.tokens && (typeof info.tokens.input === "number" || typeof info.tokens.output === "number")) {
        data.usage = { input_tokens: info.tokens.input ?? 0, output_tokens: info.tokens.output ?? 0 };
      }
      if (blocks.length) emit("assistant/message", data, info.time?.created);
      const results = toolResults(message);
      if (results.length) emit("tool/results", { message: { role: "user", content: results } }, info.time?.updated ?? info.time?.created);
    }
  }
  return lines;
}

export const PhrenTranscriptPlugin = async () => {
  const sessions = new Map();
  const timers = new Map();
  const written = new Map();
  const pendingApprovals = new Set();

  const sessionState = sessionID => {
    let state = sessions.get(sessionID);
    if (!state) { state = { messages: new Map(), order: [], idle: false }; sessions.set(sessionID, state); }
    return state;
  };

  const messageState = (sessionID, messageID) => {
    const state = sessionState(sessionID);
    let message = state.messages.get(messageID);
    if (!message) { message = { info: { id: messageID }, parts: new Map(), partOrder: [] }; state.messages.set(messageID, message); state.order.push(messageID); }
    return message;
  };

  const flush = sessionID => {
    const state = sessions.get(sessionID);
    if (!state) return;
    const body = linesFor(state);
    const content = body.length ? body.join("\n") + "\n" : "";
    const directory = path.join(storeRoot(), ".runtime", "sessions");
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `opencode-${sessionID}.events.jsonl`);
    const messages = state.order.map(id => state.messages.get(id));
    const latest = messages.at(-1), info = latest?.info;
    const user = messages.findLast(message => message.info?.role === "user");
    const preview = !state.idle && info?.role === "assistant" && !info.time?.completed && !info.finish
      ? blocksFor(latest).filter(block => block.type === "text").map(block => block.text).join("\n").slice(0, 32_768) : "";
    if (preview && user?.info.time?.created) writeJsonAtomic(file + ".preview.json", {
      turnStartedAt: new Date(user.info.time.created).toISOString(), text: preview,
    });
    else removeFile(file + ".preview.json");
    if (written.get(sessionID) === content) return;
    const staging = `${file}.${process.pid}.tmp`;
    writeFileSync(staging, content, { mode: 0o600 });
    renameSync(staging, file);
    written.set(sessionID, content);
  };

  const schedule = sessionID => {
    if (!sessionID || timers.has(sessionID)) return;
    timers.set(sessionID, setTimeout(() => {
      timers.delete(sessionID);
      try { flush(sessionID); } catch {}
    }, FLUSH_MS));
  };

  const rememberInfo = (sessionID, info) => {
    if (!info || typeof info.id !== "string") return;
    const message = messageState(sessionID, info.id);
    message.info = { ...message.info, ...info };
    if (info.role === "user") sessionState(sessionID).idle = false;
    schedule(sessionID);
  };

  const rememberPart = (sessionID, messageID, part) => {
    if (!part || typeof part.id !== "string" || typeof messageID !== "string") return;
    const message = messageState(sessionID, messageID);
    if (!message.parts.has(part.id)) message.partOrder.push(part.id);
    message.parts.set(part.id, part);
    schedule(sessionID);
  };

  return {
    "chat.message": async (input, output) => {
      if (!OPENCODE_SESSION.test(text(input?.sessionID)) || !output?.message) return;
      rememberInfo(input.sessionID, output.message);
      for (const part of output.parts ?? []) rememberPart(input.sessionID, output.message.id, part);
    },
    "permission.ask": async (input, output) => {
      // A fan-out worker runs headless in its own worktree with nobody watching
      // the phone's approval queue, so edits, commands and fetches inside that
      // worktree are granted here and anything else is refused outright rather
      // than waiting 50 seconds for an answer that never comes.
      if (process.env.PHREN_FANOUT_JOB) {
        if (fanoutAllowed(input)) { setStatus(output, "allow"); return; }
        setStatus(output, "deny");
        // A denied permission aborts the turn; record what was refused so the
        // Hook can report the worker as blocked rather than finished.
        writeBlocked(input);
        return;
      }
      let request, answer, pendingSession;
      try {
        const sessionID = text(input?.sessionID), id = text(input?.id);
        if (!OPENCODE_SESSION.test(sessionID) || !id) { setStatus(output, "ask"); return; }
        // A second request for this session belongs in the terminal until
        // the existing phone request has finished.
        if (pendingApprovals.has(sessionID)) { setStatus(output, "ask"); return; }
        pendingApprovals.add(sessionID);
        pendingSession = sessionID;
        const paths = approvalPaths(sessionID);
        request = paths.request; answer = paths.answer;
        mkdirSync(approvalDirectory(), { recursive: true });
        removeFile(answer);
        const created = Date.now();
        writeJsonAtomic(request, { id, sessionID, type: text(input.type) || "action",
          title: text(input.title) || `Allow ${text(input.type) || "action"}?`, message: permissionMessage(input),
          createdAt: new Date(created).toISOString(), expiresAt: new Date(created + APPROVAL_DEADLINE_MS).toISOString() });
        const deadline = created + APPROVAL_DEADLINE_MS;
        let decision;
        while (Date.now() < deadline) {
          await sleep(APPROVAL_POLL_MS);
          try {
            const info = lstatSync(answer);
            if (!info.isFile() || info.size > 65_536) continue;
            const value = JSON.parse(readFileSync(answer, "utf8"));
            if (value && value.id === id) { decision = value.decision; break; }
          } catch {}
        }
        setStatus(output, decision === "approve" ? "allow" : decision === "deny" ? "deny" : "ask");
      } catch {
        setStatus(output, "ask");
      } finally {
        if (answer) removeFile(answer);
        if (request) removeFile(request);
        if (pendingSession) pendingApprovals.delete(pendingSession);
      }
    },
    event: async ({ event }) => {
      const properties = event?.properties ?? {};
      const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : properties.info?.sessionID ?? properties.part?.sessionID;
      if (!OPENCODE_SESSION.test(text(sessionID))) return;
      if (event.type === "message.updated") rememberInfo(sessionID, properties.info);
      else if (event.type === "message.part.updated") rememberPart(sessionID, properties.part?.messageID, properties.part);
      else if (event.type === "message.part.delta" && properties.field === "text" && typeof properties.delta === "string") {
        const message = messageState(sessionID, properties.messageID);
        const part = message.parts.get(properties.partID);
        if (part?.type === "text") rememberPart(sessionID, properties.messageID, { ...part, text: text(part.text) + properties.delta });
      }
      else if (event.type === "message.removed") {
        const state = sessions.get(sessionID);
        if (state && typeof properties.messageID === "string") {
          state.messages.delete(properties.messageID);
          state.order = state.order.filter(id => id !== properties.messageID);
          schedule(sessionID);
        }
      } else if (event.type === "session.idle" || event.type === "session.error") {
        sessionState(sessionID).idle = true;
        flush(sessionID);
      } else if (event.type === "session.status" && properties.status?.type === "busy") sessionState(sessionID).idle = false;
    },
  };
};
