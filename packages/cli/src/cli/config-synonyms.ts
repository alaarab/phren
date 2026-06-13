import { getPhrenPath } from "../shared.js";
import {
  isValidProjectName,
  learnedSynonymsPath,
  learnSynonym,
  loadLearnedSynonyms,
  removeLearnedSynonym,
} from "../utils.js";

// ── Synonyms ─────────────────────────────────────────────────────────────────

function printSynonymsUsage(): void {
  console.error("Usage: phren config synonyms list <project>");
  console.error("       phren config synonyms add <project> <term> <syn1,syn2,...>");
  console.error("       phren config synonyms remove <project> <term> [syn1,syn2,...]");
}

function parseSynonymItems(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function handleConfigSynonyms(args: string[]) {
  const phrenPath = getPhrenPath();
  let action = args[0] || "list";
  let project = args[1];
  if (action !== "list" && action !== "add" && action !== "remove" && isValidProjectName(action)) {
    project = action;
    action = "list";
  }

  if (!project || !isValidProjectName(project)) {
    printSynonymsUsage();
    process.exitCode = 1;
    return;
  }

  if (action === "list") {
    console.log(JSON.stringify({
      project,
      path: learnedSynonymsPath(phrenPath, project),
      synonyms: loadLearnedSynonyms(project, phrenPath),
    }, null, 2));
    return;
  }

  if (action === "add") {
    const term = args[2];
    const synonyms = parseSynonymItems(args[3]);
    if (!term || synonyms.length === 0) {
      printSynonymsUsage();
      process.exitCode = 1;
      return;
    }
    const updated = learnSynonym(phrenPath, project, term, synonyms);
    console.log(JSON.stringify({ project, term, synonyms: updated[term.toLowerCase()] ?? [], updated }, null, 2));
    return;
  }

  if (action === "remove") {
    const term = args[2];
    if (!term) {
      printSynonymsUsage();
      process.exitCode = 1;
      return;
    }
    const updated = removeLearnedSynonym(phrenPath, project, term, parseSynonymItems(args[3]));
    console.log(JSON.stringify({ project, term: term.toLowerCase(), updated }, null, 2));
    return;
  }

  printSynonymsUsage();
  process.exitCode = 1;
}
