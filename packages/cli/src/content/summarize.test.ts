import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { KNOWS_START, NOW_END, NOW_START, digestTopic, mostMentioned, parseTopicBullets, readKnowsBlock, splitTopicFile, structuralNow, summarizeProject, summarizeTopicFile, upsertBlock } from "./summarize.js";
import { writeRootManifest } from "../shared.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "phren-sum-")); dirs.push(d); return d; };

function topicDoc(sections: Array<[string, string[]]>): string {
  const head = "# demo · api\n\n> Archived findings about the API layer.\n\n";
  return head + sections.map(([date, bullets]) => `## Archived ${date}\n\n${bullets.join("\n")}\n`).join("\n");
}

describe("parseTopicBullets", () => {
  it("reads bullets under archived sections with their date and tag, skipping the Now block", () => {
    const doc = topicDoc([["2026-03-01", ["- [pattern] RetryPolicy caps at five", "- [pitfall] Pool of 20 stalls <!-- fid:1 -->"]], ["2026-05-02", ["- plain bullet without a tag"]]]);
    const withNow = upsertBlock(doc, NOW_START, NOW_END, `${NOW_START}\n## Now\n\n- not a finding\n${NOW_END}`, "top");
    const bullets = parseTopicBullets(withNow);
    expect(bullets).toEqual([
      { date: "2026-03-01", tag: "pattern", text: "RetryPolicy caps at five" },
      { date: "2026-03-01", tag: "pitfall", text: "Pool of 20 stalls" },
      { date: "2026-05-02", tag: "untagged", text: "plain bullet without a tag" },
    ]);
  });
});

describe("digest and structural paragraph", () => {
  it("counts, spans, names what recurs, and quotes the newest", () => {
    const bullets = parseTopicBullets(topicDoc([
      ["2026-03-01", ["- [pattern] RetryPolicy wraps calls", "- [pattern] RetryPolicy caps at five", "- [bug] `azure-storage-blob` is dead weight"]],
      ["2026-06-01", ["- [pitfall] Rails 8 removed ActiveStorage azure service; RetryPolicy unaffected"]],
    ]));
    const d = digestTopic("api", "/x/api.md", bullets);
    expect(d.bullets).toBe(4);
    expect(d.tags).toEqual({ pattern: 2, bug: 1, pitfall: 1 });
    expect(d.first).toBe("2026-03-01");
    expect(d.last).toBe("2026-06-01");
    expect(d.mentioned[0]).toBe("RetryPolicy");
    const now = structuralNow(d);
    expect(now).toContain("4 findings, archived between 2026-03-01 and 2026-06-01: 2 patterns, 1 bug, 1 pitfall.");
    expect(now).toContain("Keeps coming back to RetryPolicy");
    expect(now).toContain("(1) Rails 8 removed ActiveStorage azure service");
  });

  it("does not count common words as things mentioned", () => {
    const bullets = [
      { date: "", tag: "x", text: "The Rails app uses RetryPolicy. NEVER skip it." },
      { date: "", tag: "x", text: "RetryPolicy again; the app ALWAYS retries." },
    ];
    // A name mentioned in two bullets counts; a word mentioned twice in one does not; shouting is not a name.
    expect(mostMentioned(bullets)).toEqual(["RetryPolicy"]);
  });
});

describe("upsertBlock", () => {
  it("inserts before the first section and replaces on the next run", () => {
    const doc = topicDoc([["2026-03-01", ["- [pattern] a"]]]);
    const once = upsertBlock(doc, NOW_START, NOW_END, `${NOW_START.replace("-->", "at=1 -->")}\n## Now\n\nfirst\n${NOW_END}`, "top");
    expect(once.indexOf("## Now")).toBeLessThan(once.indexOf("## Archived"));
    const twice = upsertBlock(once, NOW_START, NOW_END, `${NOW_START.replace("-->", "at=2 -->")}\n## Now\n\nsecond\n${NOW_END}`, "top");
    expect(twice).toContain("second");
    expect(twice).not.toContain("first");
    expect(twice.match(/## Now/g)).toHaveLength(1);
    expect(parseTopicBullets(twice)).toHaveLength(1);
  });
});

describe("splitTopicFile", () => {
  it("moves the oldest sections out once the file passes the cap, keeping the newest", () => {
    const dir = tmp();
    const file = path.join(dir, "api.md");
    const sections: Array<[string, string[]]> = [];
    for (let m = 1; m <= 6; m++) sections.push([`2026-0${m}-01`, Array.from({ length: 100 }, (_, i) => `- [pattern] month ${m} item ${i}`)]);
    fs.writeFileSync(file, topicDoc(sections));
    const older = splitTopicFile(file, 350);
    expect(older).toBe(path.join(dir, "api.older.md"));
    const kept = parseTopicBullets(fs.readFileSync(file, "utf8"));
    const moved = parseTopicBullets(fs.readFileSync(older!, "utf8"));
    expect(kept).toHaveLength(300);
    expect(moved).toHaveLength(300);
    expect(kept[0].date).toBe("2026-04-01");
    expect(moved[0].date).toBe("2026-01-01");
    expect(kept.length + moved.length).toBe(600);
    expect(splitTopicFile(file, 350)).toBeNull();
  });
});

describe("summarizeTopicFile", () => {
  it("writes a Now block, leaves the bullets alone, and skips an unchanged file next time", async () => {
    const dir = tmp();
    const file = path.join(dir, "api.md");
    fs.writeFileSync(file, topicDoc([["2026-03-01", ["- [pattern] RetryPolicy caps at five"]]]));
    const t0 = new Date("2026-09-05T10:00:00Z");
    const first = await summarizeTopicFile(file, "api", { now: () => t0 });
    expect(first.updated).toBe(true);
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("## Now");
    expect(content).toContain("1 finding, archived on 2026-03-01: 1 pattern.");
    expect(parseTopicBullets(content)).toHaveLength(1);
    const again = await summarizeTopicFile(file, "api", { now: () => new Date("2026-09-05T11:00:00Z") });
    expect(again.updated).toBe(false);
    expect(again.now).toContain("1 finding, archived");
    const forced = await summarizeTopicFile(file, "api", { force: true, now: () => new Date("2026-09-05T12:00:00Z") });
    expect(forced.updated).toBe(true);
  });
});

describe("summarizeProject", () => {
  it("writes What phren knows into summary.md and the hook can read it back", async () => {
    const dir = tmp();
    writeRootManifest(dir, { version: 1, installMode: "shared", syncMode: "managed-git" });
    const proj = path.join(dir, "demo");
    fs.mkdirSync(path.join(proj, "reference", "topics"), { recursive: true });
    fs.writeFileSync(path.join(proj, "FINDINGS.md"), "# demo\n\n## 2026-09-01\n\n- [pattern] live one\n- [pitfall] live two\n");
    fs.writeFileSync(path.join(proj, "tasks.md"), "# demo\n\n## Active\n\n## Queue\n\n- [ ] ship\n- [ ] test\n\n## Done\n\n- [x] old\n");
    fs.writeFileSync(path.join(proj, "summary.md"), "# demo\n\nA demo project.\n");
    fs.writeFileSync(path.join(proj, "reference", "topics", "api.md"), topicDoc([["2026-03-01", ["- [pattern] RetryPolicy caps at five", "- [bug] Pool stalls"]]]));
    const result = await summarizeProject(dir, "demo", { now: () => new Date("2026-09-05T10:00:00Z") });
    expect(result.summaryUpdated).toBe(true);
    expect(result.topics.map((t) => t.slug)).toContain("api");
    const summary = fs.readFileSync(path.join(proj, "summary.md"), "utf8");
    expect(summary.startsWith("# demo\n\nA demo project.")).toBe(true); // nothing above the block touched
    expect(summary).toContain("## What phren knows");
    expect(summary).toContain("2 active findings, 2 archived across 1 topic, 2 open tasks.");
    expect(summary).toContain("**api** — 2 findings, archived on 2026-03-01: 1 pattern, 1 bug.");
    const knows = readKnowsBlock(dir, "demo");
    expect(knows?.text).toContain("2 active findings");
    expect(knows?.text.startsWith("## What phren knows")).toBe(true);
    // Idempotent.
    const again = await summarizeProject(dir, "demo", { now: () => new Date("2026-09-05T10:05:00Z") });
    expect(again.summaryUpdated).toBe(false);
    expect(fs.readFileSync(path.join(proj, "summary.md"), "utf8").match(new RegExp(KNOWS_START.slice(0, 18), "g"))).toHaveLength(1);
  });
});
