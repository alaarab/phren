import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as yaml from "js-yaml";
import { z } from "zod";
import { atomicInPrivateDir, bridgeRoot, object } from "./protocol.js";
import { isAccountSlug } from "./claude-accounts.js";
/** The schedules.yaml store: the schedule and run record shapes, validation,
 * the five timing forms evaluated in local time, and the run history file. */
export const SCHEDULE_EVERY = ["interval", "daily", "weekly", "once", "cron"];
export const SCHEDULE_HARNESSES = ["claude", "codex", "opencode"];
export const SCHEDULE_NOTIFY = ["start", "finish", "failure"];
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const SCHEDULE_RUN_STATUSES = ["launched", "running", "blocked", "finished", "needs-you", "failed", "skipped"];
const scheduleId = z.string().regex(/^[a-f0-9]{8}$/);
const plain = (max) => z.string().min(1).max(max).refine(value => !/[\x00-\x08\x0b-\x1f\x7f]/.test(value));
const singleLine = (max) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value));
const scheduleName = singleLine(80);
const timestamp = z.string().datetime({ offset: true });
const localTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const schedulePath = (projectDir) => path.join(projectDir, "schedules.yaml");
export const runningStatuses = new Set(["launched", "running", "blocked"]);
const MAX_SCHEDULES = 64;
const MAX_RUNS = 2000;
function validateLocalTimestamp(value) {
    localTimestamp.parse(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value);
    const parts = match.slice(1).map(Number), date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
    if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() !== parts[1] - 1 || date.getUTCDate() !== parts[2]
        || date.getUTCHours() !== parts[3] || date.getUTCMinutes() !== parts[4] || date.getUTCSeconds() !== parts[5]) {
        throw new Error(`Invalid local schedule time: ${value}`);
    }
    return value;
}
export function intervalMilliseconds(value) {
    const match = /^(\d+)(m|h|d)$/.exec(value);
    if (!match || Number(match[1]) < 1)
        throw new Error("Interval must look like 30m, 6h, or 2d.");
    const unit = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
    const milliseconds = Number(match[1]) * unit;
    if (!Number.isSafeInteger(milliseconds))
        throw new Error("Schedule interval is too large.");
    return milliseconds;
}
export function parseSchedule(value) {
    const raw = object(value);
    const every = z.enum(SCHEDULE_EVERY).parse(raw.every);
    const computer = singleLine(200).parse(raw.computer);
    if (canonicalComputer(computer) === "any")
        throw new Error('Schedule computer "any" is not supported.');
    const schedule = {
        ...raw,
        id: scheduleId.parse(raw.id),
        name: scheduleName.parse(raw.name),
        enabled: z.boolean().parse(raw.enabled),
        computer,
        harness: z.enum(SCHEDULE_HARNESSES).parse(raw.harness),
        every,
        prompt: plain(8000).parse(raw.prompt),
        createdAt: timestamp.parse(raw.createdAt),
        updatedAt: timestamp.parse(raw.updatedAt),
    };
    if (raw.model !== undefined)
        schedule.model = singleLine(200).parse(raw.model);
    if (raw.account !== undefined)
        schedule.account = z.string().refine(isAccountSlug, "Account must be default or a lowercase slug.").parse(raw.account);
    if (raw.notify !== undefined)
        schedule.notify = z.array(z.enum(SCHEDULE_NOTIFY)).max(3).parse(raw.notify)
            .filter((kind, index, kinds) => kinds.indexOf(kind) === index);
    if (every === "daily" || every === "weekly")
        schedule.at = clockTime.parse(raw.at);
    if (every === "weekly")
        schedule.days = z.array(z.enum(WEEKDAYS)).min(1).max(7).parse(raw.days).filter((day, index, days) => days.indexOf(day) === index);
    if (every === "interval") {
        schedule.interval = singleLine(32).parse(raw.interval);
        intervalMilliseconds(schedule.interval);
    }
    if (every === "once")
        schedule.once = validateLocalTimestamp(singleLine(32).parse(raw.once));
    if (every === "cron") {
        schedule.cron = singleLine(200).parse(raw.cron);
        parseCron(schedule.cron);
    }
    return schedule;
}
export async function readScheduleDocument(projectDir) {
    let text;
    try {
        text = await readFile(schedulePath(projectDir), "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return { document: { version: 1 }, schedules: [] };
        throw error;
    }
    const document = object(yaml.load(text, { schema: yaml.CORE_SCHEMA }));
    if (document.version !== 1)
        throw new Error("schedules.yaml must have version: 1.");
    if (!Array.isArray(document.schedules))
        throw new Error("schedules.yaml must contain a schedules list.");
    if (document.schedules.length > MAX_SCHEDULES)
        throw new Error(`A project can have at most ${MAX_SCHEDULES} schedules.`);
    const schedules = document.schedules.map(parseSchedule);
    if (new Set(schedules.map(item => item.id)).size !== schedules.length)
        throw new Error("Schedule IDs must be unique within a project.");
    return { document, schedules };
}
export async function writeScheduleDocument(projectDir, schedules, original = { version: 1 }) {
    if (schedules.length > MAX_SCHEDULES)
        throw new Error(`A project can have at most ${MAX_SCHEDULES} schedules.`);
    schedules.forEach(parseSchedule);
    const text = yaml.dump({ ...original, version: 1, schedules }, { lineWidth: 1000, noRefs: true, sortKeys: false });
    await atomicInPrivateDir(schedulePath(projectDir), text);
}
export function canonicalComputer(value) {
    const normalized = value.trim().toLowerCase();
    return normalized.endsWith(".local") ? normalized.slice(0, -".local".length) : normalized;
}
export function computerMatches(wanted, current) {
    return canonicalComputer(wanted) === canonicalComputer(current);
}
export function scheduleNotifications(schedule) {
    return new Set(schedule.notify ?? ["finish", "failure"]);
}
export function scheduleSessionRoute(schedule, launch) {
    if (launch.mode !== "herdr" || !launch.server || !launch.workspaceId || !launch.tabId || !launch.paneId)
        return undefined;
    const route = Buffer.from(JSON.stringify({ server: launch.server, workspace: launch.workspaceId, tab: launch.tabId,
        pane: launch.paneId, source: schedule.harness })).toString("base64url");
    return `phren://session?route=${encodeURIComponent(route)}`;
}
function parseCronField(text, minimum, maximum, sunday = false) {
    const values = new Set(), wildcard = text === "*" || text.startsWith("*/");
    for (const part of text.split(",")) {
        const [rangeText, stepText] = part.split("/");
        if (part.split("/").length > 2 || stepText !== undefined && !/^\d+$/.test(stepText))
            throw new Error(`Invalid cron field: ${text}`);
        const step = stepText === undefined ? 1 : Number(stepText);
        if (step < 1)
            throw new Error(`Invalid cron step: ${text}`);
        let start, end;
        if (rangeText === "*") {
            start = minimum;
            end = maximum;
        }
        else if (/^\d+$/.test(rangeText))
            start = end = Number(rangeText);
        else {
            const range = /^(\d+)-(\d+)$/.exec(rangeText);
            if (!range)
                throw new Error(`Invalid cron field: ${text}`);
            start = Number(range[1]);
            end = Number(range[2]);
        }
        if (start < minimum || end > maximum || start > end)
            throw new Error(`Cron field is out of range: ${text}`);
        for (let value = start; value <= end; value += step)
            values.add(sunday && value === 7 ? 0 : value);
    }
    return { values: [...values].sort((left, right) => left - right), wildcard };
}
function parseCron(value) {
    const fields = value.trim().split(/\s+/);
    if (fields.length !== 5)
        throw new Error("Cron schedules need five fields.");
    return {
        minute: parseCronField(fields[0], 0, 59), hour: parseCronField(fields[1], 0, 23),
        day: parseCronField(fields[2], 1, 31), month: parseCronField(fields[3], 1, 12),
        weekday: parseCronField(fields[4], 0, 7, true),
    };
}
function cronDayMatches(cron, date) {
    const day = cron.day.values.includes(date.getDate()), weekday = cron.weekday.values.includes(date.getDay());
    if (cron.day.wildcard && cron.weekday.wildcard)
        return true;
    if (cron.day.wildcard)
        return weekday;
    if (cron.weekday.wildcard)
        return day;
    return day || weekday;
}
function nextCron(schedule, after) {
    const cron = parseCron(schedule.cron);
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate());
    for (let offset = 0; offset < 366 * 8; offset++) {
        const date = new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset);
        if (!cron.month.values.includes(date.getMonth() + 1) || !cronDayMatches(cron, date))
            continue;
        for (const hour of cron.hour.values)
            for (const minute of cron.minute.values) {
                const candidate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute);
                if (candidate.getHours() === hour && candidate.getMinutes() === minute && candidate > after)
                    return candidate;
            }
    }
    return null;
}
function nextDailyOrWeekly(schedule, after) {
    const [hour, minute] = schedule.at.split(":").map(Number);
    const allowed = schedule.every === "weekly" ? new Set(schedule.days.map(day => WEEKDAYS.indexOf(day))) : undefined;
    for (let offset = 0; offset < 370; offset++) {
        const candidate = new Date(after.getFullYear(), after.getMonth(), after.getDate() + offset, hour, minute);
        if (candidate.getHours() !== hour || candidate.getMinutes() !== minute || candidate <= after)
            continue;
        if (!allowed || allowed.has(candidate.getDay()))
            return candidate;
    }
    return null;
}
function localDate(value) {
    validateLocalTimestamp(value);
    const parts = value.match(/\d+/g).map(Number);
    const date = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
    return date.getFullYear() === parts[0] && date.getMonth() === parts[1] - 1 && date.getDate() === parts[2]
        && date.getHours() === parts[3] && date.getMinutes() === parts[4] && date.getSeconds() === parts[5] ? date : null;
}
export function nextRun(schedule, lastRun) {
    if (schedule.every === "once")
        return lastRun ? null : localDate(schedule.once);
    const after = new Date(lastRun?.startedAt ?? schedule.createdAt);
    if (!Number.isFinite(after.getTime()))
        return null;
    if (schedule.every === "interval")
        return new Date(after.getTime() + intervalMilliseconds(schedule.interval));
    if (schedule.every === "cron")
        return nextCron(schedule, after);
    return nextDailyOrWeekly(schedule, after);
}
export async function readScheduleRuns(file) {
    let text;
    try {
        text = await readFile(file, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw error;
    }
    const runs = [];
    for (const line of text.split("\n")) {
        if (!line.trim())
            continue;
        try {
            const raw = object(JSON.parse(line));
            const launch = object(raw.launch);
            if (typeof raw.id !== "string" || typeof raw.scheduleId !== "string" || typeof raw.project !== "string"
                || typeof raw.startedAt !== "string" || !SCHEDULE_RUN_STATUSES.includes(String(raw.status))
                || !["herdr", "headless"].includes(String(launch.mode)))
                continue;
            runs.push(raw);
        }
        catch { /* A torn final line does not hide older history. */ }
    }
    return runs;
}
export async function writeScheduleRuns(file, runs) {
    const kept = runs.slice(-MAX_RUNS);
    await atomicInPrivateDir(file, kept.map(run => JSON.stringify(run)).join("\n") + (kept.length ? "\n" : ""));
}
export function newScheduleId(existing) {
    const ids = new Set(existing);
    for (;;) {
        const id = randomBytes(4).toString("hex");
        if (!ids.has(id))
            return id;
    }
}
export function scheduleRunsFile() { return path.join(bridgeRoot(), "schedule-runs.jsonl"); }
