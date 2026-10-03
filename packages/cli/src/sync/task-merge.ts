import { parseTaskMetadata, type TaskMetadata } from "../data/task-metadata.js";
/**
 * Three-way merge of a tasks.md file by task id, for store sync conflicts.
 *
 * Each task is keyed by its `bid:` comment (or its normalized text when it has
 * none) and compared across the merge base, the local side and the incoming
 * side. The side that changed a task wins; when both changed it, a completed
 * side wins, then an edit beats a removal, then the incoming side wins. The
 * result keeps the incoming file's layout and section order.
 */

const BID_PATTERN = /<!--\s*bid:([a-z0-9]{8})\b[^>]*-->/;
const COMPLETED_PATTERN = /^- \[[xX]\]/;

interface TaskEntry { key: string; section: string; lines: string[] }
type Row = { kind: "task"; entry: TaskEntry } | { kind: "line"; text: string };
interface Section { heading: string | null; name: string; rows: Row[] }

function taskKey(bullet: string): string {
  const bid = BID_PATTERN.exec(bullet);
  if (bid) return `bid:${bid[1]}`;
  return `text:${bullet.replace(/^- \[[ xX]\]\s*/, "").replace(/<!--[\s\S]*?-->/g, "").trim().toLowerCase()}`;
}

/** Splits a tasks file into a preamble and `## ` sections of task records and other lines. */
function parse(content: string): Section[] {
  const sections: Section[] = [{ heading: null, name: "", rows: [] }];
  let current = sections[0];
  let task: TaskEntry | null = null;
  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("## ")) {
      task = null;
      current = { heading: line, name: line.slice(3).trim(), rows: [] };
      sections.push(current);
    } else if (line.startsWith("- ") && current.heading !== null) {
      task = { key: taskKey(line), section: current.name, lines: [line] };
      current.rows.push({ kind: "task", entry: task });
    } else if (task && line.startsWith("  ") && line.trim()) {
      task.lines.push(line);
    } else {
      task = null;
      current.rows.push({ kind: "line", text: line });
    }
  }
  return sections;
}

function index(sections: Section[]): Map<string, TaskEntry> {
  const map = new Map<string, TaskEntry>();
  for (const section of sections) {
    for (const row of section.rows) {
      if (row.kind === "task" && !map.has(row.entry.key)) map.set(row.entry.key, row.entry);
    }
  }
  return map;
}

const value = (entry: TaskEntry | undefined): string | undefined =>
  entry ? `${entry.section}\n${entry.lines.join("\n")}` : undefined;
const completed = (entry: TaskEntry | undefined): boolean => !!entry && COMPLETED_PATTERN.test(entry.lines[0]);

/** The winning version of one task, or undefined when it is removed. */
export function pickTask<T extends TaskEntry>(base: T | undefined, ours: T | undefined, theirs: T | undefined): T | undefined {
  const [b, o, t] = [value(base), value(ours), value(theirs)];
  if (o === t) return theirs;
  if (o === b) return theirs;
  if (t === b) return ours;
  if (completed(ours) !== completed(theirs)) return completed(ours) ? ours : theirs;
  if (!theirs) return ours;
  return theirs;
}

/** Merge independent responsibility/dependency edits and retain both histories.
 * Ordinary task conflict precedence still controls title, claim and section. */
function mergeContract(base: TaskEntry | undefined, ours: TaskEntry | undefined, theirs: TaskEntry | undefined, winner: TaskEntry): TaskEntry {
  const read = (entry: TaskEntry | undefined): { raw?: string; value?: TaskMetadata } => {
    const records = entry?.lines.filter(line => line.trimStart().startsWith("Task:")) ?? [];
    if (!records.length) return { value: { version: 1, responsibility: "agent", dependencies: [], history: [] } };
    if (records.length !== 1) return { raw: records.join("\n") };
    return { raw: records[0], value: parseTaskMetadata(records[0].trim().slice(5).trim()) };
  };
  const b = read(base), o = read(ours), t = read(theirs);
  if (o.raw === undefined && t.raw === undefined) return winner;
  if (!b.value || !o.value || !t.value) return winner;
  const baseValue = b.value, ourValue = o.value, theirValue = t.value;
  const pick = (field: "responsibility" | "dependencies") => JSON.stringify(theirValue[field]) === JSON.stringify(baseValue[field]) ? ourValue[field] : theirValue[field];
  const history = [...new Map([...o.value.history, ...t.value.history].map(h => [JSON.stringify(h), h] as const)).values()];
  const contract = { version: 1, responsibility: pick("responsibility"), dependencies: pick("dependencies"), history };
  let lines = winner.lines.filter(line => !line.trimStart().startsWith("Task:"));
  if (contract.responsibility === "human") {
    lines = lines.filter(line => {
      const claim = /^Claimed:\s+([A-Za-z0-9][A-Za-z0-9._-]{0,252})\s+(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)(?:\s+session:[A-Za-z0-9._:-]{1,128})?$/.exec(line.trim());
      if (!claim) return true;
      history.push({ at: history.at(-1)?.at ?? claim[2], change: `released claim by ${claim[1]} during human responsibility merge` });
      return false;
    });
  }
  return { ...winner, lines: [...lines, `  Task: ${JSON.stringify(contract)}`] };
}

/**
 * Merges three versions of a tasks.md. `base` is empty when the file was
 * added on both sides.
 */
export function mergeTasksByBid(base: string, ours: string, theirs: string): string {
  const oursSections = parse(ours);
  const theirsSections = parse(theirs);
  const b = index(parse(base));
  const o = index(oursSections);
  const t = index(theirsSections);

  // A duplicated identity cannot be reconciled by first-win indexing. Leave
  // the sync conflict unresolved, retaining both original files for repair.
  for (const sections of [parse(base), oursSections, theirsSections]) {
    const seen = new Set<string>();
    for (const section of sections) for (const row of section.rows) {
      if (row.kind !== "task" || !row.entry.key.startsWith("bid:")) continue;
      if (seen.has(row.entry.key) || [...row.entry.lines[0].matchAll(/<!--\s*bid:([a-f0-9]{8})\b[^>]*-->/g)].length !== 1) {
        throw new Error("Task merge requires unique, unambiguous stable IDs; repair the conflicting records first.");
      }
      seen.add(row.entry.key);
    }
  }

  const chosen = new Map<string, TaskEntry>();
  for (const key of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
    const winner = pickTask(b.get(key), o.get(key), t.get(key));
    if (winner) chosen.set(key, mergeContract(b.get(key), o.get(key), t.get(key), winner));
  }

  // Local order, per section, so a task only the local side placed there lands after its local predecessor.
  const localOrder = new Map<string, string[]>();
  for (const section of oursSections) {
    localOrder.set(section.name, section.rows.flatMap((row) => row.kind === "task" ? [row.entry.key] : []));
  }

  const emitted = new Set<string>();
  const out: string[] = [];
  const renderSection = (section: Section) => {
    if (section.heading !== null) out.push(section.heading);
    const rows: Row[] = section.rows.filter((row) => {
      if (row.kind !== "task") return true;
      const winner = chosen.get(row.entry.key);
      return !!winner && winner.section === section.name && !emitted.has(row.entry.key);
    }).map((row) => row.kind === "task" ? { kind: "task", entry: chosen.get(row.entry.key)! } : row);
    for (const row of rows) if (row.kind === "task") emitted.add(row.entry.key);

    if (section.heading !== null) {
      const missing = [...chosen.values()].filter((entry) => entry.section === section.name && !emitted.has(entry.key));
      const order = localOrder.get(section.name) ?? [];
      for (const entry of missing) {
        const at = order.indexOf(entry.key);
        const before = order.slice(0, Math.max(at, 0)).reverse().find((key) => rows.some((row) => row.kind === "task" && row.entry.key === key));
        let position: number;
        if (before) {
          position = rows.findIndex((row) => row.kind === "task" && row.entry.key === before) + 1;
        } else {
          const first = rows.findIndex((row) => row.kind === "task");
          if (at >= 0 && first >= 0) {
            position = first;
          } else {
            let last = -1;
            rows.forEach((row, i) => { if (row.kind === "task") last = i; });
            position = last >= 0 ? last + 1 : (rows.length > 0 && rows[0].kind === "line" && rows[0].text === "" ? 1 : 0);
          }
        }
        rows.splice(position, 0, { kind: "task", entry });
        emitted.add(entry.key);
      }
    }
    for (const row of rows) {
      if (row.kind === "task") out.push(...row.entry.lines);
      else out.push(row.text);
    }
  };

  for (const section of theirsSections) renderSection(section);

  // Sections only the local side has, in local order.
  const theirNames = new Set(theirsSections.map((section) => section.name));
  for (const section of oursSections) {
    if (section.heading === null || theirNames.has(section.name)) continue;
    const entries = [...chosen.values()].filter((entry) => entry.section === section.name && !emitted.has(entry.key));
    if (entries.length === 0) continue;
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    out.push(section.heading, "");
    for (const entry of entries) { out.push(...entry.lines); emitted.add(entry.key); }
    out.push("");
  }
  return out.join("\n");
}
