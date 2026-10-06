import * as fs from "fs";
import { getPhrenPath } from "../shared.js";
import { isValidProjectName } from "../utils.js";
import { addFinding, removeFinding } from "../core/finding.js";
import { supersedeFinding, retractFinding, resolveFindingContradiction } from "../finding/lifecycle.js";
import { resolveProjectStorePath } from "./namespaces-utils.js";

function printFindingUsage() {
  console.log("Usage:");
  console.log('  phren finding add <project> "<text>"');
  console.log('  phren finding remove <project> "<text>"');
  console.log('  phren finding supersede <project> "<text>" --by "<newer guidance>"');
  console.log('  phren finding retract <project> "<text>" --reason "<reason>"');
  console.log('  phren finding contradictions [project]');
  console.log('  phren finding resolve <project> "<finding_text>" "<other_text>" <keep_a|keep_b|keep_both|retract_both>');
}

export async function handleFindingNamespace(args: string[]) {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printFindingUsage();
    return;
  }

  if (subcommand === "list") {
    const project = args[1];
    if (!project) {
      console.error("Usage: phren finding list <project>");
      process.exit(1);
    }
    const phrenPath = getPhrenPath();
    const { readFindings } = await import("../data/access.js");
    const storePath = resolveProjectStorePath(phrenPath, project);
    const result = readFindings(storePath, project);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    const items = result.data;
    if (!items.length) {
      console.log(`No findings found for "${project}".`);
      return;
    }
    for (const entry of items.slice(0, 50)) {
      console.log(`- [${entry.id}] ${entry.date}: ${entry.text}`);
    }
    return;
  }

  if (subcommand === "add") {
    const project = args[1];
    const text = args.slice(2).join(" ");
    if (!project || !text) {
      console.error('Usage: phren finding add <project> "<text>"');
      process.exit(1);
    }
    const result = addFinding(getPhrenPath(), project, text);
    if (!result.ok) {
      console.error(result.message);
      process.exit(1);
    }
    console.log(result.message);
    return;
  }

  if (subcommand === "remove") {
    const project = args[1];
    const text = args.slice(2).join(" ");
    if (!project || !text) {
      console.error('Usage: phren finding remove <project> "<text>"');
      process.exit(1);
    }
    const result = removeFinding(getPhrenPath(), project, text);
    if (!result.ok) {
      console.error(result.message);
      process.exit(1);
    }
    console.log(result.message);
    return;
  }

  if (subcommand === "supersede") {
    const project = args[1];
    if (!project) {
      console.error('Usage: phren finding supersede <project> "<text>" --by "<newer guidance>"');
      process.exit(1);
    }
    const rest = args.slice(2);
    const byIdx = rest.indexOf("--by");
    const byEqIdx = rest.findIndex(a => a.startsWith("--by="));
    let text: string;
    let byValue: string;
    if (byEqIdx !== -1) {
      byValue = rest[byEqIdx].slice("--by=".length);
      text = rest.filter((_, i) => i !== byEqIdx && !rest[i].startsWith("--")).join(" ");
    } else if (byIdx !== -1) {
      text = rest.slice(0, byIdx).join(" ");
      byValue = rest.slice(byIdx + 1).join(" ");
    } else {
      text = "";
      byValue = "";
    }
    if (!text || !byValue) {
      console.error('Usage: phren finding supersede <project> "<text>" --by "<newer guidance>"');
      process.exit(1);
    }
    const result = supersedeFinding(getPhrenPath(), project, text, byValue);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(`Finding superseded: "${result.data.finding}" -> "${result.data.superseded_by}"`);
    return;
  }

  if (subcommand === "retract") {
    const project = args[1];
    if (!project) {
      console.error('Usage: phren finding retract <project> "<text>" --reason "<reason>"');
      process.exit(1);
    }
    const rest = args.slice(2);
    const reasonIdx = rest.indexOf("--reason");
    const reasonEqIdx = rest.findIndex(a => a.startsWith("--reason="));
    let text: string;
    let reasonValue: string;
    if (reasonEqIdx !== -1) {
      reasonValue = rest[reasonEqIdx].slice("--reason=".length);
      text = rest.filter((_, i) => i !== reasonEqIdx && !rest[i].startsWith("--")).join(" ");
    } else if (reasonIdx !== -1) {
      text = rest.slice(0, reasonIdx).join(" ");
      reasonValue = rest.slice(reasonIdx + 1).join(" ");
    } else {
      text = "";
      reasonValue = "";
    }
    if (!text || !reasonValue) {
      console.error('Usage: phren finding retract <project> "<text>" --reason "<reason>"');
      process.exit(1);
    }
    const result = retractFinding(getPhrenPath(), project, text, reasonValue);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(`Finding retracted: "${result.data.finding}" (reason: ${result.data.reason})`);
    return;
  }

  if (subcommand === "contradictions") {
    const project = args[1];
    const phrenPath = getPhrenPath();
    const RESERVED_DIRS = new Set(["global", ".runtime", ".sessions", ".config"]);
    const { readFindings } = await import("../data/access.js");
    const projects = project
      ? [project]
      : fs.readdirSync(phrenPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !RESERVED_DIRS.has(entry.name) && isValidProjectName(entry.name))
          .map((entry) => entry.name);

    const contradictions: Array<{ project: string; id: string; text: string; date: string; status_ref?: string }> = [];
    for (const p of projects) {
      const result = readFindings(phrenPath, p);
      if (!result.ok) continue;
      for (const finding of result.data) {
        if (finding.status !== "contradicted") continue;
        contradictions.push({ project: p, id: finding.id, text: finding.text, date: finding.date, status_ref: finding.status_ref });
      }
    }

    if (!contradictions.length) {
      console.log("No unresolved contradictions found.");
      return;
    }

    console.log(`${contradictions.length} unresolved contradiction(s):\n`);
    for (const c of contradictions) {
      console.log(`[${c.project}] ${c.date}  ${c.id}`);
      console.log(`  ${c.text}`);
      if (c.status_ref) console.log(`  contradicts: ${c.status_ref}`);
      console.log("");
    }
    return;
  }

  if (subcommand === "resolve") {
    const project = args[1];
    const findingText = args[2];
    const otherText = args[3];
    const resolution = args[4] as "keep_a" | "keep_b" | "keep_both" | "retract_both" | undefined;
    const validResolutions = ["keep_a", "keep_b", "keep_both", "retract_both"];
    if (!project || !findingText || !otherText || !resolution) {
      console.error('Usage: phren finding resolve <project> "<finding_text>" "<other_text>" <keep_a|keep_b|keep_both|retract_both>');
      process.exit(1);
    }
    if (!validResolutions.includes(resolution)) {
      console.error(`Invalid resolution "${resolution}". Valid values: ${validResolutions.join(", ")}`);
      process.exit(1);
    }
    const result = resolveFindingContradiction(getPhrenPath(), project, findingText, otherText, resolution);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(`Resolved contradiction in "${project}" with "${resolution}".`);
    console.log(`  finding_a: ${result.data.finding_a.text} → ${result.data.finding_a.status}`);
    console.log(`  finding_b: ${result.data.finding_b.text} → ${result.data.finding_b.status}`);
    return;
  }

  console.error(`Unknown finding subcommand: ${subcommand}`);
  printFindingUsage();
  process.exit(1);
}
