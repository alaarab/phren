import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { buildTreeItem } from "../src/providers/tree-nodes";
import type { PhrenNode } from "../src/providers/tree-types";

function icon(item: vscode.TreeItem): string {
  return (item.iconPath as vscode.ThemeIcon).id;
}

describe("buildTreeItem: malformed input", () => {
  it("renders a placeholder for a null/kind-less element instead of throwing", () => {
    const item = buildTreeItem(null as unknown as PhrenNode, undefined);
    expect(item.label).toBe("(unknown)");
    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });
});

describe("buildTreeItem: rootSection", () => {
  it("renders the graph section as a leaf with a direct command instead of expanding children", () => {
    const item = buildTreeItem({ kind: "rootSection", section: "graph" }, undefined);
    expect(item.label).toBe("Fragment Graph");
    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
    expect(item.command?.command).toBe("phren.showGraph");
  });

  it("renders other root sections as collapsed with their description surfaced", () => {
    const item = buildTreeItem({ kind: "rootSection", section: "hooks", description: "2/3 on" }, undefined);
    expect(item.label).toBe("Hooks");
    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    expect(item.description).toBe("2/3 on");
    expect(item.command).toBeUndefined();
  });
});

describe("buildTreeItem: project", () => {
  it("marks the active project with a star and no review badge when clean", () => {
    const item = buildTreeItem({ kind: "project", projectName: "app", active: true, brief: "the app" }, undefined);
    expect(item.description).toBe("★ the app");
    expect(icon(item)).toBe("star-full");
    expect(item.contextValue).toBe("phren.project");
  });

  it("active project with a conflict badge separates star and badge by two spaces, no leading whitespace", () => {
    const item = buildTreeItem(
      { kind: "project", projectName: "app", active: true, conflictCount: 2 },
      undefined,
    );
    expect(item.description).toBe("★  ⚠ 2");
  });

  it("prefers the conflict badge over the review-count badge", () => {
    const item = buildTreeItem(
      { kind: "project", projectName: "app", reviewCount: 4, conflictCount: 2 },
      undefined,
    );
    expect(item.description).toBe("⚠ 2");
    expect(icon(item)).toBe("warning");
  });

  it("shows a plain review-count badge when there are no conflicts", () => {
    const item = buildTreeItem({ kind: "project", projectName: "app", reviewCount: 3 }, undefined);
    expect(item.description).toBe("3 review");
    expect(icon(item)).toBe("folder");
  });

  it("falls back to a truncated brief when there is no badge and no active flag", () => {
    const item = buildTreeItem({ kind: "project", projectName: "app", brief: "a".repeat(100) }, undefined);
    // truncate(..., 72): 69 chars kept + "..." = 72, and no leading whitespace
    // left over from the (unset) badge.
    expect(item.description).toHaveLength(72);
    expect(item.description).toMatch(/^a+\.\.\.$/);
  });
});

describe("buildTreeItem: category", () => {
  it("appends the active date filter label to the Findings category only", () => {
    const item = buildTreeItem(
      { kind: "category", projectName: "app", category: "findings" },
      { from: "2026-01-01", to: "2026-01-31", label: "Jan" },
    );
    expect(item.label).toBe("Findings [Jan]");
  });

  it("leaves other categories unaffected by an active date filter", () => {
    const item = buildTreeItem(
      { kind: "category", projectName: "app", category: "notes" },
      { label: "Jan" },
    );
    expect(item.label).toBe("Notes");
  });
});

describe("buildTreeItem: finding", () => {
  const base = {
    kind: "finding" as const,
    projectName: "app",
    id: "f1",
    date: "2026-01-01",
    text: "Redis TTL is 300s",
  };

  it("plain finding shows a lightbulb and a relative-time description", () => {
    const item = buildTreeItem({ ...base, date: new Date().toISOString().slice(0, 10) }, undefined);
    expect(icon(item)).toBe("lightbulb");
    expect(item.description).not.toBe("(superseded)");
    expect(item.command?.command).toBe("phren.openFinding");
  });

  it("supersededBy wins over contradicts and potentialDuplicates", () => {
    const item = buildTreeItem(
      { ...base, supersededBy: "newer finding", contradicts: ["x"], potentialDuplicates: ["y"] },
      undefined,
    );
    expect(icon(item)).toBe("lightbulb-autofix");
    expect(item.description).toBe("(superseded)");
    expect((item.tooltip as string)).toContain('Superseded by: "newer finding"');
  });

  it("contradicts wins over potentialDuplicates when not superseded", () => {
    const item = buildTreeItem({ ...base, contradicts: ["other finding"], potentialDuplicates: ["y"] }, undefined);
    expect(icon(item)).toBe("warning");
    expect(item.description).toBe("(conflict)");
    expect((item.tooltip as string)).toContain('Contradicts: "other finding"');
  });

  it("shows potentialDuplicates count when there is more than one", () => {
    const item = buildTreeItem({ ...base, potentialDuplicates: ["a", "b", "c"] }, undefined);
    expect(icon(item)).toBe("issue-opened");
    expect(item.description).toBe("(possible duplicate)");
    expect((item.tooltip as string)).toContain("(and 2 more)");
  });

  it("appends a Supersedes line to the tooltip independent of the other flags", () => {
    const item = buildTreeItem({ ...base, supersedes: "old finding" }, undefined);
    expect((item.tooltip as string)).toContain('Supersedes: "old finding"');
  });

  it("passes the full node through as the openFinding command argument", () => {
    const node = { ...base };
    const item = buildTreeItem(node, undefined);
    expect(item.command?.arguments).toEqual([node]);
  });
});

describe("buildTreeItem: note", () => {
  it("shows the promoted marker in description, tooltip, contextValue, and icon", () => {
    const item = buildTreeItem(
      { kind: "note", projectName: "app", id: "n1", date: "2026-01-01", time: "14:30:00", text: "note text", promoted: true },
      undefined,
    );
    expect(item.description).toBe("14:30 · promoted");
    expect(icon(item)).toBe("pass-filled");
    expect(item.contextValue).toBe("phren.note.promoted");
    expect((item.tooltip as string)).toContain("Promoted to findings");
  });

  it("un-promoted note omits the marker everywhere", () => {
    const item = buildTreeItem(
      { kind: "note", projectName: "app", id: "n1", date: "2026-01-01", time: "09:05:00", text: "x", promoted: false },
      undefined,
    );
    expect(item.description).toBe("09:05");
    expect(icon(item)).toBe("note");
    expect(item.contextValue).toBe("phren.note");
  });
});

describe("buildTreeItem: task", () => {
  it("marks non-Done tasks as active in contextValue and issues the openTask command", () => {
    const item = buildTreeItem(
      { kind: "task", projectName: "app", id: "t1", line: "ship it", section: "Active", checked: false },
      undefined,
    );
    expect(item.contextValue).toBe("phren.task.active");
    expect(item.description).toBe("app");
    expect(item.command?.command).toBe("phren.openTask");
  });

  it("marks Done tasks distinctly", () => {
    const item = buildTreeItem(
      { kind: "task", projectName: "app", id: "t1", line: "shipped", section: "Done", checked: true },
      undefined,
    );
    expect(item.contextValue).toBe("phren.task.done");
    expect(icon(item)).toBe("check");
  });
});

describe("buildTreeItem: reviewProjectGroup", () => {
  it("shows both conflict and review counts joined, and totals when both are zero", () => {
    const withBoth = buildTreeItem(
      { kind: "reviewProjectGroup", projectName: "app", reviewCount: 3, conflictCount: 1 },
      undefined,
    );
    expect(withBoth.description).toBe("⚠ 1 · 3 review");
    expect(icon(withBoth)).toBe("warning");

    const zero = buildTreeItem(
      { kind: "reviewProjectGroup", projectName: "app", reviewCount: 0, conflictCount: 0 },
      undefined,
    );
    expect(zero.description).toBe("0");
    expect(icon(zero)).toBe("inbox");
  });
});

describe("buildTreeItem: queueItem", () => {
  it("rounds confidence into the tooltip and hides the project name unless showProjectName is set", () => {
    const hidden = buildTreeItem(
      {
        kind: "queueItem", projectName: "app", id: "q1", section: "Review", date: "2026-01-01",
        text: "text", line: "line", confidence: 0.876, risky: false, showProjectName: false,
      },
      undefined,
    );
    expect(hidden.description).toBeUndefined();
    expect((hidden.tooltip as string)).toContain("(88%)");
    expect(icon(hidden)).toBe("mail");

    const shown = buildTreeItem(
      {
        kind: "queueItem", projectName: "app", id: "q1", section: "Review", date: "2026-01-01",
        text: "text", line: "line", risky: true, showProjectName: true,
      },
      undefined,
    );
    expect(shown.description).toBe("app");
    expect(icon(shown)).toBe("warning");
  });
});

describe("buildTreeItem: skill", () => {
  it("reflects enabled/disabled in icon, description, and contextValue", () => {
    const enabled = buildTreeItem({ kind: "skill", name: "s", source: "global", enabled: true }, undefined);
    expect(enabled.description).toBe("enabled");
    expect(icon(enabled)).toBe("check");
    expect(enabled.contextValue).toBe("phren.skill.enabled");

    const disabled = buildTreeItem({ kind: "skill", name: "s", source: "global", enabled: false }, undefined);
    expect(disabled.description).toBe("disabled");
    expect(icon(disabled)).toBe("circle-slash");
    expect(disabled.contextValue).toBe("phren.skill.disabled");
  });
});

describe("buildTreeItem: projectHookEvent", () => {
  it("distinguishes inherited vs explicit overrides in the override label", () => {
    const inherited = buildTreeItem(
      { kind: "projectHookEvent", projectName: "app", event: "PreToolUse", enabled: true, configured: null },
      undefined,
    );
    expect(inherited.description).toContain("(inherit)");

    const overrideOn = buildTreeItem(
      { kind: "projectHookEvent", projectName: "app", event: "PreToolUse", enabled: true, configured: true },
      undefined,
    );
    expect(overrideOn.description).toContain("(override: on)");

    const overrideOff = buildTreeItem(
      { kind: "projectHookEvent", projectName: "app", event: "PreToolUse", enabled: false, configured: false },
      undefined,
    );
    expect(overrideOff.description).toContain("(override: off)");
  });
});

describe("buildTreeItem: storeGroup and manageItem", () => {
  it("storeGroup shows role/sync-mode/last-sync in the description and full detail in the tooltip", () => {
    const item = buildTreeItem(
      { kind: "storeGroup", storeName: "team-store", role: "team", count: 5, syncMode: "pull", lastSync: undefined },
      undefined,
    );
    expect(item.description).toBe("team · pull · never synced");
    expect((item.tooltip as string)).toContain("Store: team-store");
  });

  it("manageItem wires the health row to the doctor command", () => {
    const item = buildTreeItem({ kind: "manageItem", item: "health", label: "Health", value: "ok" }, undefined);
    expect(item.command?.command).toBe("phren.doctor");
  });

  it("manageItem storeSync uses a store-scoped id so multiple stores don't collide", () => {
    const item = buildTreeItem(
      { kind: "manageItem", item: "storeSync", label: "team", value: "x", storeName: "team" },
      undefined,
    );
    expect(item.id).toBe("phren.manage.storeSync.team");
  });
});

describe("buildTreeItem: message", () => {
  it("defaults to the info icon when no iconId is given", () => {
    const item = buildTreeItem({ kind: "message", label: "No findings" }, undefined);
    expect(icon(item)).toBe("info");
  });

  it("uses the supplied iconId and description when given", () => {
    const item = buildTreeItem({ kind: "message", label: "Failed to load", description: "boom", iconId: "warning" }, undefined);
    expect(icon(item)).toBe("warning");
    expect(item.description).toBe("boom");
  });
});
