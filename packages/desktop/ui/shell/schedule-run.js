import { hookPost } from "../api.js";

/** Shared immediate-run request; retain the revision the user saw. */
export function runSchedule(computer, schedule) {
  return hookPost(computer, "/v1/schedules/run", {
    project: schedule.project, id: schedule.id, expectedUpdatedAt: schedule.updatedAt,
  });
}
