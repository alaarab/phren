import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import {
  PhrenError,
  forwardErr,
  phrenErr,
  phrenOk,
  type PhrenResult,
} from "../shared.js";
import { scanForSecrets } from "../content/dedup.js";
import { atomicWriteText } from "../phren-paths.js";
import { ensureProject, withSafeLock } from "../shared/data-utils.js";

export const NOTES_DIRNAME = "notes";
export const MAX_NOTE_LENGTH = 10_000;

export interface NoteItem {
  id: string;
  stableId: string;
  project: string;
  date: string;
  time: string;
  text: string;
  promoted: boolean;
  path: string;
}

export interface ListNotesOptions {
  date?: string;
  limit?: number;
}

export interface AddNoteOptions {
  date?: string;
  now?: Date;
}

const NOTE_HEADING_RE = /^##\s+(\d{2}:\d{2}(?::\d{2})?)\s+<!--\s*nid:([a-f0-9]{8})\s*-->(?:\s+<!--\s*promoted\s*-->)?\s*$/i;

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function notesDirectory(projectDir: string): string {
  return path.join(projectDir, NOTES_DIRNAME);
}

export function noteFilePath(phrenPath: string, project: string, date: string): PhrenResult<string> {
  if (!isValidDate(date)) {
    return phrenErr(`Invalid note date "${date}". Use YYYY-MM-DD.`, PhrenError.VALIDATION_ERROR);
  }
  const ensured = ensureProject(phrenPath, project);
  if (!ensured.ok) return forwardErr(ensured);
  return phrenOk(path.join(notesDirectory(ensured.data), `${date}.md`));
}

function normalizeNoteText(text: string): PhrenResult<string> {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return phrenErr("Note text cannot be empty.", PhrenError.EMPTY_INPUT);
  if (normalized.length > MAX_NOTE_LENGTH) {
    return phrenErr(`Note text exceeds ${MAX_NOTE_LENGTH} characters.`, PhrenError.VALIDATION_ERROR);
  }
  const secret = scanForSecrets(normalized);
  if (secret) {
    return phrenErr(`Rejected: note appears to contain a secret (${secret}). Strip credentials before saving.`, PhrenError.VALIDATION_ERROR);
  }
  // An exact internal heading inside a note would otherwise be parsed as a new note.
  return phrenOk(normalized.split("\n").map((line) => NOTE_HEADING_RE.test(line) ? `#${line}` : line).join("\n"));
}

function parseDailyFile(filePath: string, project: string, date: string): NoteItem[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const items: NoteItem[] = [];
  let current: { stableId: string; time: string; promoted: boolean; body: string[] } | null = null;

  const finish = () => {
    if (!current) return;
    const text = current.body.join("\n").trim();
    if (text) {
      items.push({
        id: `nid:${current.stableId}`,
        stableId: current.stableId,
        project,
        date,
        time: current.time.length === 5 ? `${current.time}:00` : current.time,
        text,
        promoted: current.promoted,
        path: filePath,
      });
    }
  };

  for (const line of lines) {
    const match = line.match(NOTE_HEADING_RE);
    if (match) {
      finish();
      current = {
        time: match[1],
        stableId: match[2].toLowerCase(),
        promoted: /<!--\s*promoted\s*-->/i.test(line),
        body: [],
      };
    } else if (current) {
      current.body.push(line);
    }
  }
  finish();
  return items;
}

function renderDailyFile(project: string, date: string, notes: NoteItem[]): string {
  const entries = notes.map((note) => {
    const promoted = note.promoted ? " <!-- promoted -->" : "";
    return `## ${note.time} <!-- nid:${note.stableId} -->${promoted}\n\n${note.text}`;
  });
  return `# ${project} Notes — ${date}\n${entries.length ? `\n${entries.join("\n\n")}\n` : ""}`;
}

function selectorMatches(note: NoteItem, selector: string): boolean {
  const query = selector.trim().toLowerCase();
  if (!query) return false;
  const stable = query.startsWith("nid:") ? query.slice(4) : query;
  return note.stableId === stable || note.id === query || note.text.toLowerCase() === query || note.text.toLowerCase().includes(query);
}

function resolveNote(notes: NoteItem[], selector: string): PhrenResult<NoteItem> {
  const matches = notes.filter((note) => selectorMatches(note, selector));
  if (matches.length === 0) return phrenErr(`No note matching "${selector}" was found.`, PhrenError.NOT_FOUND);
  if (matches.length > 1) {
    return phrenErr(`Multiple notes match "${selector}". Use a stable nid: ${matches.map((note) => note.id).join(", ")}.`, PhrenError.AMBIGUOUS_MATCH);
  }
  return phrenOk(matches[0]);
}

export function listNotes(phrenPath: string, project: string, options: ListNotesOptions = {}): PhrenResult<NoteItem[]> {
  const ensured = ensureProject(phrenPath, project);
  if (!ensured.ok) return forwardErr(ensured);
  if (options.date && !isValidDate(options.date)) {
    return phrenErr(`Invalid note date "${options.date}". Use YYYY-MM-DD.`, PhrenError.VALIDATION_ERROR);
  }
  const dir = notesDirectory(ensured.data);
  if (!fs.existsSync(dir)) return phrenOk([]);
  const files = fs.readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .filter((name) => !options.date || name === `${options.date}.md`)
    .sort((a, b) => b.localeCompare(a));
  const notes = files.flatMap((name) => parseDailyFile(path.join(dir, name), project, name.slice(0, 10)))
    .sort((a, b) => `${b.date}T${b.time}`.localeCompare(`${a.date}T${a.time}`));
  const limit = options.limit === undefined ? notes.length : Math.max(0, Math.floor(options.limit));
  return phrenOk(notes.slice(0, limit));
}

export function getNote(phrenPath: string, project: string, selector: string): PhrenResult<NoteItem> {
  const notes = listNotes(phrenPath, project);
  if (!notes.ok) return forwardErr(notes);
  return resolveNote(notes.data, selector);
}

export function addNote(phrenPath: string, project: string, text: string, options: AddNoteOptions = {}): PhrenResult<NoteItem> {
  const normalized = normalizeNoteText(text);
  if (!normalized.ok) return forwardErr(normalized);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) return phrenErr("Invalid note timestamp.", PhrenError.VALIDATION_ERROR);
  const date = options.date ?? now.toISOString().slice(0, 10);
  const file = noteFilePath(phrenPath, project, date);
  if (!file.ok) return forwardErr(file);

  return withSafeLock(file.data, () => {
    const existing = parseDailyFile(file.data, project, date);
    let stableId = randomBytes(4).toString("hex");
    while (existing.some((note) => note.stableId === stableId)) stableId = randomBytes(4).toString("hex");
    const note: NoteItem = {
      id: `nid:${stableId}`,
      stableId,
      project,
      date,
      time: now.toISOString().slice(11, 19),
      text: normalized.data,
      promoted: false,
      path: file.data,
    };
    atomicWriteText(file.data, renderDailyFile(project, date, [...existing, note]));
    return phrenOk(note);
  });
}

function mutateNote(
  phrenPath: string,
  project: string,
  selector: string,
  mutate: (note: NoteItem) => NoteItem | null,
): PhrenResult<NoteItem> {
  const found = getNote(phrenPath, project, selector);
  if (!found.ok) return forwardErr(found);
  return withSafeLock(found.data.path, () => {
    const notes = parseDailyFile(found.data.path, project, found.data.date);
    const current = resolveNote(notes, found.data.stableId);
    if (!current.ok) return forwardErr(current);
    const updated = mutate(current.data);
    const next = updated
      ? notes.map((note) => note.stableId === current.data.stableId ? updated : note)
      : notes.filter((note) => note.stableId !== current.data.stableId);
    if (next.length === 0) fs.unlinkSync(found.data.path);
    else atomicWriteText(found.data.path, renderDailyFile(project, found.data.date, next));
    return phrenOk(updated ?? current.data);
  });
}

export function editNote(phrenPath: string, project: string, selector: string, text: string): PhrenResult<NoteItem> {
  const normalized = normalizeNoteText(text);
  if (!normalized.ok) return forwardErr(normalized);
  return mutateNote(phrenPath, project, selector, (note) => ({ ...note, text: normalized.data }));
}

export function removeNote(phrenPath: string, project: string, selector: string): PhrenResult<NoteItem> {
  return mutateNote(phrenPath, project, selector, () => null);
}

export function markNotePromoted(phrenPath: string, project: string, selector: string): PhrenResult<NoteItem> {
  return mutateNote(phrenPath, project, selector, (note) => ({ ...note, promoted: true }));
}
