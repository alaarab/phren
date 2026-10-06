import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PhrenActivityProvider } from "../src/providers/PhrenActivityProvider";

function lookupLog(storePath: string): string {
  return path.join(storePath, ".runtime", "lookup-events.jsonl");
}

function append(storePath: string, ev: Record<string, unknown>): void {
  const p = lookupLog(storePath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), source: "search", ...ev }) + "\n");
}

describe("PhrenActivityProvider", () => {
  let storePath: string;
  let provider: PhrenActivityProvider | undefined;

  beforeEach(() => {
    storePath = fs.mkdtempSync(path.join(os.tmpdir(), "phren-activity-"));
  });

  afterEach(() => {
    provider?.dispose();
    provider = undefined;
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it("starts empty when no log exists", () => {
    provider = new PhrenActivityProvider(storePath);
    expect(provider.getChildren()).toEqual([]);
  });

  it("reads existing events newest-first after refresh", () => {
    provider = new PhrenActivityProvider(storePath);
    append(storePath, { query: "redis", project: "app", filename: "FINDINGS.md", type: "findings" });
    append(storePath, { query: "redis", project: "app", filename: "reference/cache.md", type: "reference" });
    provider.refresh();

    const children = provider.getChildren();
    expect(children).toHaveLength(2);
    expect(children[0].filename).toBe("reference/cache.md");
    expect(children[1].filename).toBe("FINDINGS.md");
  });

  it("fires onDidChangeTreeData and notifies the newest lookup on refresh", () => {
    provider = new PhrenActivityProvider(storePath);
    const treeChanged = vi.fn();
    const newLookup = vi.fn();
    provider.onDidChangeTreeData(treeChanged);
    provider.setOnNewLookup(newLookup);

    append(storePath, { query: "jwt", project: "app", filename: "summary.md", type: "summary" });
    provider.refresh();

    expect(treeChanged).toHaveBeenCalled();
    expect(newLookup).toHaveBeenCalledTimes(1);
    expect(newLookup.mock.calls[0][0].filename).toBe("summary.md");
  });

  it("does not re-notify when the newest lookup is unchanged", () => {
    provider = new PhrenActivityProvider(storePath);
    append(storePath, { query: "q", project: "app", filename: "a.md", type: "findings" });
    provider.refresh();

    const newLookup = vi.fn();
    provider.setOnNewLookup(newLookup);
    provider.refresh(); // same top event — should not fire
    expect(newLookup).not.toHaveBeenCalled();
  });

  it("skips malformed lines and survives a corrupt log", () => {
    provider = new PhrenActivityProvider(storePath);
    const p = lookupLog(storePath);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      "not json\n" +
        JSON.stringify({ at: new Date().toISOString(), project: "app", filename: "ok.md", type: "findings", source: "search" }) +
        "\n",
    );
    provider.refresh();
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0].filename).toBe("ok.md");
  });

  it("builds a tree item with location description, icon, and snippet tooltip", () => {
    provider = new PhrenActivityProvider(storePath);
    const ev = { at: new Date().toISOString(), query: "redis cache", project: "app", filename: "FINDINGS.md", type: "findings", snippet: "TTL is 300s", source: "search" };
    const item = provider.getTreeItem(ev);

    expect(item.label).toBe("FINDINGS.md");
    expect(String(item.description)).toContain("redis cache");
    // findings → lightbulb icon id
    expect((item.iconPath as { id: string }).id).toBe("lightbulb");
    const tooltip = item.tooltip as { value: string };
    expect(tooltip.value).toContain("app/FINDINGS.md");
    expect(tooltip.value).toContain("TTL is 300s");
  });

  it("caps the in-memory list at the most recent events", () => {
    provider = new PhrenActivityProvider(storePath);
    for (let i = 0; i < 80; i++) {
      append(storePath, { query: "q", project: "app", filename: `f${i}.md`, type: "findings" });
    }
    provider.refresh();
    const children = provider.getChildren();
    expect(children.length).toBeLessThanOrEqual(60);
    // Newest first → the last-appended file is on top.
    expect(children[0].filename).toBe("f79.md");
  });
});
