// Pure helpers for the Projects section: age text, summary and frontmatter
// parsing, the phren.project.yaml knobs and the store-tree readers.
import { extractKnowsBlock } from "../../chat/knows.js";

// The five per-project knobs the CLI reads from <project>/phren.project.yaml,
// under the file's top-level `config:` mapping (packages/cli/src/project-config.ts).
// A missing key means "inherit the global setting".
export const KNOBS = {
  findingSensitivity: { label: "Finding sensitivity", caption: "How readily new findings are kept", options: ["minimal", "conservative", "balanced", "aggressive"] },
  proactivity: { label: "Proactivity", caption: "The base auto-capture level", options: ["low", "medium", "high"] },
  proactivityFindings: { label: "Proactivity for findings", caption: "Auto-capture for findings only", options: ["low", "medium", "high"] },
  proactivityTask: { label: "Proactivity for tasks", caption: "Auto-capture for tasks only", options: ["low", "medium", "high"] },
  taskMode: { label: "Task mode", caption: "How new tasks are filed", options: ["off", "manual", "suggest", "auto"] },
};

export function clear(node) { node.replaceChildren(); }

/** A short age: "now", "5m", "3h", "2d". */
export function age(iso) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function autoFocus(input) {
  requestAnimationFrame(() => input.focus());
}

/** Minimal flat-YAML reader for skill frontmatter and phren.project.yaml: the
 * `key: value` lines phren writes, quoted or bare. Nested blocks are skipped. */
export function parseScalarYAML(yaml) {
  const result = {};
  for (const raw of String(yaml).split("\n")) {
    const line = raw;
    if (line.startsWith("#") || line.startsWith(" ") || line.startsWith("\t") || line.startsWith("-")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (!key || !value) continue;
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** A skill's leading `--- ... ---` block, like the phone's SkillFile.parseFrontmatter. */
export function parseFrontmatter(raw) {
  let text = String(raw);
  if (text.startsWith("\ufeff")) text = text.slice(1);
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.startsWith("---\n")) return { frontmatter: null };
  const close = text.indexOf("\n---", 4);
  if (close < 0) return { frontmatter: null };
  const frontmatter = parseScalarYAML(text.slice(4, close));
  return { frontmatter: Object.keys(frontmatter).length ? frontmatter : null };
}

/** The summary.md "What phren knows" block: its prose and the counts it carries. */
export function parseKnows(summary) {
  if (!summary) return null;
  // The newest copy when a union merge left several start markers.
  const block = extractKnowsBlock(summary);
  if (!block) return null;
  const inner = ["", ...block.split("\n")];
  const bullets = inner.filter((line) => line.startsWith("- "));
  const counts = { findings: 0, tasks: null };
  for (const line of bullets) {
    const active = /(\d+) active finding/.exec(line);
    const tasks = /(\d+) open task/.exec(line);
    if (active) counts.findings = Number(active[1]);
    if (tasks) counts.tasks = Number(tasks[1]);
  }
  // A topic bullet may carry only its "## Now" heading, with the real line in the next paragraph.
  const prose = inner.slice(1).map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && !line.startsWith("<!--") && !line.startsWith("- "));
  const first = bullets.find((line) => !/active finding/.test(line) && !/—\s*#+\s/.test(line)) ?? prose[0];
  const summaryLine = (first ?? bullets[0] ?? "").replace(/^#+\s*/, "").replace(/^-\s*/, "").replace(/^\*\*[^*]+\*\*\s*—\s*/, "").trim();
  return { counts, summaryLine, text: inner.slice(1).join("\n").trim() };
}

/** Open tasks are the non-empty "- " bullets before the Done section. */
export function countOpenTasks(markdown) {
  let count = 0, inDone = false;
  for (const line of String(markdown).split("\n")) {
    if (/^##\s+Done\b/.test(line)) { inDone = true; continue; }
    if (/^##\s+/.test(line)) { inDone = false; continue; }
    if (!inDone && line.startsWith("- ") && line.slice(2).trim() && !/^-\s*\[x\]/i.test(line)) count++;
  }
  return count;
}

/** Active findings are the "- " bullets in FINDINGS.md (archived ones live elsewhere). */
export function countActiveFindings(markdown) {
  let count = 0;
  for (const line of String(markdown).split("\n")) if (line.startsWith("- ")) count++;
  return count;
}

// ------------------------------------------------------------- project.yaml

/** The index of the top-level `config:` line (an indented one is not it). */
export function configHeader(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || line !== line.trimStart()) continue;
    const colon = trimmed.indexOf(":");
    if (colon > 0 && trimmed.slice(0, colon).trim() === "config") return i;
  }
  return -1;
}

/** An indented `key: value` line, ignoring comments; the value is unquoted. */
export function scalarLine(raw) {
  if (!raw.startsWith(" ") && !raw.startsWith("\t")) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const colon = trimmed.indexOf(":");
  if (colon <= 0) return null;
  const key = trimmed.slice(0, colon).trim();
  if (!key) return null;
  let value = trimmed.slice(colon + 1).trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return { key, value };
}

/** The five knobs set in the file's `config:` block; unknown values read as unset. */
export function parseKnobs(yaml) {
  const knobs = {};
  const lines = String(yaml).split("\n");
  const header = configHeader(lines);
  if (header < 0) return knobs;
  for (let i = header + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() && line === line.trimStart()) break;
    const entry = scalarLine(line);
    if (entry && KNOBS[entry.key] && KNOBS[entry.key].options.includes(entry.value)) knobs[entry.key] = entry.value;
  }
  return knobs;
}

/** Rewrite only the knob lines under `config:`, copying every other line through
 * byte for byte: sourcePath, ownership, nested blocks and comments all survive. */
export function applyKnobs(yaml, values) {
  const keys = Object.keys(KNOBS);
  const lines = String(yaml).split("\n");
  const trailing = lines[lines.length - 1] === "" ? 1 : 0;
  const contentEnd = lines.length - trailing;
  const header = configHeader(lines);
  if (header < 0) {
    const entries = keys.filter((key) => values[key]).map((key) => `  ${key}: ${values[key]}`);
    if (!entries.length) return yaml;
    lines.splice(contentEnd, 0, "config:", ...entries);
    return lines.join("\n");
  }
  if (keys.some((key) => values[key]) && /^config:\s*\{\s*\}\s*$/.test(lines[header])) lines[header] = "config:";
  let blockEnd = header + 1;
  while (blockEnd < contentEnd) {
    const line = lines[blockEnd];
    if (line.trim() && line === line.trimStart()) break;
    blockEnd++;
  }
  let indent = "  ";
  for (let i = header + 1; i < contentEnd; i++) {
    const line = lines[i];
    if (line.trim() && line === line.trimStart()) break;
    const match = /^(\s+)/.exec(line);
    if (match) { indent = match[1]; break; }
  }
  const present = new Set();
  const output = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i > header && i < blockEnd) {
      const entry = scalarLine(line);
      if (entry && keys.includes(entry.key)) {
        present.add(entry.key);
        if (values[entry.key]) output.push(`${line.match(/^\s*/)[0]}${entry.key}: ${values[entry.key]}`);
      } else output.push(line);
    } else output.push(line);
    if (i === blockEnd - 1) {
      for (const key of keys) if (values[key] && !present.has(key)) output.push(`${indent}${key}: ${values[key]}`);
    }
  }
  return output.join("\n");
}

// ------------------------------------------------------------- computer data

/** The store-tree nodes under one project: its blob paths by relative name. */
export function projectFiles(tree, name) {
  const files = new Map();
  const prefix = `${name}/`;
  for (const node of tree ?? []) {
    if (node.type !== "blob" || !node.path.startsWith(prefix)) continue;
    files.set(node.path.slice(prefix.length), node);
  }
  return files;
}

/** A project's skills, from `<project>/skills/*` plus the store's `global/skills/*`. */
export function skillsFromTree(tree, name, scope) {
  const out = [];
  const prefix = scope === "global" ? "global/skills/" : `${name}/skills/`;
  for (const node of tree ?? []) {
    if (node.type !== "blob" || !node.path.startsWith(prefix)) continue;
    const rest = node.path.slice(prefix.length);
    const folder = rest.match(/^([^/]+)\/SKILL\.md$/);
    const single = rest.match(/^([^/]+)\.md$/);
    const skillName = folder?.[1] ?? single?.[1];
    if (!skillName) continue;
    out.push({ path: node.path, sha: node.sha, name: skillName, scope });
  }
  return out;
}

export function firstLine(text) {
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/^#+\s*/, "").trim();
    if (line && !line.startsWith("<!--")) return line;
  }
  return "";
}

export function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
