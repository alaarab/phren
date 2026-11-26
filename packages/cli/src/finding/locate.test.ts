import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { grantAdmin, initTestPhrenRoot, makeTempDir } from "../test-helpers.js";
import { PhrenError } from "../shared.js";
import { writeStoreRegistry } from "../store-registry.js";
import { iterateProjectFindings, locateFinding, rewriteFindingLine, type ProjectFinding } from "./locate.js";

const PROJECT = "proj";

const FINDINGS = [
  "# proj Findings",
  "",
  "## 2026-08-01",
  "",
  "- [pattern] Live finding one <!-- fid:aaaa0001 --> <!-- created: 2026-08-01 -->",
  "- Live finding two [confidence 0.80] <!-- fid:aaaa0002 -->",
  `  <!-- phren:cite {"created_at":"2026-08-01T00:00:00.000Z","symbol":"Widget.render"} -->`,
  "",
  "<details>",
  "<summary>Archived</summary>",
  "",
  "- Old history line <!-- fid:aaaa0003 -->",
  "</details>",
  "",
].join("\n");

const TOPIC = [
  "# proj — database",
  "",
  "## Archived 2026-02-01",
  "",
  `- Postgres advisory locks are per-session <!-- fid:bbbb0001 --> <!-- phren:status "superseded" -->`,
  "- Vacuum does not reclaim space held by an open transaction",
  "- Retry budget is per request <!-- fid:dddd0001 -->",
  "",
].join("\n");

// CRLF and no trailing newline, so a rewrite has both to preserve.
const OLDER = [
  "# proj — database (older archive)",
  "",
  "## Archived 2025-06-01",
  "",
  "- [pitfall] Connection pools leak on fork <!-- fid:cccc0001 -->",
  "- Vacuum does not reclaim space held by an open transaction",
  "- Retry budget is per call <!-- fid:dddd0001 -->",
].join("\r\n");

let tmp: ReturnType<typeof makeTempDir>;
let store: string;
let findingsFile: string;
let topicFile: string;
let olderFile: string;

beforeEach(() => {
  tmp = makeTempDir("phren-locate-");
  store = path.join(tmp.path, "store");
  grantAdmin(store);
  const topics = path.join(store, PROJECT, "reference", "topics");
  fs.mkdirSync(topics, { recursive: true });
  findingsFile = path.join(store, PROJECT, "FINDINGS.md");
  topicFile = path.join(topics, "database.md");
  olderFile = path.join(topics, "database.older.md");
  fs.writeFileSync(findingsFile, FINDINGS);
  fs.writeFileSync(topicFile, TOPIC);
  fs.writeFileSync(olderFile, OLDER);
});

afterEach(() => tmp.cleanup());

function located(selector: Parameters<typeof locateFinding>[2]): ProjectFinding {
  const result = locateFinding(store, PROJECT, selector);
  if (result.kind !== "found") throw new Error(`expected one finding for ${JSON.stringify(selector)}, got ${result.kind}`);
  return result.finding;
}

describe("iterateProjectFindings", () => {
  it("walks FINDINGS.md, each topic archive and each .older.md half, with file and line", () => {
    const rows = [...iterateProjectFindings(store, PROJECT)].map((f) => [path.basename(f.file), f.tier, f.lineIndex, f.fid, f.text, f.status, f.archived]);
    expect(rows).toEqual([
      ["FINDINGS.md", "active", 4, "aaaa0001", "[pattern] Live finding one", "active", false],
      ["FINDINGS.md", "active", 5, "aaaa0002", "Live finding two", "active", false],
      ["FINDINGS.md", "active", 11, "aaaa0003", "Old history line", "active", true],
      ["database.md", "topic", 4, "bbbb0001", "Postgres advisory locks are per-session", "superseded", false],
      ["database.md", "topic", 5, undefined, "Vacuum does not reclaim space held by an open transaction", "active", false],
      ["database.md", "topic", 6, "dddd0001", "Retry budget is per request", "active", false],
      ["database.older.md", "older", 4, "cccc0001", "[pitfall] Connection pools leak on fork", "active", false],
      ["database.older.md", "older", 5, undefined, "Vacuum does not reclaim space held by an open transaction", "active", false],
      ["database.older.md", "older", 6, "dddd0001", "Retry budget is per call", "active", false],
    ]);
  });

  it("carries the line exactly as stored and the citation from the line under it", () => {
    const [, two] = iterateProjectFindings(store, PROJECT);
    expect(two.line).toBe("- Live finding two [confidence 0.80] <!-- fid:aaaa0002 -->");
    expect(two.citation?.symbol).toBe("Widget.render");
    const older = [...iterateProjectFindings(store, PROJECT)].find((f) => f.fid === "cccc0001");
    expect(older?.line).toBe("- [pitfall] Connection pools leak on fork <!-- fid:cccc0001 -->");
  });

  it("finds a project that lives in an attached store", () => {
    const team = path.join(tmp.path, "team");
    initTestPhrenRoot(team);
    fs.mkdirSync(path.join(team, "team-proj"), { recursive: true });
    fs.writeFileSync(path.join(team, "team-proj", "FINDINGS.md"), "# team-proj Findings\n\n- Shared finding <!-- fid:eeee0001 -->\n");
    writeStoreRegistry(store, {
      version: 1,
      stores: [
        { id: "aaa11111", name: "personal", path: store, role: "primary", sync: "managed-git" },
        { id: "bbb22222", name: "work-shared", path: team, role: "team", sync: "managed-git" },
      ],
    });
    const result = locateFinding(store, "team-proj", "fid:eeee0001");
    expect(result.kind).toBe("found");
    if (result.kind !== "found") return;
    expect(result.finding.file).toBe(path.join(team, "team-proj", "FINDINGS.md"));
    expect(rewriteFindingLine(store, "team-proj", result.finding, (line) => `${line} <!-- x -->`).ok).toBe(true);
    expect(fs.readFileSync(result.finding.file, "utf8")).toBe("# team-proj Findings\n\n- Shared finding <!-- fid:eeee0001 --> <!-- x -->\n");
  });
});

describe("locateFinding", () => {
  it.each([
    ["a fid string", "fid:cccc0001", "database.older.md", 4],
    ["a fid in any case", { fid: "BBBB0001" }, "database.md", 4],
    ["text with comments, case and spacing ignored", "  [PATTERN] live   finding ONE ", "FINDINGS.md", 4],
    ["text missing the type tag", "Connection pools leak on fork", "database.older.md", 4],
  ] as const)("finds one finding by %s", (_label, selector, file, lineIndex) => {
    const finding = located(selector);
    expect([path.basename(finding.file), finding.lineIndex]).toEqual([file, lineIndex]);
  });

  it.each([
    ["the same text in a topic and its older half", "Vacuum does not reclaim space held by an open transaction", ["database.md", "database.older.md"]],
    ["a fid repeated inside the project", { fid: "dddd0001" }, ["database.md", "database.older.md"]],
  ] as const)("refuses %s as ambiguous, with the candidates", (_label, selector, files) => {
    const result = locateFinding(store, PROJECT, selector);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") expect(result.candidates.map((c) => path.basename(c.file))).toEqual(files);
  });

  it.each([
    ["an unknown fid", "fid:ffffffff"],
    ["part of a finding's text", "Postgres advisory locks"],
    ["a bare token that only looks like a fid", "aaaa0001"],
  ])("reports %s as not found", (_label, selector) => {
    expect(locateFinding(store, PROJECT, selector)).toEqual({ kind: "not_found" });
  });
});

describe("rewriteFindingLine", () => {
  it.each([
    ["FINDINGS.md (LF, trailing newline)", "fid:aaaa0002", () => findingsFile],
    [".older.md (CRLF, no trailing newline)", "fid:cccc0001", () => olderFile],
  ])("changes only that line in %s", (_label, selector, file) => {
    const before = fs.readFileSync(file());
    const finding = located(selector);
    const stamp = ` <!-- phren:status "retracted" -->`;

    const result = rewriteFindingLine(store, PROJECT, finding, (line) => line + stamp);

    expect(result.ok).toBe(true);
    const expected = Buffer.from(before.toString("utf8").replace(finding.line, finding.line + stamp), "utf8");
    expect(fs.readFileSync(file()).equals(expected)).toBe(true);
  });

  it.each([
    [
      "a bullet and its cite line from the middle of a list",
      "# t\n\n## Archived 2026-02-01\n\n- Keep one\n- Drop me\n  <!-- phren:cite {\"created_at\":\"2026-01-01T00:00:00.000Z\"} -->\n- Keep two\n",
      "# t\n\n## Archived 2026-02-01\n\n- Keep one\n- Keep two\n",
    ],
    [
      "the only bullet of a section, without leaving two blank lines",
      "# t\n\n## Archived 2026-01-01\n\n- Drop me\n\n## Archived 2026-02-01\n\n- Keep\n",
      "# t\n\n## Archived 2026-01-01\n\n## Archived 2026-02-01\n\n- Keep\n",
    ],
    [
      "the last bullet, without ending the file on a blank line",
      "# t\n\n## Archived 2026-01-01\n\n- Drop me\n",
      "# t\n\n## Archived 2026-01-01\n",
    ],
    [
      "a last line that has no newline, keeping the file without one",
      "# t\r\n\r\n- Keep\r\n- Drop me",
      "# t\r\n\r\n- Keep",
    ],
  ])("removes %s when the transform returns null", (_label, content, expected) => {
    fs.writeFileSync(topicFile, content);
    const result = rewriteFindingLine(store, PROJECT, located("Drop me"), () => null);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(topicFile, "utf8")).toBe(expected);
  });

  it("follows a finding whose lines moved after it was located", () => {
    const finding = located("fid:bbbb0001");
    fs.writeFileSync(topicFile, TOPIC.replace("## Archived 2026-02-01\n", "## Archived 2026-02-01\n\n- Archived meanwhile\n"));

    const result = rewriteFindingLine(store, PROJECT, finding, (line) => `${line} <!-- x -->`);

    expect(result.ok && result.data.lineIndex).toBe(finding.lineIndex + 2);
    expect(fs.readFileSync(topicFile, "utf8").split("\n")[finding.lineIndex + 2]).toBe(`${finding.line} <!-- x -->`);
  });

  const unfiledVacuum = (): ProjectFinding => [...iterateProjectFindings(store, PROJECT)].find((f) => f.tier === "topic" && !f.fid && f.text.startsWith("Vacuum"))!;

  it.each([
    ["the bullet was edited", () => located("fid:bbbb0001"), (t: string) => t.replace("per-session", "per-connection"), PhrenError.NOT_FOUND, /changed/],
    ["the bullet was removed", () => located("fid:bbbb0001"), (t: string) => t.replace(/^- Postgres.*\n/m, ""), PhrenError.NOT_FOUND, /vanished/],
    [
      "the bullet moved and a copy appeared",
      unfiledVacuum,
      (t: string) => t.replace("## Archived 2026-02-01\n", "## Archived 2026-02-01\n\n- Vacuum does not reclaim space held by an open transaction\n"),
      PhrenError.AMBIGUOUS_MATCH,
      /moved/,
    ],
  ])("refuses when %s between locate and rewrite", (_label, locate, edit, code, message) => {
    const finding = locate();
    fs.writeFileSync(topicFile, edit(TOPIC));
    const edited = fs.readFileSync(topicFile);

    const result = rewriteFindingLine(store, PROJECT, finding, () => null);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(code);
      expect(result.error).toMatch(message);
    }
    expect(fs.readFileSync(topicFile).equals(edited)).toBe(true);
  });

  it.each([
    ["a bullet in a legacy archive block", () => located("fid:aaaa0003"), (line: string) => `${line} <!-- x -->`],
    ["a file outside the project's findings", () => ({ ...located("fid:aaaa0001"), file: path.join(store, PROJECT, "review.md") }), (line: string) => line],
    ["a transform that returns two lines", () => located("fid:aaaa0001"), (line: string) => `${line}\n- smuggled`],
  ])("refuses %s and writes nothing", (_label, handle, transform) => {
    const before = fs.readFileSync(findingsFile);
    const result = rewriteFindingLine(store, PROJECT, handle(), transform);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(PhrenError.VALIDATION_ERROR);
    expect(fs.readFileSync(findingsFile).equals(before)).toBe(true);
  });
});
