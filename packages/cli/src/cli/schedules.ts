import * as fs from "node:fs";
import { request } from "node:http";
import path from "node:path";
import {
  SCHEDULE_EVERY,
  SCHEDULE_HARNESSES,
  WEEKDAYS,
  canonicalComputer,
  newScheduleId,
  parseSchedule,
  readScheduleDocument,
  writeScheduleDocument,
  type Schedule,
  type ScheduleEvery,
  type ScheduleHarness,
  type Weekday,
} from "../bridge/schedules.js";
import { object, socketPath, type Json } from "../bridge/protocol.js";
import { listMachines } from "../profile-store.js";
import { getProjectDirs } from "../shared.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

function projectDirectory(store: string, name: string): string {
  const directory = getProjectDirs(store).find(candidate => path.basename(candidate).toLowerCase() === name.toLowerCase());
  if (!directory) throw new Error(`Unknown project "${name}".`);
  return directory;
}

function scheduleDescription(schedule: Schedule): string {
  if (schedule.every === "interval") return `every ${schedule.interval}`;
  if (schedule.every === "daily") return `daily at ${schedule.at}`;
  if (schedule.every === "weekly") return `${schedule.days!.join(",")} at ${schedule.at}`;
  if (schedule.every === "once") return `once ${schedule.once}`;
  return `cron ${schedule.cron}`;
}

async function list(store: string, projectName?: string): Promise<void> {
  const directories = projectName ? [projectDirectory(store, projectName)] : getProjectDirs(store);
  let count = 0;
  for (const directory of directories) {
    const project = path.basename(directory), schedules = (await readScheduleDocument(directory)).schedules;
    for (const schedule of schedules) {
      count++;
      console.log(`${project}  ${schedule.id}  ${schedule.enabled ? "enabled " : "paused  "}  ${schedule.name}`);
      console.log(`  ${schedule.computer} · ${schedule.harness}${schedule.model ? `/${schedule.model}` : ""} · ${scheduleDescription(schedule)}`);
    }
  }
  if (!count) console.log("No schedules.");
}

async function add(store: string, args: string[]): Promise<void> {
  const projectName = args[1];
  if (!projectName || projectName.startsWith("--")) throw new Error("Usage: phren schedule add <project> --name ... --prompt <text>");
  const directory = projectDirectory(store, projectName), file = await readScheduleDocument(directory);
  const name = option(args, "--name"), harness = option(args, "--harness") as ScheduleHarness | undefined;
  const requestedComputer = option(args, "--computer"), every = option(args, "--every") as ScheduleEvery | undefined;
  if (!name || !harness || !requestedComputer || !every) throw new Error("--name, --harness, --computer, and --every are required.");
  if (!SCHEDULE_HARNESSES.includes(harness)) throw new Error(`--harness must be one of: ${SCHEDULE_HARNESSES.join(", ")}.`);
  if (!SCHEDULE_EVERY.includes(every)) throw new Error(`--every must be one of: ${SCHEDULE_EVERY.join(", ")}.`);
  const machines = listMachines(store);
  if (!machines.ok) throw new Error(machines.error);
  const computer = Object.keys(machines.data).find(machine => canonicalComputer(machine) === canonicalComputer(requestedComputer));
  if (!computer) throw new Error(`Computer "${requestedComputer}" is not a machines.yaml key.`);
  const inlinePrompt = option(args, "--prompt"), promptFile = option(args, "--prompt-file");
  if (Boolean(inlinePrompt) === Boolean(promptFile)) throw new Error("Choose exactly one of --prompt or --prompt-file.");
  const prompt = promptFile ? fs.readFileSync(path.resolve(promptFile), "utf8") : inlinePrompt!;
  const now = new Date().toISOString();
  const schedule: Schedule = {
    id: newScheduleId(file.schedules.map(item => item.id)), name, enabled: true, computer, harness,
    ...(option(args, "--model") ? { model: option(args, "--model") } : {}), every, prompt, createdAt: now, updatedAt: now,
    ...(option(args, "--at") ? { at: option(args, "--at") } : {}),
    ...(option(args, "--days") ? { days: option(args, "--days")!.split(",").map(day => day.trim().toLowerCase()) as Weekday[] } : {}),
    ...(option(args, "--interval") ? { interval: option(args, "--interval") } : {}),
    ...(option(args, "--once") ? { once: option(args, "--once") } : {}),
    ...(option(args, "--cron") ? { cron: option(args, "--cron") } : {}),
  };
  if (schedule.days?.some(day => !WEEKDAYS.includes(day))) throw new Error(`--days accepts: ${WEEKDAYS.join(", ")}.`);
  const validated = parseSchedule(schedule);
  await writeScheduleDocument(directory, [...file.schedules, validated], file.document);
  console.log(`Added schedule ${validated.id} to ${path.basename(directory)}.`);
}

async function mutate(store: string, action: "remove" | "enable" | "disable", projectName: string | undefined, id: string | undefined): Promise<void> {
  if (!projectName || !id) throw new Error(`Usage: phren schedule ${action} <project> <id>`);
  const directory = projectDirectory(store, projectName), file = await readScheduleDocument(directory);
  const existing = file.schedules.find(schedule => schedule.id === id);
  if (!existing) throw new Error(`Schedule "${id}" was not found in ${path.basename(directory)}.`);
  const schedules = action === "remove" ? file.schedules.filter(schedule => schedule.id !== id)
    : file.schedules.map(schedule => schedule.id === id ? { ...schedule, enabled: action === "enable", updatedAt: new Date().toISOString() } : schedule);
  await writeScheduleDocument(directory, schedules, file.document);
  console.log(`${action === "remove" ? "Removed" : action === "enable" ? "Enabled" : "Disabled"} schedule ${id}.`);
}

async function hookPost(route: string, data: Json): Promise<Json> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const req = request({ socketPath: socketPath(), path: route, method: "POST", timeout: 60_000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk.toString(); if (text.length > 8 * 1024 * 1024) req.destroy(new Error("Phren Hook response is too large.")); });
      response.on("end", () => {
        let result: Json;
        try { result = object(JSON.parse(text)); } catch { reject(new Error("Phren Hook returned an invalid response.")); return; }
        if ((response.statusCode ?? 500) >= 400) reject(new Error(typeof result.error === "string" ? result.error : "Phren Hook rejected the request."));
        else resolve(result);
      });
    });
    req.on("timeout", () => req.destroy(new Error("Phren Hook did not answer.")));
    req.on("error", error => reject((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ECONNREFUSED"
      ? new Error("Phren Hook is not running. Start it with `phren bridge install`.") : error));
    req.end(payload);
  });
}

async function runNow(project: string | undefined, id: string | undefined): Promise<void> {
  if (!project || !id) throw new Error("Usage: phren schedule run <project> <id>");
  const result = await hookPost("/v1/schedules/run", { project, id });
  const run = object(result.run);
  console.log(`Launched schedule ${id} (${String(run.id ?? "run recorded")}).`);
}

async function history(args: string[]): Promise<void> {
  const project = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  const rawLimit = option(args, "--limit"), limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) throw new Error("--limit must be between 1 and 500.");
  const result = await hookPost("/v1/schedules/history", { ...(project ? { project } : {}), ...(option(args, "--id") ? { id: option(args, "--id") } : {}), ...(limit ? { limit } : {}) });
  const runs = Array.isArray(result.runs) ? result.runs.map(object) : [];
  if (!runs.length) { console.log("No schedule runs."); return; }
  for (const run of runs) console.log(`${String(run.startedAt)}  ${String(run.status).padEnd(9)}  ${String(run.project)}/${String(run.scheduleId)}${run.reason ? `  ${String(run.reason)}` : ""}`);
}

export async function handleScheduleCommand(args: string[], store: string): Promise<number> {
  const action = args[0];
  if (!action || action === "list") await list(store, args[1]);
  else if (action === "add") await add(store, args);
  else if (action === "remove" || action === "enable" || action === "disable") await mutate(store, action, args[1], args[2]);
  else if (action === "run") await runNow(args[1], args[2]);
  else if (action === "history") await history(args);
  else throw new Error("Usage: phren schedule <list|add|remove|enable|disable|run|history>");
  return 0;
}
