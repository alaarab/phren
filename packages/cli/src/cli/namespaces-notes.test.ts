import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantAdmin } from "../test-helpers.js";

const NOTE_DATE = "2026-07-19";
const NID = /nid:[a-f0-9]{8}/;

let root = "";
let phrenPath = "";

function noteFile(project: string, date = NOTE_DATE): string {
  return path.join(phrenPath, project, "notes", `${date}.md`);
}

async function run(...args: string[]): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    out.push(values.map(String).join(" "));
  });
  const error = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    err.push(values.map(String).join(" "));
  });
  process.exitCode = 0;
  try {
    const { handleNoteNamespace } = await import("./namespaces-notes.js");
    await handleNoteNamespace(args, "");
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return { out: out.join("\n"), err: err.join("\n"), code: process.exitCode ?? 0 };
}

async function addNote(project: string, text: string, date = NOTE_DATE): Promise<string> {
  const result = await run("add", project, text, "--date", date);
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  const nid = result.out.match(NID)?.[0];
  expect(nid).toBeTruthy();
  return nid as string;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "phren-notes-cli-"));
  phrenPath = path.join(root, ".phren");
  mkdirSync(phrenPath, { recursive: true });
  grantAdmin(phrenPath);
  mkdirSync(path.join(phrenPath, "sample"), { recursive: true });
  mkdirSync(path.join(phrenPath, "empty"), { recursive: true });
  vi.stubEnv("PHREN_PATH", phrenPath);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = 0;
  rmSync(root, { recursive: true, force: true });
});

describe("phren note", () => {
  it("add writes the note into the dated daily file and prints its nid and date", async () => {
    const result = await run("add", "sample", "First line", "More detail", "--date", NOTE_DATE);

    const nid = result.out.match(NID)?.[0];
    expect(nid).toBeTruthy();
    expect(result.out).toBe(`Note added: ${nid} (${NOTE_DATE})`);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);

    const content = readFileSync(noteFile("sample"), "utf8");
    expect(content.startsWith(`# sample Notes — ${NOTE_DATE}\n\n`)).toBe(true);
    expect(content).toMatch(/^## \d{2}:\d{2}:\d{2} <!-- nid:[a-f0-9]{8} -->$/m);
    expect(content).toContain(`<!-- ${nid} -->`);
    expect(content.endsWith("\n\nFirst line More detail\n")).toBe(true);
  });

  it("add rejects an impossible calendar date and empty text without creating a notes file", async () => {
    const badDate = await run("add", "sample", "note text", "--date", "2026-02-31");
    expect(badDate).toEqual({ out: "", err: 'Invalid note date "2026-02-31". Use YYYY-MM-DD.', code: 1 });

    const empty = await run("add", "sample");
    expect(empty).toEqual({ out: "", err: "Note text cannot be empty.", code: 1 });

    expect(existsSync(path.join(phrenPath, "sample", "notes"))).toBe(false);
  });

  it("list prints notes newest first with indented multiline text and filters by --date", async () => {
    await addNote("sample", "oldest note", "2026-07-18");
    await addNote("sample", "newest note", "2026-07-20");
    await addNote("sample", "middle line one\nmiddle line two");

    const all = await run("list", "sample");
    expect(all.code).toBe(0);
    expect(all.err).toBe("");
    const newest = all.out.indexOf("2026-07-20 ");
    const middle = all.out.indexOf("2026-07-19 ");
    const oldest = all.out.indexOf("2026-07-18 ");
    expect(newest).toBeGreaterThanOrEqual(0);
    expect(newest).toBeLessThan(middle);
    expect(middle).toBeLessThan(oldest);
    expect(all.out).toContain("  newest note");
    expect(all.out).toContain("  middle line one\n  middle line two");
    expect(all.out).toMatch(/^2026-07-20 \d{2}:\d{2}  nid:[a-f0-9]{8}$/m);

    const filtered = await run("list", "sample", "--date", NOTE_DATE);
    expect(filtered.code).toBe(0);
    expect(filtered.out).toContain("middle line one");
    expect(filtered.out).not.toContain("newest note");
    expect(filtered.out).not.toContain("oldest note");

    const none = await run("list", "empty");
    expect(none).toEqual({ out: 'No notes found for "empty".', err: "", code: 0 });
  });

  it("list rejects a --limit that is not a positive integer", async () => {
    await addNote("sample", "only note");

    for (const limit of ["0", "-2", "abc"]) {
      const result = await run("list", "sample", "--limit", limit);
      expect(result).toEqual({ out: "", err: "--limit must be a positive integer.", code: 1 });
    }

    const limited = await run("list", "sample", "--limit=1");
    expect(limited.code).toBe(0);
    expect(limited.out).toMatch(/^2026-07-19 \d{2}:\d{2}  nid:[a-f0-9]{8}\n  only note$/);
  });

  it("edit rewrites text by nid and refuses an ambiguous text selector", async () => {
    const nid = await addNote("sample", "Draft note");

    const edited = await run("edit", "sample", nid, "Final", "version");
    expect(edited).toEqual({ out: `Updated ${nid}.`, err: "", code: 0 });
    const content = readFileSync(noteFile("sample"), "utf8");
    expect(content.endsWith("\n\nFinal version\n")).toBe(true);
    expect(content).not.toContain("Draft note");

    const first = await addNote("sample", "shared phrase", "2026-07-18");
    const second = await addNote("sample", "shared phrase", "2026-07-20");

    const ambiguous = await run("edit", "sample", "shared phrase", "changed");
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.out).toBe("");
    expect(ambiguous.err).toMatch(/^Multiple notes match "shared phrase"\. Use a stable nid: nid:[a-f0-9]{8}, nid:[a-f0-9]{8}\.$/);
    expect(ambiguous.err).toContain(first);
    expect(ambiguous.err).toContain(second);
  });

  it("remove deletes the last note and its daily file", async () => {
    const nid = await addNote("sample", "Only note");

    const removed = await run("remove", "sample", nid);
    expect(removed).toEqual({ out: `Removed ${nid}.`, err: "", code: 0 });
    expect(existsSync(noteFile("sample"))).toBe(false);

    const listed = await run("list", "sample");
    expect(listed).toEqual({ out: 'No notes found for "sample".', err: "", code: 0 });
  });

  it("promote writes a typed finding, marks the source, and refuses a repeat or unknown type", async () => {
    const nid = await addNote("sample", "Keep the adapter boundary small");

    const promoted = await run("promote", "sample", nid, "--type", "pattern");
    expect(promoted).toEqual({ out: `Promoted ${nid} to a finding.`, err: "", code: 0 });
    expect(readFileSync(path.join(phrenPath, "sample", "FINDINGS.md"), "utf8"))
      .toContain("[pattern] Keep the adapter boundary small");
    expect(readFileSync(noteFile("sample"), "utf8")).toContain("<!-- promoted -->");

    const listed = await run("list", "sample", "--date", NOTE_DATE);
    expect(listed.out).toContain(`  [promoted]`);
    expect(listed.out).toContain("  Keep the adapter boundary small");

    const again = await run("promote", "sample", nid, "--type", "bug");
    expect(again).toEqual({ out: "", err: `Note ${nid} has already been promoted.`, code: 1 });

    const other = await addNote("sample", "Another observation", "2026-07-20");
    const invalid = await run("promote", "sample", other, "--type", "bananas");
    expect(invalid).toEqual({
      out: "",
      err: 'Invalid finding type "bananas". Use: decision, pitfall, pattern, bug.',
      code: 1,
    });
    expect(readFileSync(path.join(phrenPath, "sample", "FINDINGS.md"), "utf8")).not.toContain("Another observation");
    expect(readFileSync(noteFile("sample", "2026-07-20"), "utf8")).not.toContain("<!-- promoted -->");
  });

  it("prints usage when the project is missing or the subcommand is unknown", async () => {
    const missingProject = await run("list");
    expect(missingProject.code).toBe(1);
    expect(missingProject.err).toBe("");
    expect(missingProject.out).toContain("Usage:");
    expect(missingProject.out).toContain('phren note add <project> "<text>" [--date YYYY-MM-DD]');

    const unknown = await run("bogus", "sample", "nid:00000000");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toBe("Unknown note subcommand: bogus");
    expect(unknown.out).toContain("Usage:");
  });
});
