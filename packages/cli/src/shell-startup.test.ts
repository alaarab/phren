/**
 * Deep links into the shell (`phren shell --view tasks --here`).
 *
 * The launcher on the other end of these flags is usually a keybinding — a
 * Herdr plugin pane, a tmux popup — so a link that misses has to degrade into
 * a working shell rather than an error the user never gets to read.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { parseShellArgs, resolveShellStartup, normalizeShellView } from "./shell/startup.js";

const detectProject = vi.hoisted(() => vi.fn<(phrenPath: string, cwd: string, profile?: string) => string | null>());
vi.mock("./shared/index.js", () => ({ detectProject }));

beforeEach(() => detectProject.mockReset());
afterEach(() => vi.restoreAllMocks());

const opts = { phrenPath: "/store", profile: "default", cwd: "/repo/hub" };

describe("parseShellArgs", () => {
  it("reads the space-separated form", () => {
    expect(parseShellArgs(["--view", "tasks", "--project", "hub"]))
      .toMatchObject({ view: "tasks", project: "hub" });
  });

  it("reads the equals form", () => {
    expect(parseShellArgs(["--view=review queue", "--project=hub"]))
      .toMatchObject({ view: "review queue", project: "hub" });
  });

  it("does not swallow the next flag as a value", () => {
    expect(parseShellArgs(["--view=tasks", "--here"])).toMatchObject({ view: "tasks", here: true });
  });

  it("records an unknown flag instead of guessing", () => {
    expect(parseShellArgs(["--nope"]).unknown).toBe("--nope");
  });

  it("returns nothing for no arguments", () => {
    expect(parseShellArgs([])).toEqual({});
  });
});

describe("normalizeShellView", () => {
  it("accepts what a person would type", () => {
    expect(normalizeShellView("tasks")).toBe("Tasks");
    expect(normalizeShellView("  REVIEW  ")).toBe("Review Queue");
    expect(normalizeShellView("review-queue")).toBe("Review Queue");
    expect(normalizeShellView("profiles")).toBe("Machines/Profiles");
    expect(normalizeShellView("graph")).toBe("Graph");
    expect(normalizeShellView("map")).toBe("Graph");
  });

  it("rejects a view it does not know", () => {
    expect(normalizeShellView("nope")).toBeUndefined();
  });
});

describe("resolveShellStartup", () => {
  it("resolves --here through phren's own project detection", () => {
    detectProject.mockReturnValue("hub");
    const { startup, warnings } = resolveShellStartup({ view: "tasks", here: true }, opts);
    expect(detectProject).toHaveBeenCalledWith("/store", "/repo/hub", "default");
    expect(startup).toMatchObject({ view: "Tasks", project: "hub" });
    expect(warnings).toEqual([]);
  });

  it("prefers an explicit --project over detection", () => {
    const { startup } = resolveShellStartup({ project: "ogrid", here: true }, opts);
    expect(detectProject).not.toHaveBeenCalled();
    expect(startup.project).toBe("ogrid");
  });

  it("falls back to the project list when the directory is not a phren project", () => {
    detectProject.mockReturnValue(null);
    const { startup, warnings } = resolveShellStartup({ view: "tasks", here: true }, opts);
    // Tasks without a project is an empty "pick a project" screen; Projects is
    // the screen that lets the user fix it.
    expect(startup.view).toBeUndefined();
    expect(startup.project).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("keeps global views without a project", () => {
    const { startup } = resolveShellStartup({ view: "health" }, opts);
    expect(startup.view).toBe("Health");
    expect(resolveShellStartup({ view: "graph" }, opts).startup.view).toBe("Graph");
  });

  it("warns but still opens on an unknown view", () => {
    const { startup, warnings } = resolveShellStartup({ view: "nope", project: "hub" }, opts);
    expect(startup.view).toBeUndefined();
    expect(startup.project).toBe("hub");
    expect(warnings[0]).toContain("nope");
  });

  it("warns about an unknown flag", () => {
    const { warnings } = resolveShellStartup({ unknown: "--nope" }, opts);
    expect(warnings[0]).toContain("--nope");
  });
});
