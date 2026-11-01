import { z } from "zod";
import { redactSecretsForLog } from "../content/secrets.js";
import { BridgeError } from "./protocol.js";
import { eventNameSchema, payloadPathSchema, type Schedule } from "./schedule-format.js";

export const SCHEDULE_EVENT_BODY_CAP = 256 * 1024;
const eventSchema = z.object({ event: eventNameSchema,
  deliveryId: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
  payload: z.record(z.string(), z.unknown()),
}).strict();
export type ScheduleEvent = z.infer<typeof eventSchema>;

export function parseScheduleEvent(body: unknown): ScheduleEvent {
  try {
    if (Buffer.byteLength(JSON.stringify(body) ?? "") > SCHEDULE_EVENT_BODY_CAP) throw new BridgeError(413, "Schedule event is too large.");
    return eventSchema.parse(body);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(400, "Invalid schedule event: expected { event, deliveryId, payload }.");
  }
}

function field(payload: unknown, path: string): unknown {
  if (!payloadPathSchema.safeParse(path).success) return undefined;
  let current = payload;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** One replacement pass; substituted values are never parsed as templates. */
export function scheduleEventPrompt(schedule: Schedule, event: ScheduleEvent): { prompt: string; fields: Record<string, string>; matches: boolean } {
  const fields: Record<string, string> = Object.create(null);
  const text = (path: string): string => {
    if (!payloadPathSchema.safeParse(path).success) return "";
    const value = field(event.payload, path);
    const scalar = typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    // Detect credentials before truncation: a truncated credential could evade detection.
    const safe = scalar ? redactSecretsForLog(String(value)).slice(0, 1024).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "") : "";
    if (Object.keys(fields).length < 64 || Object.hasOwn(fields, path)) fields[path] = safe;
    return safe;
  };
  const matches = (schedule.filters ?? []).map(filter => {
    text(filter.path);
    return field(event.payload, filter.path) === filter.equals;
  }).every(Boolean);
  const prompt = schedule.prompt.replace(/\{\{payload\.([^{}]+)\}\}/g, (_match, path: string) => text(path)).slice(0, 8000);
  return { prompt, fields, matches };
}
