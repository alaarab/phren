import { getPhrenPath, FINDING_TYPES, type FindingType } from "../shared.js";
import { resolveProject } from "../store-routing.js";
import { addNote, editNote, listNotes, removeNote } from "../data/notes.js";
import { promoteNote } from "../core/note.js";

function usage(): void {
  console.log("Usage:");
  console.log('  phren note add <project> "<text>" [--date YYYY-MM-DD]');
  console.log("  phren note list <project> [--date YYYY-MM-DD] [--limit N]");
  console.log('  phren note edit <project> <nid> "<text>"');
  console.log("  phren note remove <project> <nid>");
  console.log("  phren note promote <project> <nid> [--type pattern]");
}

function option(args: string[], name: string): string | undefined {
  const equal = args.find((arg) => arg.startsWith(`--${name}=`));
  if (equal) return equal.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function positionalAfter(args: string[], start: number): string[] {
  const values: string[] = [];
  for (let index = start; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      if (!arg.includes("=")) index++;
      continue;
    }
    values.push(arg);
  }
  return values;
}

function target(projectInput: string, profile: string): { phrenPath: string; project: string } {
  const resolved = resolveProject(getPhrenPath(), projectInput, profile);
  if (resolved.store.role === "readonly") throw new Error(`Store "${resolved.store.name}" is read-only.`);
  return { phrenPath: resolved.store.path, project: resolved.projectName };
}

export async function handleNoteNamespace(args: string[], profile: string): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    usage();
    return;
  }
  const projectInput = args[1];
  if (!projectInput) {
    usage();
    process.exitCode = 1;
    return;
  }

  let resolved: { phrenPath: string; project: string };
  try {
    resolved = target(projectInput, profile);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  const { phrenPath, project } = resolved;

  if (subcommand === "list") {
    const limitRaw = option(args, "limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 100;
    if (!Number.isFinite(limit) || limit < 1) {
      console.error("--limit must be a positive integer.");
      process.exitCode = 1;
      return;
    }
    const result = listNotes(phrenPath, project, { date: option(args, "date"), limit });
    if (!result.ok) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }
    if (!result.data.length) {
      console.log(`No notes found for "${project}".`);
      return;
    }
    for (const note of result.data) {
      console.log(`${note.date} ${note.time.slice(0, 5)}  ${note.id}${note.promoted ? "  [promoted]" : ""}`);
      console.log(note.text.split("\n").map((line) => `  ${line}`).join("\n"));
    }
    return;
  }

  if (subcommand === "add") {
    const text = positionalAfter(args, 2).join(" ");
    const result = addNote(phrenPath, project, text, { date: option(args, "date") });
    if (!result.ok) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }
    console.log(`Note added: ${result.data.id} (${result.data.date})`);
    return;
  }

  const note = args[2];
  if (!note) {
    usage();
    process.exitCode = 1;
    return;
  }

  if (subcommand === "edit") {
    const text = positionalAfter(args, 3).join(" ");
    const result = editNote(phrenPath, project, note, text);
    if (!result.ok) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }
    console.log(`Updated ${result.data.id}.`);
    return;
  }

  if (subcommand === "remove") {
    const result = removeNote(phrenPath, project, note);
    if (!result.ok) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }
    console.log(`Removed ${result.data.id}.`);
    return;
  }

  if (subcommand === "promote") {
    const typeRaw = option(args, "type");
    if (typeRaw && !FINDING_TYPES.includes(typeRaw as FindingType)) {
      console.error(`Invalid finding type "${typeRaw}". Use: ${FINDING_TYPES.join(", ")}.`);
      process.exitCode = 1;
      return;
    }
    const result = promoteNote(phrenPath, project, note, typeRaw as FindingType | undefined);
    if (!result.ok) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }
    console.log(`Promoted ${result.data.note.id} to a finding.`);
    return;
  }

  console.error(`Unknown note subcommand: ${subcommand}`);
  usage();
  process.exitCode = 1;
}
