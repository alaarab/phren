import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { grantAdmin, makeTempDir } from "./test-helpers.js";
import { addNote, editNote, getNote, listNotes, removeNote } from "./data/notes.js";
import { promoteNote } from "./core/note.js";
import { buildIndex, queryRows } from "./shared/index.js";
import { buildGraph } from "./ui/data.js";

describe("daily notes", () => {
  let phrenPath: string;

  beforeEach(() => {
    phrenPath = makeTempDir("phren-notes-").path;
    fs.mkdirSync(path.join(phrenPath, "sample"), { recursive: true });
    grantAdmin(phrenPath);
  });

  afterEach(() => {
    fs.rmSync(phrenPath, { recursive: true, force: true });
  });

  it("stores multiline notes in a daily Markdown file and lists newest first", () => {
    const first = addNote(phrenPath, "sample", "First line\n\nMore detail", {
      date: "2026-07-19",
      now: new Date("2026-07-19T08:00:01.000Z"),
    });
    const second = addNote(phrenPath, "sample", "Today's note", {
      date: "2026-07-20",
      now: new Date("2026-07-20T14:03:02.000Z"),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const listed = listNotes(phrenPath, "sample");
    expect(listed.ok && listed.data.map((note) => note.text)).toEqual(["Today's note", "First line\n\nMore detail"]);
    expect(fs.readFileSync(path.join(phrenPath, "sample", "notes", "2026-07-20.md"), "utf8"))
      .toContain("## 14:03:02 <!-- nid:");
  });

  it("edits and removes notes by stable nid", () => {
    const added = addNote(phrenPath, "sample", "Draft", { now: new Date("2026-07-20T10:00:00.000Z") });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const edited = editNote(phrenPath, "sample", added.data.id, "Final\nversion");
    expect(edited.ok && edited.data.text).toBe("Final\nversion");
    expect(getNote(phrenPath, "sample", added.data.stableId).ok).toBe(true);

    const removed = removeNote(phrenPath, "sample", added.data.stableId);
    expect(removed.ok).toBe(true);
    const listed = listNotes(phrenPath, "sample");
    expect(listed.ok && listed.data).toEqual([]);
    expect(fs.existsSync(added.data.path)).toBe(false);
  });

  it("rejects empty notes, invalid dates, and secrets", () => {
    expect(addNote(phrenPath, "sample", "   ").ok).toBe(false);
    expect(addNote(phrenPath, "sample", "hello", { date: "2026-02-31" }).ok).toBe(false);
    expect(addNote(phrenPath, "sample", "token sk-proj-abcdefghijklmnopqrstuvwxyz1234567890").ok).toBe(false);
  });

  it("promotes a note to a finding without removing the source note", () => {
    const added = addNote(phrenPath, "sample", "Keep the adapter boundary small", {
      now: new Date("2026-07-20T12:00:00.000Z"),
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const promoted = promoteNote(phrenPath, "sample", added.data.id, "pattern");
    expect(promoted.ok).toBe(true);
    const source = getNote(phrenPath, "sample", added.data.id);
    expect(source.ok && source.data.promoted).toBe(true);
    expect(fs.readFileSync(path.join(phrenPath, "sample", "FINDINGS.md"), "utf8"))
      .toContain("[pattern] Keep the adapter boundary small");
    expect(promoteNote(phrenPath, "sample", added.data.id).ok).toBe(false);
  });

  it("indexes notes for explicit search while keeping them out of the graph", async () => {
    const phrase = "quartz notebook observation";
    expect(addNote(phrenPath, "sample", phrase).ok).toBe(true);
    const db = await buildIndex(phrenPath);
    try {
      const rows = queryRows(db, "SELECT type, content FROM docs WHERE docs MATCH ?", ["quartz"]);
      expect(rows?.some((row) => row[0] === "notes" && String(row[1]).includes(phrase))).toBe(true);
    } finally {
      db.close();
    }
    const graph = await buildGraph(phrenPath);
    expect(graph.nodes.some((node) => node.fullLabel.includes(phrase))).toBe(false);
  });
});
