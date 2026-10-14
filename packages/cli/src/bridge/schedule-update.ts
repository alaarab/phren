import path from "node:path";
import { z } from "zod";
import { getProjectDirs } from "../shared.js";
import { BridgeError } from "./protocol.js";
import {
  SCHEDULE_EVERY, SCHEDULE_HARNESSES, SCHEDULE_NOTIFY, SCHEDULE_SESSIONS, WEEKDAYS,
  parseSchedule, readScheduleDocumentSync, withScheduleLock, writeScheduleDocumentSync, type Schedule,
} from "./schedule-format.js";

const optional = <T extends z.ZodType>(schema: T) => schema.nullable().optional();
const updateSchema = z.object({
  project: z.string().min(1).max(200),
  id: z.string().regex(/^[a-f0-9]{8}$/),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  changes: z.object({
    name: z.string().optional(), prompt: z.string().optional(), enabled: z.boolean().optional(),
    computer: z.string().optional(), harness: z.enum(SCHEDULE_HARNESSES).optional(),
    every: z.enum(SCHEDULE_EVERY).optional(),
    model: optional(z.string()), account: optional(z.string()),
    notify: optional(z.array(z.enum(SCHEDULE_NOTIFY))), projects: optional(z.array(z.string())),
    session: optional(z.enum(SCHEDULE_SESSIONS)), at: optional(z.string()),
    days: optional(z.array(z.enum(WEEKDAYS))), interval: optional(z.string()),
    once: optional(z.string()), cron: optional(z.string()),
  }).strict(),
}).strict();

/** Merge only client edits into a fresh document under the CLI writers' lock. */
export async function updateScheduleRoute(store: string, body: unknown): Promise<{ ok: true; schedule: Schedule }> {
  let input: z.infer<typeof updateSchema>;
  try { input = updateSchema.parse(body); }
  catch (error) { throw new BridgeError(400, error instanceof Error ? error.message : "Invalid schedule update."); }
  const directory = getProjectDirs(store).find(dir => path.basename(dir).toLowerCase() === input.project.toLowerCase());
  if (!directory) throw new BridgeError(404, `Unknown project "${input.project}".`);
  return withScheduleLock(directory, () => {
    const file = readScheduleDocumentSync(directory);
    // Keep raw siblings too: parsing can normalize duplicate days/notifications.
    const schedules = (file.document.schedules as Schedule[] | undefined) ?? [];
    const index = schedules.findIndex(schedule => schedule.id === input.id);
    if (index < 0) throw new BridgeError(404, `Schedule "${input.id}" was not found in ${input.project}.`);
    const current = schedules[index];
    if (current.updatedAt !== input.expectedUpdatedAt) {
      throw new BridgeError(409, "This schedule changed. Refresh it and try again.", { schedule: current });
    }
    const updated = { ...current };
    for (const [key, value] of Object.entries(input.changes)) {
      if (value === null) delete updated[key];
      else updated[key] = value;
    }
    try { parseSchedule(updated); }
    catch (error) { throw new BridgeError(400, error instanceof Error ? error.message : "Invalid schedule."); }
    updated.updatedAt = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString();
    schedules[index] = updated;
    writeScheduleDocumentSync(directory, schedules, file.document);
    return { ok: true, schedule: updated };
  });
}
