/**
 * Project registration and scaffold shared by `phren add`, `phren init` and
 * the phone Hook's "Add project". Kept free of the init walkthrough, the
 * agent-hooks installer and the skill/provision machinery so the Hook does not
 * have to bundle `phren init`.
 */
import * as fs from "fs";
import * as path from "path";
import {
  atomicWriteText,
  debugLog,
  findProjectNameCaseInsensitive,
  findProjectNamesByCanonicalKey,
  projectSlugFromPath,
  readRootManifest,
} from "../phren-paths.js";
import { resolveWorktreeParent } from "../git-worktree.js";
import { moduleEnabled } from "../modules/runtime.js";
import { STOP_WORDS, errorMessage } from "../utils.js";
import { FINDINGS_FILENAME, TASKS_FILENAME } from "../filenames.js";
import {
  getProjectOwnershipDefault,
  getProjectSourcePath,
  parseProjectOwnershipMode,
  readProjectConfig,
  recordProjectSourcePath,
  type ProjectOwnershipMode,
} from "../project-config.js";
import { getBuiltinTopicConfig, normalizeBuiltinTopicDomain, type BuiltinTopic } from "../project-topics.js";
import { addProjectToProfile, resolveActiveProfile } from "../profile-store.js";

/** Project domain used to pick starter topics and the AGENTS.md template. */
export type InitProjectDomain =
  | "software"
  | "music"
  | "game"
  | "research"
  | "writing"
  | "creative"
  | "other";


interface BootstrapProjectOptions {
  profile?: string;
  profilePhrenPath?: string;
  ownership?: ProjectOwnershipMode;
}

interface BootstrapProjectResult {
  project: string;
  ownership: ProjectOwnershipMode;
  claudePath: string | null;
}

export interface InferredInitScaffold {
  domain: InitProjectDomain;
  topics: BuiltinTopic[];
  referenceHints: string[];
  commandHints: string[];
  confidence: number;
  reason: string;
}

type DomainScoreMap = Record<InitProjectDomain, number>;

const DOMAIN_KEYWORD_HINTS: Record<Exclude<InitProjectDomain, "other">, string[]> = {
  software: [
    "api", "backend", "frontend", "typescript", "javascript", "python", "rust", "golang", "cli", "sdk", "library", "service",
    "server", "database", "auth", "module", "package", "build", "test", "deploy",
  ],
  music: [
    "music", "audio", "mix", "master", "track", "daw", "synth", "midi", "song", "composition", "arrangement", "producer",
  ],
  game: [
    "game", "gameplay", "level", "shader", "physics", "npc", "engine", "unity", "godot", "unreal", "sprite", "multiplayer",
  ],
  research: [
    "research", "paper", "study", "experiment", "dataset", "analysis", "methodology", "hypothesis", "results", "evaluation",
  ],
  writing: [
    "writing", "manuscript", "chapter", "outline", "narrative", "character", "plot", "draft", "editorial",
  ],
  creative: [
    "creative", "story", "design", "worldbuilding", "script", "concept", "illustration", "art direction",
  ],
};

const DOMAIN_CONFIG_HINTS: Record<string, Partial<Record<InitProjectDomain, number>>> = {
  "package.json": { software: 3 },
  "tsconfig.json": { software: 3 },
  "Cargo.toml": { software: 4, game: 1 },
  "pyproject.toml": { software: 3, research: 1 },
  "requirements.txt": { software: 2, research: 1 },
  "go.mod": { software: 3 },
  "CMakeLists.txt": { software: 3, game: 1 },
  "pom.xml": { software: 3 },
  "build.gradle": { software: 3 },
  "project.godot": { game: 5 },
  ".uproject": { game: 5 },
  "paper.tex": { research: 4, writing: 1 },
  "references.bib": { research: 4 },
};

const EXTENSION_DOMAIN_HINTS: Record<string, Partial<Record<InitProjectDomain, number>>> = {
  ".ts": { software: 1 },
  ".tsx": { software: 1, game: 1 },
  ".js": { software: 1 },
  ".jsx": { software: 1 },
  ".py": { software: 1, research: 1 },
  ".rs": { software: 1, game: 1 },
  ".go": { software: 1 },
  ".java": { software: 1 },
  ".kt": { software: 1 },
  ".swift": { software: 1 },
  ".c": { software: 1, game: 1 },
  ".cc": { software: 1, game: 1 },
  ".cpp": { software: 1, game: 1 },
  ".h": { software: 1, game: 1 },
  ".hpp": { software: 1, game: 1 },
  ".cs": { software: 1, game: 1 },
  ".ipynb": { research: 2 },
  ".tex": { research: 2, writing: 1 },
  ".bib": { research: 2 },
  ".wav": { music: 2 },
  ".mp3": { music: 2 },
  ".flac": { music: 2 },
  ".mid": { music: 2 },
  ".midi": { music: 2 },
  ".als": { music: 2 },
  ".logicx": { music: 2 },
  ".unity": { game: 2 },
  ".gd": { game: 2 },
  ".glsl": { game: 2 },
};

interface RepoScanSignal {
  domainScores: DomainScoreMap;
  terms: Map<string, number>;
  docsText: string;
  referenceHints: string[];
  commandHints: string[];
  usefulSignals: number;
}

function titleCase(text: string): string {
  return text
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((token) => token.slice(0, 1).toUpperCase() + token.slice(1))
    .join(" ");
}

function addTermCount(terms: Map<string, number>, rawText: string, weight: number = 1): void {
  const tokens = rawText
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && token.length <= 48 && !STOP_WORDS.has(token));
  for (const token of tokens) {
    terms.set(token, (terms.get(token) ?? 0) + weight);
  }
}

function maybeReadUtf8(filePath: string, maxBytes = 256_000): string {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function addDomainScores(target: DomainScoreMap, patch: Partial<Record<InitProjectDomain, number>>, weight = 1): void {
  for (const [domain, score] of Object.entries(patch)) {
    const typedDomain = domain as InitProjectDomain;
    target[typedDomain] += (score ?? 0) * weight;
  }
}

function scoreTopicsFromTerms(domain: InitProjectDomain, terms: Map<string, number>, docsText: string): BuiltinTopic[] {
  const baseTopics = getBuiltinTopicConfig(domain);
  const scored = baseTopics
    .filter((topic) => topic.name.toLowerCase() !== "general")
    .map((topic) => {
      const baseTerm = topic.name.toLowerCase();
      let score = terms.get(baseTerm) ?? 0;
      for (const keyword of topic.keywords) {
        const normalized = keyword.toLowerCase().trim();
        if (!normalized) continue;
        score += terms.get(normalized) ?? 0;
        if (normalized.includes(" ") && docsText.includes(normalized)) score += 1;
      }
      return { topic, score };
    });

  const ranked = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.topic.name.localeCompare(b.topic.name));

  const takenNames = new Set(baseTopics.map((topic) => topic.name.toLowerCase()));
  const customTopics: BuiltinTopic[] = [];
  for (const [term, count] of [...terms.entries()].sort((a, b) => b[1] - a[1])) {
    if (customTopics.length >= 4) break;
    if (count < 3) break;
    if (term.includes("_")) continue;
    const topicName = titleCase(term);
    const normalizedName = topicName.toLowerCase();
    if (takenNames.has(normalizedName)) continue;
    if (DOMAIN_KEYWORD_HINTS.software.includes(term) || DOMAIN_KEYWORD_HINTS.music.includes(term) || DOMAIN_KEYWORD_HINTS.game.includes(term)) {
      continue;
    }
    takenNames.add(normalizedName);
    customTopics.push({
      name: topicName,
      description: "Suggested from repeated terminology in project docs.",
      keywords: [term],
    });
  }

  if (ranked.length === 0 && customTopics.length === 0) return baseTopics;

  const orderedBase = [
    ...ranked.map((entry) => entry.topic),
    ...baseTopics.filter((topic) =>
      topic.name.toLowerCase() !== "general"
      && !ranked.some((entry) => entry.topic.name === topic.name)
    ),
  ];
  const topics = [...orderedBase.slice(0, 8), ...customTopics];
  if (!topics.some((topic) => topic.name.toLowerCase() === "general")) {
    topics.push({ name: "General", description: "Fallback bucket for uncategorized findings.", keywords: [] });
  }
  return topics;
}

export function inferInitScaffoldFromRepo(repoRoot: string, fallbackDomain: InitProjectDomain = "software"): InferredInitScaffold | null {
  const resolvedRoot = path.resolve(repoRoot);
  if (!fs.existsSync(resolvedRoot)) return null;

  const signal: RepoScanSignal = {
    domainScores: { software: 0, music: 0, game: 0, research: 0, writing: 0, creative: 0, other: 0 },
    terms: new Map<string, number>(),
    docsText: "",
    referenceHints: [],
    commandHints: [],
    usefulSignals: 0,
  };
  const skipDirs = new Set([".git", ".phren", "node_modules", "dist", "build", "coverage", ".next", ".turbo", "target"]);

  const packageJsonPath = path.join(resolvedRoot, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    signal.usefulSignals++;
    addDomainScores(signal.domainScores, DOMAIN_CONFIG_HINTS["package.json"]);
    try {
      const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      if (typeof parsed.description === "string") {
        addTermCount(signal.terms, parsed.description, 3);
        signal.docsText += ` ${parsed.description.toLowerCase()}`;
      }
      if (Array.isArray(parsed.keywords)) {
        for (const keyword of parsed.keywords) {
          if (typeof keyword === "string") {
            addTermCount(signal.terms, keyword, 3);
            signal.docsText += ` ${keyword.toLowerCase()}`;
          }
        }
      }
      if (parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)) {
        const scriptObject = parsed.scripts as Record<string, unknown>;
        for (const scriptName of ["dev", "start", "build", "test", "lint"]) {
          if (typeof scriptObject[scriptName] === "string") {
            signal.commandHints.push(`npm run ${scriptName}`);
          }
        }
      }
    } catch (err: unknown) {
      debugLog(`inferInitScaffoldFromRepo package.json parse failed: ${errorMessage(err)}`);
    }
  }

  const topLevelConfigs = Object.keys(DOMAIN_CONFIG_HINTS)
    .filter((fileName) => fs.existsSync(path.join(resolvedRoot, fileName)));
  for (const configName of topLevelConfigs) {
    signal.usefulSignals++;
    const configScore = DOMAIN_CONFIG_HINTS[configName];
    if (configScore) addDomainScores(signal.domainScores, configScore);
  }

  const readmeCandidates = [
    path.join(resolvedRoot, "README.md"),
    path.join(resolvedRoot, "readme.md"),
  ];
  for (const readmePath of readmeCandidates) {
    if (!fs.existsSync(readmePath)) continue;
    const content = maybeReadUtf8(readmePath);
    if (!content) continue;
    signal.usefulSignals++;
    signal.referenceHints.push(path.relative(resolvedRoot, readmePath));
    addTermCount(signal.terms, content, 2);
    signal.docsText += ` ${content.toLowerCase()}`;
    break;
  }

  const docsDir = path.join(resolvedRoot, "docs");
  if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
    signal.referenceHints.push("docs/");
    for (const entry of fs.readdirSync(docsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(md|txt|rst)$/i.test(entry.name)) continue;
      const docsContent = maybeReadUtf8(path.join(docsDir, entry.name));
      if (!docsContent) continue;
      signal.usefulSignals++;
      addTermCount(signal.terms, docsContent, 1);
      signal.docsText += ` ${docsContent.toLowerCase()}`;
    }
  }

  for (const folderName of ["reference", "specs", "design", "architecture", "src", "packages", "apps"]) {
    const fullPath = path.join(resolvedRoot, folderName);
    if (fs.existsSync(fullPath)) {
      signal.referenceHints.push(`${folderName}/`);
    }
  }

  let scannedFiles = 0;
  const maxFiles = 3000;
  const walk = (dir: string): void => {
    if (scannedFiles >= maxFiles) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (scannedFiles >= maxFiles) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      scannedFiles++;
      const ext = path.extname(entry.name).toLowerCase();
      if (!ext) continue;
      const extScore = EXTENSION_DOMAIN_HINTS[ext];
      if (extScore) {
        addDomainScores(signal.domainScores, extScore);
        signal.usefulSignals++;
      }
    }
  };
  walk(resolvedRoot);

  for (const [domain, hints] of Object.entries(DOMAIN_KEYWORD_HINTS)) {
    for (const hint of hints) {
      const hitCount = signal.terms.get(hint) ?? 0;
      if (hitCount > 0) {
        signal.domainScores[domain as InitProjectDomain] += Math.min(4, hitCount);
        signal.usefulSignals++;
      }
    }
  }

  const rankedDomains = Object.entries(signal.domainScores)
    .sort((a, b) => b[1] - a[1]) as Array<[InitProjectDomain, number]>;
  const [bestDomain, bestScore] = rankedDomains[0] ?? [fallbackDomain, 0];
  const secondScore = rankedDomains[1]?.[1] ?? 0;
  const inferredDomain = bestScore >= 2 ? bestDomain : fallbackDomain;
  const confidence = bestScore <= 0
    ? 0
    : Math.max(0.15, Math.min(0.98, (bestScore - secondScore + 1) / (bestScore + 2)));

  const topics = scoreTopicsFromTerms(inferredDomain, signal.terms, signal.docsText);
  const references = Array.from(new Set(signal.referenceHints)).slice(0, 8);
  const commands = Array.from(new Set(signal.commandHints)).slice(0, 5);
  const reason = bestScore > 0
    ? `inferred from repo files, config, and docs terminology (score ${bestScore})`
    : "fallback defaults";

  if (signal.usefulSignals === 0) return null;
  return {
    domain: inferredDomain,
    topics: topics.length > 0 ? topics : getBuiltinTopicConfig(inferredDomain),
    referenceHints: references,
    commandHints: commands,
    confidence: Number(confidence.toFixed(2)),
    reason,
  };
}

function appendInferredSections(base: string, inference?: InferredInitScaffold | null): string {
  if (!inference) return base;
  const lines: string[] = [];
  if (inference.referenceHints.length > 0) {
    lines.push("## Reference Structure");
    for (const hint of inference.referenceHints) {
      lines.push(`- ${hint}`);
    }
    lines.push("");
  }
  if (inference.topics.length > 0) {
    lines.push("## Initial Focus Topics");
    for (const topic of inference.topics.slice(0, 6)) {
      lines.push(`- ${topic.name}: ${topic.description}`);
    }
    lines.push("");
  }
  if (inference.commandHints.length > 0) {
    lines.push("## Commands");
    lines.push("```bash");
    for (const cmd of inference.commandHints) lines.push(cmd);
    lines.push("```");
    lines.push("");
  }
  return lines.length > 0 ? `${base.trimEnd()}\n\n${lines.join("\n")}` : base;
}

function getDomainClaudeTemplate(projectName: string, domain: InitProjectDomain, inference?: InferredInitScaffold | null): string {
  if (domain === "software") {
    return appendInferredSections(
      `# ${projectName}\n\nOne paragraph about what this project is.\n\n## Commands\n\n\`\`\`bash\n# Install:\n# Run:\n# Test:\n\`\`\`\n`,
      inference
    );
  }
  if (domain === "music") {
    return appendInferredSections(
      `# ${projectName}\n\nThis is a music project. Keep notes on composition intent, arrangement choices, production workflow, and mixing/mastering decisions.\n\n## Session Focus\n\n- Capture creative intent before technical tweaks\n- Track instrument/sound-design decisions and why\n- Log mix/master changes with listening context\n`,
      inference
    );
  }
  if (domain === "game") {
    return appendInferredSections(
      `# ${projectName}\n\nThis is a game project. Prioritize clear notes on mechanics, rendering/performance tradeoffs, level and UI decisions, and iteration outcomes.\n\n## Development Focus\n\n- Record gameplay/mechanics decisions with player impact\n- Track rendering/physics/AI issues with repro context\n- Note level-design and networking constraints early\n`,
      inference
    );
  }
  if (domain === "research") {
    return appendInferredSections(
      `# ${projectName}\n\nThis is a research project. Focus on methodology, source quality, analysis assumptions, and review feedback loops.\n\n## Working Approach\n\n- Document hypotheses and evaluation criteria explicitly\n- Track source provenance and confidence level\n- Record analysis decisions and revision rationale\n`,
      inference
    );
  }
  if (domain === "writing" || domain === "creative") {
    return appendInferredSections(
      `# ${projectName}\n\nThis is a creative writing project. Track worldbuilding rules, character arcs, plot structure, style constraints, and revision decisions.\n\n## Writing Workflow\n\n- Keep narrative intent and tone constraints visible\n- Capture character/plot changes with consequences\n- Log revision notes and unresolved questions\n`,
      inference
    );
  }
  return appendInferredSections(
    `# ${projectName}\n\nThis project is not software-first. Keep practical notes, references, and task decisions so future sessions can resume quickly.\n\n## Workflow\n\n- Capture non-obvious lessons and reusable patterns\n- Keep references curated and current\n- Track active tasks and follow-ups\n`,
    inference
  );
}

export function ensureProjectScaffold(
  projectDir: string,
  projectName: string,
  domain: InitProjectDomain = "software",
  inference?: InferredInitScaffold | null,
): void {
  const normalizedDomain = normalizeBuiltinTopicDomain(inference?.domain ?? domain);
  const inferredTopics = Array.isArray(inference?.topics) && inference.topics.length > 0
    ? inference.topics
    : getBuiltinTopicConfig(normalizedDomain);
  fs.mkdirSync(projectDir, { recursive: true });

  if (!fs.existsSync(path.join(projectDir, "summary.md"))) {
    atomicWriteText(
      path.join(projectDir, "summary.md"),
      `# ${projectName}\n\n**What:** Replace this with one sentence about what the project does\n**Stack:** The key tech\n**Status:** active\n**Run:** the command you use most\n**Watch out:** the one thing that will bite you if you forget\n`
    );
  }

  if (!fs.existsSync(path.join(projectDir, "AGENTS.md"))) {
    atomicWriteText(
      path.join(projectDir, "AGENTS.md"),
      getDomainClaudeTemplate(projectName, inference?.domain ?? domain, inference)
    );
  }

  if (!fs.existsSync(path.join(projectDir, "topic-config.json"))) {
    atomicWriteText(
      path.join(projectDir, "topic-config.json"),
      JSON.stringify({ version: 1, domain: normalizedDomain, topics: inferredTopics }, null, 2) + "\n"
    );
  }

  if (!fs.existsSync(path.join(projectDir, FINDINGS_FILENAME))) {
    atomicWriteText(
      path.join(projectDir, FINDINGS_FILENAME),
      `# ${projectName} FINDINGS\n\n<!-- Findings are captured automatically during sessions and committed on exit -->\n`
    );
  }

  if (moduleEnabled(path.dirname(projectDir), "tasks") && !fs.existsSync(path.join(projectDir, TASKS_FILENAME))) {
    atomicWriteText(
      path.join(projectDir, TASKS_FILENAME),
      `# ${projectName} tasks\n\n## Active\n\n## Queue\n\n## Done\n`
    );
  }
}

/** Bootstrap a phren project from an existing project directory with AGENTS.md.
 * @param profile - if provided, only this profile YAML is updated (avoids leaking project to unrelated profiles).
 */
/**
 * Find an already-registered project that `sourceRoot` should reuse rather than
 * getting a near-duplicate directory of its own. Two signals, strongest first:
 *
 * 1. **Same source path.** Another project already points at this exact
 *    directory — unambiguous, reuse it whatever it is called.
 * 2. **Same canonical slug.** `max4liveplugins` vs `max4live-plugins`: the same
 *    repo spelled two ways. Only reused when the existing project has no source
 *    path recorded, or records this one — if it points somewhere else it is a
 *    genuinely different project that merely slugs alike, and both are kept.
 *
 * Returns `null` when nothing matches, i.e. create the project normally.
 */
function findExistingProjectForSource(
  phrenPath: string,
  sourceRoot: string,
  derivedName: string,
): string | null {
  let candidates: string[];
  try {
    candidates = fs.readdirSync(phrenPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch (err: unknown) {
    debugLog(`findExistingProjectForSource readdir: ${errorMessage(err)}`);
    return null;
  }

  const sourceOf = (project: string): string | null => {
    try {
      return getProjectSourcePath(phrenPath, project) ?? null;
    } catch (err: unknown) {
      debugLog(`findExistingProjectForSource config ${project}: ${errorMessage(err)}`);
      return null;
    }
  };

  const resolvedSource = path.resolve(sourceRoot);
  for (const project of candidates) {
    if (sourceOf(project) === resolvedSource) return project;
  }

  for (const project of findProjectNamesByCanonicalKey(phrenPath, derivedName)) {
    if (project === derivedName) return project; // exact match; nothing to reconcile
    const existingSource = sourceOf(project);
    if (existingSource === null || existingSource === resolvedSource) return project;
  }

  return null;
}

export function bootstrapFromExisting(
  phrenPath: string,
  projectPath: string,
  opts: string | BootstrapProjectOptions = {}
): BootstrapProjectResult {
  const profile = typeof opts === "string" ? opts : opts.profile;
  const profilePhrenPath = typeof opts === "string" ? phrenPath : (opts.profilePhrenPath ?? phrenPath);
  const resolvedPath = path.resolve(projectPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Path does not exist: ${resolvedPath}`);
  }
  const manifest = readRootManifest(phrenPath);
  const isProjectLocal = manifest?.installMode === "project-local";
  // A git worktree — notably the agent-managed ones under `.claude/worktrees/`
  // — is a checkout of a repository we may already track. Attribute it to that
  // repository instead of registering the worktree's throwaway codename as a
  // brand-new top-level project.
  const worktree = isProjectLocal ? null : resolveWorktreeParent(resolvedPath);
  const worktreeRepoRoot = worktree && fs.existsSync(worktree.repoRoot) ? worktree.repoRoot : null;
  if (worktreeRepoRoot) {
    debugLog(`bootstrapFromExisting: ${resolvedPath} is a ${worktree!.reason}; attributing to ${worktreeRepoRoot}`);
  }
  const sourceRoot = isProjectLocal
    ? path.resolve(manifest.workspaceRoot || resolvedPath)
    : (worktreeRepoRoot ?? resolvedPath);
  if (isProjectLocal) {
    const matchesWorkspace = resolvedPath === sourceRoot || resolvedPath.startsWith(sourceRoot + path.sep);
    if (!matchesWorkspace) {
      throw new Error(`Project-local phren can only enroll the owning workspace: ${sourceRoot}`);
    }
  }

  let claudeMdPath: string | null = null;
  const candidates = [
    path.join(sourceRoot, "AGENTS.md"),
    path.join(sourceRoot, ".claude", "CLAUDE.md"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      claudeMdPath = c;
      break;
    }
  }

  const claudeContent = claudeMdPath ? fs.readFileSync(claudeMdPath, "utf8") : null;
  const derivedName = isProjectLocal
    ? String(manifest?.primaryProject)
    : projectSlugFromPath(sourceRoot);
  const projectName = isProjectLocal
    ? derivedName
    : (findExistingProjectForSource(phrenPath, sourceRoot, derivedName) ?? derivedName);
  if (projectName !== derivedName) {
    debugLog(`bootstrapFromExisting: reusing existing project "${projectName}" for ${sourceRoot} (derived "${derivedName}")`);
  }
  const existingProject = findProjectNameCaseInsensitive(phrenPath, projectName);
  if (existingProject && existingProject !== projectName) {
    throw new Error(
      `Project "${existingProject}" already exists with different casing. Refusing to bootstrap "${projectName}" because it would split the same project on case-sensitive filesystems.`
    );
  }
  const projDir = path.join(phrenPath, projectName);
  fs.mkdirSync(projDir, { recursive: true });
  const inferredScaffold = inferInitScaffoldFromRepo(sourceRoot);
  const existingConfig = readProjectConfig(phrenPath, projectName);
  const ownership = typeof opts === "string"
    ? (parseProjectOwnershipMode(existingConfig.ownership) ?? getProjectOwnershipDefault(phrenPath))
    : (opts.ownership ?? parseProjectOwnershipMode(existingConfig.ownership) ?? getProjectOwnershipDefault(phrenPath));

  const claudePath = path.join(projDir, "AGENTS.md");
  if (ownership !== "repo-managed") {
    if (claudeContent) {
      if (!fs.existsSync(claudePath)) {
        atomicWriteText(claudePath, claudeContent);
      }
    } else {
      // No AGENTS.md found — create a starter one
      if (!fs.existsSync(claudePath)) {
        atomicWriteText(
          claudePath,
          getDomainClaudeTemplate(projectName, inferredScaffold?.domain ?? "software", inferredScaffold)
        );
      }
    }
  }

  const summaryLines: string[] = [];
  if (claudeContent) {
    const lines = claudeContent.split("\n");
    let foundHeading = false;
    for (const line of lines) {
      if (line.startsWith("# ") && !foundHeading) {
        foundHeading = true;
        summaryLines.push(line);
        continue;
      }
      if (foundHeading && line.trim() === "") {
        if (summaryLines.length > 1) break;
        continue;
      }
      if (foundHeading && summaryLines.length < 10) {
        summaryLines.push(line);
      }
    }
  }

  const sourceInfo = claudeMdPath ? `**Source AGENTS.md:** ${claudeMdPath}` : `**Source:** ${sourceRoot}`;
  const summaryPath = path.join(projDir, "summary.md");
  if (!fs.existsSync(summaryPath)) {
    atomicWriteText(
      summaryPath,
      `# ${projectName}\n\n**What:** Bootstrapped from ${sourceRoot}\n${sourceInfo}\n\n${summaryLines.length > 1 ? summaryLines.slice(1).join("\n") : ""}\n`
    );
  }

  if (!fs.existsSync(path.join(projDir, FINDINGS_FILENAME))) {
    atomicWriteText(
      path.join(projDir, FINDINGS_FILENAME),
      `# ${projectName} FINDINGS\n\n<!-- Bootstrapped from ${sourceRoot} -->\n`
    );
  }
  if (moduleEnabled(phrenPath, "tasks") && !fs.existsSync(path.join(projDir, TASKS_FILENAME))) {
    atomicWriteText(
      path.join(projDir, TASKS_FILENAME),
      `# ${projectName} tasks\n\n## Active\n\n## Queue\n\n## Done\n`
    );
  }
  if (!fs.existsSync(path.join(projDir, "topic-config.json"))) {
    const inferredDomain = normalizeBuiltinTopicDomain(inferredScaffold?.domain ?? "software");
    const inferredTopics = inferredScaffold?.topics?.length
      ? inferredScaffold.topics
      : getBuiltinTopicConfig(inferredDomain);
    atomicWriteText(
      path.join(projDir, "topic-config.json"),
      JSON.stringify({ version: 1, domain: inferredDomain, topics: inferredTopics }, null, 2) + "\n"
    );
  }

  const activeProfile = resolveActiveProfile(profilePhrenPath, profile);
  if (activeProfile.ok && activeProfile.data) {
    const addResult = addProjectToProfile(profilePhrenPath, activeProfile.data, projectName);
    if (!addResult.ok) {
      throw new Error(addResult.error);
    }
  } else if (!activeProfile.ok && activeProfile.code !== "FILE_NOT_FOUND") {
    throw new Error(activeProfile.error);
  }

  recordProjectSourcePath(phrenPath, projectName, sourceRoot, { ownership });

  return {
    project: projectName,
    ownership,
    claudePath: ownership === "repo-managed"
      ? (claudeMdPath ?? null)
      : (fs.existsSync(claudePath) ? claudePath : null),
  };
}
