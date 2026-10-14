import { hookPost } from "./api.js";

const EDITABLE = [
  "name", "prompt", "enabled", "computer", "harness", "model", "account",
  "notify", "projects", "session", "every", "at", "days", "interval", "once", "cron",
];

/** Compare editor values, excluding revisions, runtime data and future Hook fields. */
export function scheduleChanges(before, after) {
  const changes = {};
  for (const key of EDITABLE) {
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
      changes[key] = after[key] ?? null;
    }
  }
  return changes;
}

/** The stored revision stays byte-for-byte intact; only edited values cross the wire. */
export async function updateSchedule(computer, project, original, before, after) {
  const changes = scheduleChanges(before, after);
  if (!Object.keys(changes).length) return { saved: true };
  try {
    await hookPost(computer, "/v1/schedules/update", {
      project, id: original.id, expectedUpdatedAt: original.updatedAt, changes,
    });
    return { saved: true };
  } catch (error) {
    if (error.status === 409 && error.body?.schedule) {
      return { latest: error.body.schedule, error: "This schedule changed on another device. Review the latest version." };
    }
    if (error.status === 404) return { removed: true, error: "This schedule was removed on another device." };
    return { error: error.message ?? String(error) };
  }
}
