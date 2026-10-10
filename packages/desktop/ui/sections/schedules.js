// Schedules: every scheduled prompt across computers with its next run, last
// result, Run now, history and editor, plus a "Tonight" strip of the next
// runs. Ports the phone's Schedules screen (Features/Schedules) and the Hook's
// schedule-format.ts: the five timing forms, next-run maths, the small
// schedules.yaml surface and the store compare-and-swap write.
import { hookGet, hookPost } from "../api.js";
import { sectionHandle, showSection } from "../shell/sections.js";
import { store } from "../shell/store.js";

const CSS_HREF = "./sections/schedules.css";
const MAX_NAME = 80;
const MAX_PROMPT = 8000;
const HARNESSES = ["claude", "codex", "opencode", "copilot"];
const HARNESS_TITLE = { claude: "Claude", codex: "Codex", opencode: "OpenCode", copilot: "Copilot" };
const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]; // cron index = getDay()
const SHORT_DAY = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const EVERY_KINDS = ["interval", "daily", "weekly", "once", "cron"];

function ensureCss() {
  if (document.querySelector("link[data-sch-css]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  link.dataset.schCss = "1";
  document.head.append(link);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const pad2 = (n) => String(n).padStart(2, "0");
const two = (n) => pad2(n);
const timeText = (h, m) => `${two(h)}:${two(m)}`;

/** Interval text ("30m", "6h", "2d") for a minute count. */
function intervalText(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function intervalMilliseconds(value) {
  const match = /^(\d+)(m|h|d)$/.exec(value ?? "");
  if (!match || Number(match[1]) < 1) return null;
  const unit = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  const ms = Number(match[1]) * unit;
  return Number.isSafeInteger(ms) ? ms : null;
}

/** A wall-clock "YYYY-MM-DDTHH:mm:ss" in local time, or null. */
function localDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value ?? "")) return null;
  const p = value.match(/\d+/g).map(Number);
  const d = new Date(p[0], p[1] - 1, p[2], p[3], p[4], p[5]);
  return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2]
    && d.getHours() === p[3] && d.getMinutes() === p[4] && d.getSeconds() === p[5] ? d : null;
}

function onceText(date) {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** The timing in words, matching the phone's ScheduleWords.describe. */
function describe(schedule) {
  switch (schedule.every) {
    case "interval": {
      const ms = intervalMilliseconds(schedule.interval);
      if (ms === null) return `Every ${schedule.interval ?? "?"}`;
      return `Every ${intervalText(Math.round(ms / 60_000))}`;
    }
    case "daily": return `Daily at ${schedule.at ?? ""}`;
    case "weekly": {
      const days = schedule.days ?? [];
      const set = new Set(days);
      let prefix;
      if (set.size === 5 && ["mon", "tue", "wed", "thu", "fri"].every((d) => set.has(d))) prefix = "Weekdays";
      else if (set.size === 2 && set.has("sat") && set.has("sun")) prefix = "Weekends";
      else prefix = DAY_ORDER.filter((d) => set.has(d)).map((d) => SHORT_DAY[d]).join(", ");
      return `${prefix} at ${schedule.at ?? ""}`;
    }
    case "once": {
      const date = localDate(schedule.once);
      if (!date) return `Once ${schedule.once ?? ""}`;
      return `Once, ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${timeText(date.getHours(), date.getMinutes())}`;
    }
    case "cron": return `Cron ${schedule.cron ?? ""}`;
    default: return String(schedule.every ?? "");
  }
}

/** "5m ago" / "in 5m" / "tomorrow 09:00" / "in 3d", the phone's ScheduleWords.relative. */
function relative(date, now = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "";
  if (date <= now) {
    const seconds = Math.max(0, (now - date) / 1000);
    if (seconds < 45) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, tomorrow)) return `tomorrow ${timeText(date.getHours(), date.getMinutes())}`;
  const seconds = (date - now) / 1000;
  if (seconds < 3600) return `in ${Math.max(1, Math.ceil(seconds / 60))}m`;
  if (sameDay(date, now)) return `in ${Math.max(1, Math.ceil(seconds / 3600))}h`;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.max(1, Math.round((end - start) / 86_400_000));
  return `in ${days}d`;
}

// ---- next run (schedule-format.ts nextRun) --------------------------------

function parseCronField(text, minimum, maximum, sunday = false) {
  const values = new Set();
  const wildcard = text === "*" || text.startsWith("*/");
  for (const part of text.split(",")) {
    const [rangeText, stepText] = part.split("/");
    if (part.split("/").length > 2 || (stepText !== undefined && !/^\d+$/.test(stepText))) return null;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return null;
    let start, end;
    if (rangeText === "*") { start = minimum; end = maximum; }
    else if (/^\d+$/.test(rangeText)) start = end = Number(rangeText);
    else {
      const range = /^(\d+)-(\d+)$/.exec(rangeText);
      if (!range) return null;
      start = Number(range[1]); end = Number(range[2]);
    }
    if (start < minimum || end > maximum || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(sunday && value === 7 ? 0 : value);
  }
  return { values: [...values].sort((a, b) => a - b), wildcard };
}

function parseCron(value) {
  const fields = String(value ?? "").trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseCronField(fields[0], 0, 59), hour = parseCronField(fields[1], 0, 23);
  const day = parseCronField(fields[2], 1, 31), month = parseCronField(fields[3], 1, 12);
  const weekday = parseCronField(fields[4], 0, 7, true);
  if (!minute || !hour || !day || !month || !weekday) return null;
  return { minute, hour, day, month, weekday };
}

function cronDayMatches(cron, date) {
  const day = cron.day.values.includes(date.getDate()), weekday = cron.weekday.values.includes(date.getDay());
  if (cron.day.wildcard && cron.weekday.wildcard) return true;
  if (cron.day.wildcard) return weekday;
  if (cron.weekday.wildcard) return day;
  return day || weekday;
}

function nextCron(schedule, after) {
  const cron = parseCron(schedule.cron);
  if (!cron) return null;
  const day = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  for (let offset = 0; offset < 366 * 8; offset++) {
    const date = new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset);
    if (!cron.month.values.includes(date.getMonth() + 1) || !cronDayMatches(cron, date)) continue;
    for (const hour of cron.hour.values) for (const minute of cron.minute.values) {
      const candidate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute);
      if (candidate.getHours() === hour && candidate.getMinutes() === minute && candidate > after) return candidate;
    }
  }
  return null;
}

function nextDailyOrWeekly(schedule, after) {
  const parts = String(schedule.at ?? "").split(":").map(Number);
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  const [hour, minute] = parts;
  const allowed = schedule.every === "weekly" ? new Set((schedule.days ?? []).map((day) => WEEKDAYS.indexOf(day))) : undefined;
  for (let offset = 0; offset < 370; offset++) {
    const candidate = new Date(after.getFullYear(), after.getMonth(), after.getDate() + offset, hour, minute);
    if (candidate.getHours() !== hour || candidate.getMinutes() !== minute || candidate <= after) continue;
    if (!allowed || allowed.has(candidate.getDay())) return candidate;
  }
  return null;
}

/** The next firing: once needs no prior run; intervals start at the last run;
 *  calendar forms use local time. Matches the Hook's nextRun. */
function nextRun(schedule, lastRun) {
  if (schedule.every === "once") return lastRun ? null : localDate(schedule.once);
  const after = new Date(lastRun?.startedAt ?? schedule.createdAt);
  if (!Number.isFinite(after.getTime())) return null;
  if (schedule.every === "interval") {
    const ms = intervalMilliseconds(schedule.interval);
    return ms === null ? null : new Date(after.getTime() + ms);
  }
  if (schedule.every === "cron") return nextCron(schedule, after);
  if (schedule.every === "daily" || schedule.every === "weekly") return nextDailyOrWeekly(schedule, after);
  return null;
}

// ---- validation (schedule-format.ts parseSchedule) -------------------------

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const PLAIN = /[\x00-\x08\x0b-\x1f\x7f]/;

function singleLine(value, max) {
  return typeof value === "string" && value.length >= 1 && value.length <= max
    && value.trim().length > 0 && !CONTROL.test(value);
}

function isoInstant(value) {
  return typeof value === "string" && ISO_TS.test(value) && Number.isFinite(Date.parse(value));
}

/** The live timing-form check the editor shows; null when valid. */
function timingError(form) {
  switch (form.every) {
    case "interval": {
      const ms = intervalMilliseconds(form.interval);
      if (ms === null) return "Interval must look like 30m, 6h, or 2d.";
      if (ms / 60_000 < 5) return "Interval must be at least 5 minutes.";
      return null;
    }
    case "daily":
      return CLOCK.test(form.at ?? "") ? null : "Enter a time like 02:00.";
    case "weekly":
      if (!(form.days ?? []).length) return "Pick at least one day.";
      return CLOCK.test(form.at ?? "") ? null : "Enter a time like 02:00.";
    case "once":
      return localDate(form.once) ? null : "Enter a date and time.";
    case "cron":
      return parseCron(form.cron) ? null : "Not a valid cron line (five fields).";
    default:
      return "Choose a timing form.";
  }
}

/** Validate a whole schedule the way the Hook's parseSchedule does. */
function validateSchedule(schedule) {
  if (!/^[a-f0-9]{8}$/.test(schedule.id ?? "")) return "Invalid schedule id.";
  if (!singleLine(schedule.name, MAX_NAME)) return "Name must be 1 to 80 characters.";
  if (typeof schedule.enabled !== "boolean") return "Enabled must be true or false.";
  if (!singleLine(schedule.computer, 200)) return "Choose a computer.";
  if (schedule.computer.trim().toLowerCase().replace(/\.local$/, "") === "any") return 'Schedule computer "any" is not supported.';
  if (!HARNESSES.includes(schedule.harness)) return "Choose a harness.";
  if (!EVERY_KINDS.includes(schedule.every)) return "Choose a timing form.";
  if (typeof schedule.prompt !== "string" || schedule.prompt.length < 1 || schedule.prompt.length > MAX_PROMPT
    || PLAIN.test(schedule.prompt)) return `Prompt must be 1 to ${MAX_PROMPT} characters.`;
  if (!isoInstant(schedule.createdAt) || !isoInstant(schedule.updatedAt)) return "Invalid schedule timestamps.";
  if (schedule.model !== undefined && !singleLine(schedule.model, 200)) return "Invalid model id.";
  if (schedule.every === "daily" || schedule.every === "weekly") {
    if (!CLOCK.test(schedule.at ?? "")) return "Enter a time like 02:00.";
  }
  if (schedule.every === "weekly") {
    const days = schedule.days ?? [];
    if (!days.length || days.length > 7 || days.some((d) => !WEEKDAYS.includes(d))) return "Pick at least one day.";
  }
  if (schedule.every === "interval") {
    if (!singleLine(schedule.interval, 32)) return "Enter an interval.";
    const ms = intervalMilliseconds(schedule.interval);
    if (ms === null || ms / 60_000 < 5) return "Interval must be at least 5 minutes.";
  }
  if (schedule.every === "once" && !localDate(schedule.once)) return "Enter a valid date and time.";
  if (schedule.every === "cron") {
    if (!singleLine(schedule.cron, 200) || !parseCron(schedule.cron)) return "Not a valid cron line.";
  }
  return null;
}

// ---- the small schedules.yaml surface (SchedulesFile.swift) ----------------

const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);

function quoted(value) {
  const escaped = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function yamlScalar(value) {
  const safe = /^[A-Za-z0-9][A-Za-z0-9._/@ -]*$/.test(value)
    && !RESERVED.has(value.toLowerCase()) && !/^[0-9]+$/.test(value);
  return safe ? value : quoted(value);
}

function indentOf(line) {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].length : 0;
}

function topLevelKey(line) {
  if (indentOf(line) !== 0) return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const colon = trimmed.indexOf(":");
  return colon < 0 ? null : trimmed.slice(0, colon).trim();
}

function mapping(line) {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const key = line.slice(0, colon).trim();
  return key ? { key, value: line.slice(colon + 1).trim() } : null;
}

/** The `schedules:` block: its header line and the first top-level line after it. */
function schedulesRange(lines) {
  const start = lines.findIndex((line) => topLevelKey(line) === "schedules");
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length) {
    const trimmed = lines[end].trim();
    if (trimmed && !trimmed.startsWith("#") && indentOf(lines[end]) === 0) break;
    end++;
  }
  return { start, end };
}

/** Each entry's line range and its id (on the "- " line or a following "id:"). */
function entryRanges(lines, range) {
  const starts = [];
  for (let i = range.start + 1; i < range.end; i++) {
    const trimmed = lines[i].trim();
    if (trimmed && !trimmed.startsWith("#") && indentOf(lines[i]) > 0 && trimmed.startsWith("- ")) starts.push(i);
  }
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : range.end;
    let id = null;
    for (let i = start; i < end; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const content = trimmed.startsWith("- ") ? trimmed.slice(2) : trimmed;
      const pair = mapping(content);
      if (pair && pair.key === "id") { id = pair.value.replace(/^["']|["']$/g, ""); break; }
    }
    return { start, end, id };
  });
}

function hasTopLevelKey(key, lines) {
  return lines.some((line) => topLevelKey(line) === key);
}

function appendPrompt(prompt, lines) {
  const trailing = (prompt.match(/\n*$/) ?? [""])[0].length;
  lines.push(`    prompt: ${trailing === 0 ? "|-" : trailing === 1 ? "|" : "|+"}`);
  const body = prompt.split("\n");
  if (prompt.endsWith("\n")) body.pop();
  for (const line of body) lines.push(`      ${line}`);
}

function renderEntry(schedule) {
  const lines = [
    `  - id: ${yamlScalar(schedule.id)}`,
    `    name: ${yamlScalar(schedule.name)}`,
    `    enabled: ${schedule.enabled ? "true" : "false"}`,
    `    computer: ${yamlScalar(schedule.computer)}`,
    `    harness: ${schedule.harness}`,
  ];
  if (schedule.model) lines.push(`    model: ${yamlScalar(schedule.model)}`);
  if (schedule.account) lines.push(`    account: ${yamlScalar(schedule.account)}`);
  if (Array.isArray(schedule.projects) && schedule.projects.length) {
    lines.push(`    projects: [${schedule.projects.map(yamlScalar).join(", ")}]`);
  }
  const notify = schedule.notify ?? ["finish", "failure"];
  lines.push(`    notify: [${["start", "finish", "failure"].filter((kind) => notify.includes(kind)).join(", ")}]`);
  lines.push(`    every: ${schedule.every}`);
  if (schedule.every === "interval") lines.push(`    interval: ${schedule.interval}`);
  else if (schedule.every === "daily") lines.push(`    at: ${quoted(schedule.at)}`);
  else if (schedule.every === "weekly") {
    lines.push(`    at: ${quoted(schedule.at)}`);
    lines.push(`    days: [${DAY_ORDER.filter((day) => (schedule.days ?? []).includes(day)).join(", ")}]`);
  } else if (schedule.every === "once") lines.push(`    once: ${yamlScalar(schedule.once)}`);
  else if (schedule.every === "cron") lines.push(`    cron: ${quoted(schedule.cron)}`);
  appendPrompt(schedule.prompt, lines);
  lines.push(`    createdAt: ${yamlScalar(schedule.createdAt)}`);
  lines.push(`    updatedAt: ${yamlScalar(schedule.updatedAt)}`);
  return lines;
}

function renderScheduleText(schedules) {
  if (!schedules.length) return ["schedules: []"];
  return ["schedules:", ...schedules.flatMap((schedule) => renderEntry(schedule))];
}

function splitDocument(original) {
  const lines = (original ?? "").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Replace one entry's block, leaving every other entry and comment in place.
 *  `schedule` is null to remove the entry with `id`. */
function editEntryText(original, id, schedule) {
  const lines = splitDocument(original);
  const range = schedulesRange(lines);
  if (!range) {
    if (!schedule) return original;
    if (!hasTopLevelKey("version", lines)) lines.unshift("version: 1");
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length) lines.push("");
    lines.push(...renderScheduleText([schedule]));
    return lines.join("\n") + "\n";
  }
  const entries = entryRanges(lines, range);
  const existing = entries.find((entry) => entry.id === id);
  if (!schedule) {
    if (!existing) return original;
    lines.splice(existing.start, existing.end - existing.start);
    const after = schedulesRange(lines);
    if (after && !entryRanges(lines, after).length) lines.splice(after.start, after.end - after.start, "schedules: []");
    return lines.join("\n") + "\n";
  }
  if (existing) {
    let end = existing.end;
    const trailing = [];
    while (end > existing.start && lines[end - 1].trim() === "") { trailing.unshift(lines[end - 1]); end--; }
    lines.splice(existing.start, end - existing.start, ...renderEntry(schedule), ...trailing);
  } else if (lines[range.start].replace(/\s+/g, " ").trim() === "schedules: []") {
    lines.splice(range.start, range.end - range.start, ...renderScheduleText([schedule]));
  } else {
    lines.splice(range.end, 0, ...renderEntry(schedule));
  }
  return lines.join("\n") + "\n";
}

// ---- mount ----------------------------------------------------------------

const POLL_MS = 30_000;
const TONIGHT_HOURS = 24;
const TONIGHT_COUNT = 6;

function canonical(name) {
  const value = String(name ?? "").trim().toLowerCase();
  return value.endsWith(".local") ? value.slice(0, -6) : value;
}

export function mountSchedules(root) {
  ensureCss();
  root.innerHTML = `
    <div class="sch">
      <div class="sch-head">
        <h1 class="sch-title">Schedules</h1>
        <span class="sch-note" data-status></span>
        <span class="sch-spacer"></span>
        <button class="sch-btn" data-refresh>Refresh</button>
        <button class="sch-btn primary" data-new>New schedule</button>
      </div>
      <div class="sch-error" data-error hidden></div>
      <section class="sch-tonight" data-tonight hidden>
        <h2 class="section-label">Tonight <span class="sch-count" data-tonight-count></span></h2>
        <div class="sch-tonight-strip" data-tonight-strip></div>
      </section>
      <div class="sch-list" data-list></div>
    </div>`;

  const statusEl = root.querySelector("[data-status]");
  const errorEl = root.querySelector("[data-error]");
  const tonightEl = root.querySelector("[data-tonight]");
  const tonightStrip = root.querySelector("[data-tonight-strip]");
  const tonightCount = root.querySelector("[data-tonight-count]");
  const listEl = root.querySelector("[data-list]");

  const state = {
    entries: new Map(),
    online: [],
    error: "",
    visible: false,
    loading: false,
    pending: false,
    loadedOnce: false,
  };

  function computers() { return store.merged?.computers ?? []; }

  function ownerName(schedule) { return schedule.computer; }

  function setStatus(text) { statusEl.textContent = text; }

  function setError(text) {
    state.error = text ?? "";
    errorEl.hidden = !state.error;
    errorEl.textContent = state.error;
  }

  // ---- data ------------------------------------------------------------

  async function loadAll() {
    if (state.loading) { state.pending = true; return; }
    state.loading = true;
    setStatus("Loading…");
    const online = computers().filter((c) => c.state === "online").map((c) => c.computer);
    state.online = online;
    const results = await Promise.all(online.map(async (computer) => {
      try {
        const body = await hookPost(computer, "/v1/schedules", {});
        return { computer, schedules: Array.isArray(body.schedules) ? body.schedules : [], error: null };
      } catch (err) {
        return { computer, schedules: [], error: err };
      }
    }));

    const entries = new Map();
    for (const result of results) {
      for (const schedule of result.schedules) {
        const key = `${schedule.project}\u001f${schedule.id}`;
        let entry = entries.get(key);
        if (!entry) {
          entry = { key, project: schedule.project, id: schedule.id, schedule, runtime: null, ownerOnline: false, known: false };
          entries.set(key, entry);
        }
        if (schedule.owned) {
          entry.schedule = schedule;
          entry.runtime = { nextRun: schedule.nextRun, lastRun: schedule.lastRun, lastRuns: schedule.lastRuns, running: schedule.running };
        }
      }
    }
    // A schedule names its computer by the Hook's own name ("omarchy"), which can
    // differ from the desktop's name for it ("Linuxbox"): match either, and trust
    // the Hook that says it owns the schedule.
    const aliases = (c) => [c.computer, c.overview?.phren?.computer?.name].filter(Boolean).map(canonical);
    const knownNames = new Set(computers().flatMap(aliases));
    const onlineNames = new Set(computers().filter((c) => c.state === "online").flatMap(aliases));
    const owners = new Set(results.flatMap((r) => r.schedules.filter((sch) => sch.owned).map((sch) => `${sch.project}\u001f${sch.id}`)));
    for (const entry of entries.values()) {
      const owner = canonical(ownerName(entry.schedule));
      entry.ownerOnline = owners.has(entry.key) || onlineNames.has(owner);
      entry.known = entry.ownerOnline || knownNames.has(owner);
    }

    state.entries = entries;
    state.loading = false;
    state.loadedOnce = true;
    const failures = results.filter((result) => result.error);
    if (!entries.size && online.length && failures.length === online.length) {
      const first = failures[0].error;
      setError(first?.status === 404
        ? `Schedules need the schedules module on ${failures[0].computer}.`
        : `Could not load schedules: ${first?.message ?? first}`);
    } else {
      setError("");
    }
    setStatus(online.length ? `${online.length} computer${online.length === 1 ? "" : "s"} online` : "No computers online");
    render();
    if (state.pending) { state.pending = false; void loadAll(); }
  }

  // ---- render ----------------------------------------------------------

  function effectiveNext(entry) {
    if (entry.runtime?.nextRun) return new Date(entry.runtime.nextRun);
    if (entry.runtime) return nextRun(entry.schedule, entry.runtime.lastRun);
    return nextRun(entry.schedule, null);
  }

  function render() {
    renderTonight();
    renderList();
  }

  function renderTonight() {
    const now = new Date();
    const horizon = now.getTime() + TONIGHT_HOURS * 3_600_000;
    const upcoming = [...state.entries.values()]
      .filter((entry) => entry.schedule.enabled && entry.ownerOnline)
      .map((entry) => ({ entry, at: effectiveNext(entry) }))
      .filter(({ at }) => at && at.getTime() > now.getTime() && at.getTime() <= horizon)
      .sort((a, b) => a.at - b.at)
      .slice(0, TONIGHT_COUNT);
    tonightEl.hidden = upcoming.length === 0;
    tonightCount.textContent = upcoming.length ? String(upcoming.length) : "";
    tonightStrip.replaceChildren(...upcoming.map(({ entry, at }) => {
      const card = el("div", "sch-tonight-card");
      card.append(el("div", "sch-tonight-time", timeText(at.getHours(), at.getMinutes())));
      card.append(el("div", "sch-tonight-name", entry.schedule.name));
      card.append(el("div", "sch-tonight-host", `${entry.project} · ${entry.schedule.computer}`));
      return card;
    }));
  }

  function sortEntries(values) {
    return [...values].sort((a, b) => {
      const aNext = a.schedule.enabled ? effectiveNext(a) : null;
      const bNext = b.schedule.enabled ? effectiveNext(b) : null;
      if (aNext && bNext && aNext.getTime() !== bNext.getTime()) return aNext - bNext;
      if (Boolean(aNext) !== Boolean(bNext)) return aNext ? -1 : 1;
      return a.schedule.name.localeCompare(b.schedule.name);
    });
  }

  function renderList() {
    if (!state.loadedOnce) { listEl.replaceChildren(el("div", "sch-empty", "Loading schedules…")); return; }
    if (!state.entries.size) {
      listEl.replaceChildren(el("div", "sch-empty", "No schedules yet. Create one with New schedule."));
      return;
    }
    const byComputer = new Map();
    for (const entry of state.entries.values()) {
      const computer = ownerName(entry.schedule);
      if (!byComputer.has(computer)) byComputer.set(computer, new Map());
      const projects = byComputer.get(computer);
      if (!projects.has(entry.project)) projects.set(entry.project, []);
      projects.get(entry.project).push(entry);
    }
    const sections = [];
    for (const computer of [...byComputer.keys()].sort((a, b) => a.localeCompare(b))) {
      const group = el("section", "sch-computer");
      const label = el("h2", "sch-computer-label");
      label.append(document.createTextNode(computer));
      label.append(el("span", "sch-count", String([...byComputer.get(computer).values()].flat().length)));
      group.append(label);
      for (const project of [...byComputer.get(computer).keys()].sort((a, b) => a.localeCompare(b))) {
        const entries = sortEntries(byComputer.get(computer).get(project));
        const projectLabel = el("div", "sch-project-label");
        projectLabel.append(document.createTextNode(project));
        projectLabel.append(el("span", "sch-count", String(entries.length)));
        group.append(projectLabel);
        const rows = el("div", "sch-rows");
        for (const entry of entries) rows.append(scheduleRow(entry));
        group.append(rows);
      }
      sections.push(group);
    }
    listEl.replaceChildren(...sections);
  }

  // ---- row -------------------------------------------------------------

  function statusClass(entry) {
    const runtime = entry.runtime;
    if (runtime?.running) return "running";
    const status = runtime?.lastRun?.status;
    if (status === "failed") return "failed";
    if (status === "blocked" || status === "needs-you") return "blocked";
    if (!entry.schedule.enabled) return "";
    if (status === "finished") return "ok";
    return "";
  }

  function nextText(entry) {
    if (!entry.known) return { text: "unknown computer", offline: false };
    if (!entry.ownerOnline) return { text: `${entry.schedule.computer} offline`, offline: true };
    if (!entry.schedule.enabled) return { text: "paused", offline: false };
    const at = effectiveNext(entry);
    if (entry.schedule.every === "once" && entry.runtime?.lastRun && !at) return { text: "done", offline: false };
    if (at) return { text: relative(at), offline: false };
    if (entry.schedule.every === "once") return { text: "done", offline: false };
    return { text: "paused", offline: false };
  }

  function chipFor(entry) {
    const runtime = entry.runtime;
    if (runtime?.running) return { cls: "running", label: "running" };
    const status = runtime?.lastRun?.status;
    if (status === "failed") return { cls: "failed", label: "failed" };
    if (status === "blocked") return { cls: "blocked", label: "blocked" };
    if (status === "needs-you") return { cls: "needs", label: "needs you" };
    if (status === "finished") return { cls: "ok", label: "ok" };
    if (status === "skipped") return { cls: "", label: "skipped" };
    return null;
  }

  function actionBtn(label, onClick) {
    const button = el("button", "sch-action", label);
    button.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(); });
    return button;
  }

  function scheduleRow(entry) {
    const schedule = entry.schedule;
    const row = el("div", "sch-row");
    row.append(el("span", `sch-dot ${statusClass(entry)}`));
    const main = el("div", "sch-row-main");
    main.append(el("div", "sch-row-title", schedule.name));
    const sub = el("div", "sch-row-sub");
    sub.append(el("span", "sch-timing", describe(schedule)));
    sub.append(el("span", "sch-harness", HARNESS_TITLE[schedule.harness] ?? schedule.harness));
    if (schedule.model) sub.append(el("span", "sch-model", schedule.model));
    main.append(sub);
    row.append(main);

    const meta = el("div", "sch-row-meta");
    const next = nextText(entry);
    meta.append(el("span", `sch-next${next.offline ? " offline" : ""}`, next.text));
    const chip = chipFor(entry);
    if (chip) {
      meta.append(el("span", `sch-chip ${chip.cls}`, chip.label));
      const when = entry.runtime?.lastRun?.finishedAt ?? entry.runtime?.lastRun?.startedAt;
      if (when && !entry.runtime?.running) meta.append(el("span", "sch-age", relative(new Date(when))));
    }
    row.append(meta);

    const actions = el("div", "sch-actions");
    const run = actionBtn("Run now", () => { void runNow(entry); });
    run.disabled = !entry.ownerOnline || Boolean(entry.runtime?.running);
    run.title = !entry.ownerOnline ? `${schedule.computer} is offline` : entry.runtime?.running ? "Already running" : "Run this schedule now";
    const history = actionBtn("History", () => openHistory(entry));
    history.disabled = !entry.ownerOnline;
    if (!entry.ownerOnline) history.title = `${schedule.computer} is offline`;
    const edit = actionBtn("Edit", () => openEditor(entry));
    const toggle = actionBtn(schedule.enabled ? "Pause" : "Resume", () => { void toggleEnabled(entry); });
    toggle.title = schedule.enabled ? "Disable this schedule" : "Enable this schedule";
    actions.append(run, history, edit, toggle);
    row.append(actions);
    return row;
  }

  // ---- actions ---------------------------------------------------------

  async function runNow(entry) {
    if (!entry.ownerOnline) return;
    setError("");
    try {
      await hookPost(ownerName(entry.schedule), "/v1/schedules/run",
        { project: entry.project, id: entry.id, expectedUpdatedAt: entry.schedule.updatedAt });
    } catch (err) {
      setError(err?.status === 409 ? (err.message || "This schedule is already running.") : (err?.message ?? String(err)));
    }
    await loadAll();
  }

  async function toggleEnabled(entry) {
    const next = { ...entry.schedule, enabled: !entry.schedule.enabled, updatedAt: new Date().toISOString() };
    if (await persistSchedule(entry.project, entry.id, next, ownerName(entry.schedule))) await loadAll();
  }

  function decodeBase64(content) {
    return new TextDecoder().decode(Uint8Array.from(atob(content), (c) => c.charCodeAt(0)));
  }

  function encodeBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function storeComputer(preferred) {
    const online = state.online;
    if (preferred) {
      const match = online.find((name) => canonical(name) === canonical(preferred));
      if (match) return match;
    }
    return online[0] ?? null;
  }

  /** Read the project's schedules.yaml from a computer's store, with its blob sha. */
  async function readScheduleFile(computer, project) {
    const path = `${project}/schedules.yaml`;
    const head = await hookGet(computer, "/v1/store/head");
    const tree = await hookGet(computer, "/v1/store/tree", { sha: head.sha });
    const item = (tree.tree ?? []).find((entry) => entry.path === path);
    if (!item) return { path, text: null, sha: null };
    const blob = await hookGet(computer, "/v1/store/blob", { sha: item.sha });
    return { path, text: decodeBase64(blob.content), sha: item.sha };
  }

  /** Write one schedule entry (or remove it) with compare-and-swap. */
  async function persistSchedule(project, id, schedule, preferred) {
    const computer = storeComputer(preferred);
    if (!computer) { setError("No computer is online to save schedules."); return false; }
    setError("");
    try {
      const file = await readScheduleFile(computer, project);
      const text = editEntryText(file.text, id, schedule);
      await hookPost(computer, "/v1/store/file", { path: file.path, content: encodeBase64(text), sha: file.sha });
      return true;
    } catch (err) {
      setError(err?.status === 409 ? "Schedules changed on another computer. Reopen to edit." : (err?.message ?? String(err)));
      return false;
    }
  }

  // ---- history drawer --------------------------------------------------

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const RUN_STATUS = { launched: "launched", running: "running", blocked: "blocked", finished: "finished", "needs-you": "needs you", failed: "failed", skipped: "skipped" };

  function startedText(date) {
    return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${timeText(date.getHours(), date.getMinutes())}`;
  }

  function durationText(run) {
    const start = new Date(run.startedAt);
    const live = ["running", "launched", "blocked"].includes(run.status);
    const end = run.finishedAt ? new Date(run.finishedAt) : live ? new Date() : start;
    const seconds = Math.max(0, Math.round((end - start) / 1000));
    const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60), rest = seconds % 60;
    if (hours > 0) return `${hours}h ${two(minutes)}m`;
    if (minutes > 0) return `${minutes}m ${two(rest)}s`;
    return `${rest}s`;
  }

  function runRail(status) {
    if (status === "finished") return "ok";
    if (status === "failed") return "failed";
    if (status === "blocked" || status === "needs-you") return "blocked";
    if (status === "running" || status === "launched") return "running";
    return "";
  }

  /** The overview session a run launched into, when one is present. */
  function runSession(run) {
    const launch = run.launch ?? {};
    if (launch.mode !== "herdr" || !launch.server || !launch.workspaceId || !launch.tabId || !launch.paneId) return null;
    return store.sessions().find(({ child }) => {
      const target = child.target;
      return target && target.server === launch.server && target.workspace === launch.workspaceId
        && target.tab === launch.tabId && target.pane === launch.paneId;
    }) ?? null;
  }

  function runRow(entry, run, close) {
    const rail = el("div", `sch-run-rail ${runRail(run.status)}`);
    const main = el("div", "sch-run-main");
    const top = el("div", "sch-run-top");
    top.append(el("span", "sch-run-when", startedText(new Date(run.startedAt))));
    top.append(el("span", "sch-run-duration", durationText(run)));
    main.append(top);
    const status = el("div", `sch-run-status ${runRail(run.status) === "failed" ? "failed" : run.status === "blocked" || run.status === "needs-you" ? "blocked" : ""}`);
    if (run.status === "blocked" && run.blockedStartupPrompt) status.textContent = `blocked: ${run.blockedStartupPrompt}`;
    else status.textContent = run.reason ? `${RUN_STATUS[run.status] ?? run.status}: ${run.reason}` : (RUN_STATUS[run.status] ?? run.status);
    main.append(status);
    if (run.notified !== undefined) {
      main.append(el("div", "sch-run-note", run.notified ? "notification delivered" : `not notified${run.notifyReason ? `: ${run.notifyReason}` : ""}`));
    }
    const match = runSession(run);
    if (match) {
      const open = el("button", "sch-run-open", "Open session");
      open.addEventListener("click", () => {
        close();
        showSection("agents");
        sectionHandle("agents")?.openSession(match.computer, match.child);
      });
      main.append(open);
    }
    const row = el("div", "sch-run");
    row.append(rail, main);
    return row;
  }

  async function openHistory(entry) {
    const overlay = el("div", "sch-overlay drawer");
    const drawer = el("div", "sch-drawer");
    const head = el("div", "sch-sheet-head");
    head.append(el("span", "sch-sheet-title", `History · ${entry.schedule.name}`));
    head.append(el("span", "sch-spacer"));
    const closeButton = el("button", "sch-btn", "Close");
    head.append(closeButton);
    drawer.append(head);
    const body = el("div", "sch-runs");
    drawer.append(body);
    overlay.append(drawer);
    root.append(overlay);
    const done = () => { overlay.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (ev) => { if (ev.key === "Escape") done(); };
    closeButton.addEventListener("click", done);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) done(); });
    document.addEventListener("keydown", onKey, true);
    body.append(el("div", "sch-empty", "Loading runs…"));
    try {
      const res = await hookPost(ownerName(entry.schedule), "/v1/schedules/history", { project: entry.project, id: entry.id, limit: 50 });
      const runs = Array.isArray(res.runs) ? res.runs : [];
      if (!runs.length) { body.replaceChildren(el("div", "sch-empty", "No runs yet")); return; }
      body.replaceChildren(...runs.map((run) => runRow(entry, run, done)));
    } catch (err) {
      body.replaceChildren(el("div", "sch-error", err?.message ?? String(err)));
    }
  }

  // ---- editor sheet ----------------------------------------------------

  function randomId(existing) {
    const ids = new Set(existing);
    for (;;) {
      const id = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
      if (!ids.has(id)) return id;
    }
  }

  function projectNames() {
    const set = new Set();
    for (const entry of state.entries.values()) set.add(entry.project);
    for (const row of store.sessions()) {
      const cwd = row.child.cwd;
      if (cwd) set.add(cwd.split("/").filter(Boolean).pop());
    }
    return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b));
  }

  function computerNames() {
    const set = new Set(computers().map((c) => c.computer));
    if (form.computer) set.add(form.computer);
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  function field(label, node) {
    const box = el("div", "sch-field");
    box.append(el("div", "sch-field-label", label));
    box.append(node);
    return box;
  }

  function input(attrs = {}) {
    const node = el("input", "sch-input");
    Object.assign(node, attrs);
    return node;
  }

  function select(options, value, onChange, { disabled = false } = {}) {
    const node = el("select", "sch-select");
    for (const option of options) {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      if (option.value === value) item.selected = true;
      node.append(item);
    }
    node.disabled = disabled;
    node.addEventListener("change", () => onChange(node.value));
    return node;
  }

  function segments(items, value, onPick) {
    const box = el("div", "sch-segments");
    for (const item of items) {
      const button = el("button", `sch-segment${item.value === value ? " selected" : ""}`, item.label);
      button.type = "button";
      button.addEventListener("click", () => onPick(item.value));
      box.append(button);
    }
    return box;
  }

  let form = null;

  function defaultForm(entry) {
    const schedule = entry?.schedule;
    const now = new Date();
    const once = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0);
    const base = {
      id: schedule?.id ?? randomId([...state.entries.values()].map((e) => e.id)),
      project: entry?.project ?? projectNames()[0] ?? "",
      name: schedule?.name ?? "",
      prompt: schedule?.prompt ?? "",
      computer: schedule?.computer ?? (state.online[0] ?? computers().find((c) => c.state === "online")?.computer ?? ""),
      harness: schedule?.harness ?? "claude",
      model: schedule?.model ?? "",
      account: schedule?.account,
      notify: schedule?.notify,
      projects: schedule?.projects,
      enabled: schedule?.enabled ?? true,
      every: schedule?.every ?? "daily",
      at: schedule?.at ?? "07:30",
      days: schedule?.days ? [...schedule.days] : ["mon", "tue", "wed", "thu", "fri"],
      interval: schedule?.interval ?? "6h",
      once: schedule?.once ?? onceText(once),
      cron: schedule?.cron ?? "0 7 * * 1-5",
      createdAt: schedule?.createdAt ?? now.toISOString(),
    };
    return base;
  }

  function openEditor(entry) {
    form = defaultForm(entry);
    const editing = Boolean(entry);
    const overlay = el("div", "sch-overlay sheet");
    const sheet = el("div", "sch-sheet");
    const head = el("div", "sch-sheet-head");
    head.append(el("span", "sch-sheet-title", editing ? "Edit schedule" : "New schedule"));
    head.append(el("span", "sch-spacer"));
    const cancel = el("button", "sch-btn", "Cancel");
    const save = el("button", "sch-btn primary", "Save");
    head.append(cancel, save);
    sheet.append(head);
    const body = el("div", "sch-sheet-body");
    sheet.append(body);
    overlay.append(sheet);
    root.append(overlay);

    const nameInput = input({ value: form.name, maxLength: MAX_NAME, placeholder: "Nightly test sweep" });
    nameInput.addEventListener("input", () => { form.name = nameInput.value; refresh(); });
    body.append(field("Name", nameInput));

    const promptInput = el("textarea", "sch-textarea");
    promptInput.value = form.prompt;
    promptInput.placeholder = "What should the agent do?";
    promptInput.addEventListener("input", () => { form.prompt = promptInput.value; refresh(); });
    body.append(field("Prompt", promptInput));

    const projects = projectNames();
    const projectControl = projects.length
      ? select(projects.map((p) => ({ value: p, label: p })), form.project,
        (value) => { form.project = value; refresh(); }, { disabled: editing })
      : input({ value: form.project, placeholder: "project name" });
    if (!projects.length) projectControl.addEventListener("input", () => { form.project = projectControl.value; refresh(); });
    const targets = el("div", "sch-fields-2");
    targets.append(field("Project", projectControl));
    targets.append(field("Computer", select(computerNames().map((c) => ({ value: c, label: c })), form.computer,
      (value) => { form.computer = value; refresh(); })));
    body.append(targets);

    const harnessRow = el("div", "sch-fields-2");
    harnessRow.append(field("Harness", select(HARNESSES.map((h) => ({ value: h, label: HARNESS_TITLE[h] })), form.harness,
      (value) => { form.harness = value; refresh(); })));
    const modelInput = input({ value: form.model, placeholder: "Harness default", spellcheck: false });
    modelInput.style.fontFamily = "var(--mono)";
    modelInput.addEventListener("input", () => { form.model = modelInput.value; refresh(); });
    harnessRow.append(field("Model", modelInput));
    body.append(harnessRow);

    const whenFields = el("div", "sch-field");
    body.append(whenFields);

    const enabledRow = el("div", "sch-field");
    const enabledLabel = el("label", "sch-hint");
    const enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = form.enabled;
    enabledInput.addEventListener("change", () => { form.enabled = enabledInput.checked; refresh(); });
    enabledLabel.append(enabledInput, document.createTextNode(" Enabled"));
    enabledRow.append(enabledLabel);
    body.append(enabledRow);

    const error = el("div", "sch-invalid");
    error.hidden = true;
    body.append(error);

    if (editing) {
      const del = el("button", "sch-btn danger", "Delete schedule");
      del.addEventListener("click", () => { void deleteSchedule(); });
      body.append(del);
    }

    function refresh() {
      const timing = timingError(form);
      const message = timing ?? (form.name.trim() ? null : "Name is required.")
        ?? (form.prompt.length > MAX_PROMPT ? `Prompt is too long (${form.prompt.length}/${MAX_PROMPT}).` : null)
        ?? (form.project ? null : "Choose a project.") ?? (form.computer ? null : "Choose a computer.");
      error.hidden = !message;
      error.textContent = message ?? "";
      save.disabled = Boolean(message) || !form.project || !form.computer;
    }

    function renderWhen() {
      whenFields.replaceChildren();
      whenFields.append(el("div", "sch-field-label", "When"));
      whenFields.append(segments(
        EVERY_KINDS.map((kind) => ({ value: kind, label: kind === "interval" ? "Every" : kind[0].toUpperCase() + kind.slice(1) })),
        form.every,
        (value) => { form.every = value; renderWhen(); refresh(); },
      ));
      if (form.every === "interval") {
        const row = el("div", "sch-fields-2");
        const amount = input({ type: "number", min: "1", value: String(intervalParts(form.interval).amount) });
        amount.addEventListener("input", () => { form.interval = `${amount.value || "1"}${intervalParts(form.interval).unit}`; refresh(); });
        row.append(field("Interval", amount));
        row.append(field("Unit", select([
          { value: "m", label: "min" }, { value: "h", label: "hours" }, { value: "d", label: "days" },
        ], intervalParts(form.interval).unit, (unit) => {
          form.interval = `${intervalParts(form.interval).amount}${unit}`;
          renderWhen(); refresh();
        })));
        whenFields.append(row);
      } else if (form.every === "daily" || form.every === "weekly") {
        if (form.every === "weekly") whenFields.append(field("Days", dayChips()));
        const at = input({ type: "time", value: form.at });
        at.addEventListener("input", () => { form.at = at.value; refresh(); });
        whenFields.append(field("At", at));
      } else if (form.every === "once") {
        const date = new Date(localDate(form.once) ?? new Date());
        const row = el("div", "sch-fields-2");
        const dateInput = input({ type: "date", value: `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}` });
        const timeInput = input({ type: "time", value: `${two(date.getHours())}:${two(date.getMinutes())}` });
        const sync = () => {
          const [y, m, d] = dateInput.value.split("-").map(Number);
          const [h, min] = timeInput.value.split(":").map(Number);
          if (!y || !m || !d || Number.isNaN(h) || Number.isNaN(min)) { form.once = ""; refresh(); return; }
          form.once = `${y}-${two(m)}-${two(d)}T${two(h)}:${two(min)}:00`;
          refresh();
        };
        dateInput.addEventListener("input", sync);
        timeInput.addEventListener("input", sync);
        row.append(field("On", dateInput), field("At", timeInput));
        whenFields.append(row);
      } else if (form.every === "cron") {
        const cronInput = input({ value: form.cron, placeholder: "0 7 * * 1-5", spellcheck: false });
        cronInput.style.fontFamily = "var(--mono)";
        cronInput.addEventListener("input", () => { form.cron = cronInput.value; renderWhen(); refresh(); });
        whenFields.append(field("Cron", cronInput));
        const preview = el("div", "sch-hint");
        const dates = cronPreview(form.cron);
        preview.textContent = dates ? dates.map((d) => startedText(d)).join("  ·  ") : "Not a valid cron line";
        if (!dates) preview.style.color = "var(--danger)";
        whenFields.append(field("Next", preview));
      }
    }

    function dayChips() {
      const box = el("div", "sch-days");
      for (const day of DAY_ORDER) {
        const button = el("button", `sch-day${form.days.includes(day) ? " on" : ""}`, SHORT_DAY[day]);
        button.type = "button";
        button.addEventListener("click", () => {
          form.days = form.days.includes(day) ? form.days.filter((d) => d !== day) : [...form.days, day];
          renderWhen(); refresh();
        });
        box.append(button);
      }
      return box;
    }

    function close() { overlay.remove(); document.removeEventListener("keydown", onKey, true); }
    const onKey = (ev) => { if (ev.key === "Escape") close(); };
    document.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", close);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
    save.addEventListener("click", () => {
      const schedule = formSchedule();
      const invalid = validateSchedule(schedule);
      if (invalid) { error.hidden = false; error.textContent = invalid; return; }
      void (async () => {
        if (await persistSchedule(form.project, schedule.id, schedule, form.computer)) { close(); await loadAll(); }
      })();
    });

    async function deleteSchedule() {
      save.disabled = true;
      if (await persistSchedule(form.project, form.id, null, form.computer)) { close(); await loadAll(); }
      else save.disabled = false;
    }

    renderWhen();
    refresh();
    nameInput.focus();
  }

  function intervalParts(value) {
    const match = /^(\d+)([mhd])$/.exec(value ?? "");
    if (!match) return { amount: 6, unit: "h" };
    return { amount: Number(match[1]), unit: match[2] };
  }

  function formSchedule() {
    const schedule = {
      id: form.id, name: form.name.trim(), enabled: form.enabled, computer: form.computer,
      harness: form.harness, every: form.every, prompt: form.prompt,
      createdAt: form.createdAt, updatedAt: new Date().toISOString(),
    };
    if (form.model.trim()) schedule.model = form.model.trim();
    if (form.account) schedule.account = form.account;
    if (Array.isArray(form.projects) && form.projects.length) schedule.projects = form.projects;
    if (Array.isArray(form.notify) && form.notify.length) schedule.notify = form.notify;
    if (form.every === "interval") schedule.interval = form.interval;
    else if (form.every === "daily") schedule.at = form.at;
    else if (form.every === "weekly") { schedule.at = form.at; schedule.days = form.days; }
    else if (form.every === "once") schedule.once = form.once;
    else if (form.every === "cron") schedule.cron = form.cron.trim();
    return schedule;
  }

  function cronPreview(expression) {
    const schedule = { every: "cron", cron: expression, enabled: true, createdAt: new Date(0).toISOString() };
    if (!parseCron(expression)) return null;
    const dates = [];
    let after = new Date();
    for (let i = 0; i < 3; i++) {
      const next = nextCron(schedule, after);
      if (!next) return null;
      dates.push(next);
      after = next;
    }
    return dates;
  }

  // ---- wiring ----------------------------------------------------------

  root.querySelector("[data-refresh]").addEventListener("click", () => { void loadAll(); });
  root.querySelector("[data-new]").addEventListener("click", () => openEditor(null));

  let onlineSig = "";
  const unsubscribe = store.subscribe((merged) => {
    const sig = (merged?.computers ?? []).map((c) => `${c.computer}:${c.state}`).join(",");
    if (sig === onlineSig) return;
    onlineSig = sig;
    void loadAll();
  });

  let timer = null;
  function startPoll() { if (!timer) timer = setInterval(() => { void loadAll(); }, POLL_MS); }
  function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }

  state.visible = true;
  render();
  void loadAll();
  startPoll();

  return {
    show() { state.visible = true; startPoll(); void loadAll(); },
    hide() { state.visible = false; stopPoll(); },
    destroy() { stopPoll(); unsubscribe(); },
  };
}
