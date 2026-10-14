import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error schedule-update.js is plain ESM without type declarations
import { scheduleChanges, updateSchedule } from "../ui/schedule-update.js";

const original = {
  id: "nightly", name: "Nightly sweep", prompt: "Check the build", enabled: true,
  computer: "omarchy", harness: "claude", every: "daily", at: "07:30",
  updatedAt: "2026-10-14T01:02:03.123456+02:00",
};

afterEach(() => vi.unstubAllGlobals());

describe("schedule change sets", () => {
  it("compares array values and ignores revisions, runtime data and unknown fields", () => {
    const before = { ...original, notify: ["failed"], projects: ["phren"], future: "keep" };
    expect(scheduleChanges(before, {
      ...before, notify: ["failed"], projects: ["phren"], updatedAt: "new revision",
      future: "new value", running: true, id: "replacement", createdAt: "new date",
    })).toEqual({});
  });

  it("sends null for cleared optional values and obsolete timing fields", () => {
    expect(scheduleChanges({ ...original, model: "opus", session: "reuse" }, {
      ...original, model: undefined, session: undefined, every: "interval", at: undefined, interval: "6h",
    })).toEqual({ model: null, session: null, every: "interval", at: null, interval: "6h" });
  });

  it("returns success without making a request when nothing was edited", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await updateSchedule("Devbox", "phren", original, original, { ...original })).toEqual({ saved: true });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("schedule merge delivery", () => {
  function respond(status: number, body: unknown) {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("posts only the edited keys to the store computer and keeps the exact stored revision", async () => {
    const fetch = respond(200, { ok: true });
    expect(await updateSchedule("Dev box", "phren", original, original, {
      ...original, enabled: false, computer: "macbook", updatedAt: "replacement", future: "never send",
    })).toEqual({ saved: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe("/hosts/Dev%20box/v1/schedules/update");
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.body)).toEqual({
      project: "phren", id: "nightly", expectedUpdatedAt: original.updatedAt,
      changes: { enabled: false, computer: "macbook" },
    });
  });

  it("returns the latest schedule on 409 so the editor reloads it instead of retrying stale edits", async () => {
    const latest = { ...original, name: "Changed elsewhere", updatedAt: "2026-10-14T02:00:00Z", future: true };
    const fetch = respond(409, { error: "revision mismatch", schedule: latest });
    expect(await updateSchedule("Devbox", "phren", original, original, { ...original, name: "My edit" })).toEqual({
      latest, error: "This schedule changed on another device. Review the latest version.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("marks a 404 as removed so the editor closes with a removal notice", async () => {
    respond(404, { error: "Schedule not found" });
    expect(await updateSchedule("Devbox", "phren", original, original, { ...original, enabled: false })).toEqual({
      removed: true, error: "This schedule was removed on another device.",
    });
  });

  it("keeps a validation error on the form without closing or reloading it", async () => {
    respond(400, { error: "Unknown computer: missing" });
    expect(await updateSchedule("Devbox", "phren", original, original, { ...original, computer: "missing" })).toEqual({
      error: "Unknown computer: missing",
    });
  });
});
