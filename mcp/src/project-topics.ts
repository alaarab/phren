import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { debugLog } from "./shared.js";
import { withFileLock } from "./shared-governance.js";
import { STOP_WORDS, errorMessage, extractKeywords, isValidProjectName, safeProjectPath } from "./utils.js";

export interface ProjectTopic {
  slug: string;
  label: string;
  description: string;
  keywords: string[];
}

export interface BuiltinTopic {
  name: string;
  description: string;
  keywords: string[];
}

interface TopicInputShape {
  slug?: string;
  label?: string;
  name?: string;
  description?: string;
  keywords?: unknown;
}

interface ProjectTopicConfigFile {
  version: 1;
  domain?: string;
  topics: TopicInputShape[];
  pinnedTopics?: ProjectTopic[];
}

export type ProjectTopicSource = "default" | "custom";

export interface ProjectTopicDocInfo {
  slug: string;
  label: string;
  file: string;
  path: string;
  exists: boolean;
  autoManaged: boolean;
  entryCount: number;
  lastModified: string;
}

export interface ProjectReferenceDocInfo {
  file: string;
  path: string;
  title: string;
  autoManaged: boolean;
  entryCount: number;
  lastModified: string;
}

export interface LegacyTopicDocInfo extends ProjectReferenceDocInfo {
  slug: string;
  eligible: boolean;
  reason?: string;
}

export interface ProjectTopicSuggestion {
  slug: string;
  label: string;
  description: string;
  keywords: string[];
  source: "builtin" | "heuristic" | "pinned";
  reason: string;
  confidence: number;
}

export interface ProjectTopicsResponse {
  source: ProjectTopicSource;
  topics: ProjectTopic[];
  suggestions: ProjectTopicSuggestion[];
  pinnedTopics: ProjectTopic[];
  legacyDocs: LegacyTopicDocInfo[];
  topicDocs: ProjectTopicDocInfo[];
}

export interface ReferenceListResponse {
  topicDocs: ProjectTopicDocInfo[];
  otherDocs: ProjectReferenceDocInfo[];
}

export interface ReclassifyTopicsResult {
  movedFiles: number;
  movedEntries: number;
  skipped: Array<{ file: string; reason: string }>;
}

interface ArchivedTopicEntry {
  date: string;
  bullet: string;
  citation?: string;
}

const TOPIC_CONFIG_FILENAME = "topic-config.json";
const AUTO_TOPIC_MARKER_PREFIX = "<!-- cortex:auto-topic";
const AUTO_TOPIC_MARKER_RE = /^<!--\s*cortex:auto-topic(?:\s+slug=([a-z0-9_-]+))?\s*-->$/;
const ARCHIVED_SECTION_RE = /^## Archived (\d{4}-\d{2}-\d{2})$/;
const SOFTWARE_TOPICS: ProjectTopic[] = [
  {
    slug: "api",
    label: "API",
    description: "Endpoints, routes, requests, responses, and protocol-level integration details.",
    keywords: ["api", "endpoint", "route", "rest", "graphql", "grpc", "request", "response", "http", "url", "webhook", "cors"],
  },
  {
    slug: "database",
    label: "Database",
    description: "Schemas, queries, indexes, migrations, and storage-engine behavior.",
    keywords: ["database", "db", "sql", "query", "index", "migration", "schema", "table", "column", "postgres", "mysql", "sqlite", "mongo", "redis", "orm"],
  },
  {
    slug: "performance",
    label: "Performance",
    description: "Latency, throughput, profiling, caching, and resource bottlenecks.",
    keywords: ["performance", "speed", "latency", "cache", "optimize", "memory", "cpu", "bottleneck", "profiling", "benchmark", "throughput", "lazy"],
  },
  {
    slug: "security",
    label: "Security",
    description: "Security issues, hardening, encryption, authentication surfaces, and abuse resistance.",
    keywords: ["security", "vulnerability", "xss", "csrf", "injection", "sanitize", "escape", "encrypt", "decrypt", "hash", "salt", "tls", "ssl"],
  },
  {
    slug: "frontend",
    label: "Frontend",
    description: "UI rendering, layout, interaction, browser behavior, and client-side frameworks.",
    keywords: ["frontend", "ui", "ux", "css", "html", "dom", "render", "component", "layout", "responsive", "animation", "browser", "react", "vue", "angular"],
  },
  {
    slug: "testing",
    label: "Testing",
    description: "Test strategy, fixtures, assertions, mocks, and validation workflows.",
    keywords: ["test", "spec", "assert", "mock", "stub", "fixture", "coverage", "jest", "vitest", "playwright", "e2e", "unit", "integration"],
  },
  {
    slug: "devops",
    label: "DevOps",
    description: "Deployment, CI/CD, infrastructure, containers, and operational workflows.",
    keywords: ["deploy", "ci", "cd", "pipeline", "docker", "kubernetes", "container", "infra", "terraform", "aws", "cloud", "monitoring", "logging"],
  },
  {
    slug: "architecture",
    label: "Architecture",
    description: "System shape, module boundaries, design patterns, and structural decisions.",
    keywords: ["architecture", "design", "pattern", "layer", "module", "system", "structure", "microservice", "monolith", "event-driven", "plugin"],
  },
  {
    slug: "debugging",
    label: "Debugging",
    description: "Bugs, errors, traces, workarounds, and debugging techniques.",
    keywords: ["debug", "bug", "error", "crash", "fix", "issue", "stack", "trace", "breakpoint", "log", "workaround", "pitfall", "caveat"],
  },
  {
    slug: "tooling",
    label: "Tooling",
    description: "Build tools, scripts, package management, hooks, and developer tooling.",
    keywords: ["tool", "cli", "script", "build", "webpack", "vite", "eslint", "prettier", "npm", "package", "config", "plugin", "hook", "git"],
  },
  {
    slug: "auth",
    label: "Auth",
    description: "Authentication, sessions, permissions, and access control behavior.",
    keywords: ["auth", "login", "logout", "session", "token", "jwt", "oauth", "sso", "permission", "role", "access", "credential"],
  },
  {
    slug: "data",
    label: "Data",
    description: "Data models, serialization, parsing, validation, and data flow details.",
    keywords: ["data", "model", "schema", "serialize", "deserialize", "json", "csv", "transform", "validate", "parse", "format", "encode"],
  },
  {
    slug: "mobile",
    label: "Mobile",
    description: "Mobile UX, device-specific behavior, native apps, and mobile frameworks.",
    keywords: ["mobile", "ios", "android", "react-native", "flutter", "native", "touch", "gesture", "push-notification", "app-store"],
  },
  {
    slug: "ai_ml",
    label: "AI / ML",
    description: "Models, embeddings, prompts, inference, and ML-specific systems.",
    keywords: ["ai", "ml", "model", "embedding", "vector", "llm", "prompt", "token", "inference", "training", "neural", "gpt", "claude"],
  },
  {
    slug: "general",
    label: "General",
    description: "Fallback bucket for findings that do not fit a project-specific topic yet.",
    keywords: [],
  },
];
const DOMAIN_TOPICS: Record<string, ProjectTopic[]> = {
  software: SOFTWARE_TOPICS,
  music: [
    {
      slug: "composition",
      label: "Composition",
      description: "Melody, harmony, rhythm, and songwriting decisions.",
      keywords: ["composition", "songwriting", "melody", "harmony", "chords", "rhythm", "motif"],
    },
    {
      slug: "production",
      label: "Production",
      description: "Session workflow, recording choices, and production techniques.",
      keywords: ["production", "recording", "session", "tracking", "workflow", "arrangement", "producer"],
    },
    {
      slug: "mixing",
      label: "Mixing",
      description: "Balance, EQ, dynamics, and spatial processing choices.",
      keywords: ["mixing", "mix", "eq", "compression", "reverb", "delay", "balance", "panning"],
    },
    {
      slug: "sound-design",
      label: "Sound Design",
      description: "Timbre creation, synthesis, sampling, and texture shaping.",
      keywords: ["sound-design", "sound design", "synthesis", "synth", "patch", "sample", "texture"],
    },
    {
      slug: "instruments",
      label: "Instruments",
      description: "Instrument selection, performance notes, and articulation decisions.",
      keywords: ["instrument", "instruments", "guitar", "piano", "drums", "bass", "performance"],
    },
    {
      slug: "theory",
      label: "Theory",
      description: "Music theory concepts, progressions, and structural analysis.",
      keywords: ["theory", "scale", "mode", "progression", "counterpoint", "voice-leading", "tonality"],
    },
    {
      slug: "arrangement",
      label: "Arrangement",
      description: "Section structure, orchestration, and part distribution.",
      keywords: ["arrangement", "arrange", "structure", "section", "orchestration", "voicing"],
    },
    {
      slug: "mastering",
      label: "Mastering",
      description: "Final loudness, translation checks, and delivery formats.",
      keywords: ["mastering", "master", "loudness", "limiting", "metering", "delivery", "reference"],
    },
  ],
  game: [
    {
      slug: "mechanics",
      label: "Mechanics",
      description: "Core gameplay systems, controls, and player interaction rules.",
      keywords: ["mechanics", "gameplay", "controls", "systems", "player", "loop", "balance"],
    },
    {
      slug: "rendering",
      label: "Rendering",
      description: "Graphics pipeline, shaders, performance, and visual output.",
      keywords: ["rendering", "graphics", "shader", "pipeline", "lighting", "fps", "gpu"],
    },
    {
      slug: "physics",
      label: "Physics",
      description: "Simulation behavior, collisions, and movement dynamics.",
      keywords: ["physics", "collision", "rigidbody", "simulation", "velocity", "forces"],
    },
    {
      slug: "ai",
      label: "AI",
      description: "Agent behavior, decision-making, and pathfinding systems.",
      keywords: ["ai", "npc", "behavior", "pathfinding", "state-machine", "decision", "navigation"],
    },
    {
      slug: "level-design",
      label: "Level Design",
      description: "Map layout, encounter flow, and progression structure.",
      keywords: ["level-design", "level design", "level", "map", "encounter", "pacing", "layout"],
    },
    {
      slug: "audio",
      label: "Audio",
      description: "In-game sound effects, music integration, and audio systems.",
      keywords: ["audio", "sfx", "music", "voice", "spatial-audio", "mix", "implementation"],
    },
    {
      slug: "networking",
      label: "Networking",
      description: "Multiplayer sync, replication, latency handling, and netcode.",
      keywords: ["networking", "multiplayer", "replication", "latency", "netcode", "server", "client"],
    },
    {
      slug: "ui",
      label: "UI",
      description: "HUD, menus, readability, and interaction flows.",
      keywords: ["ui", "hud", "menu", "interface", "ux", "interaction", "readability"],
    },
  ],
  research: [
    {
      slug: "methodology",
      label: "Methodology",
      description: "Research design, protocol choices, and evaluation approach.",
      keywords: ["methodology", "method", "protocol", "design", "experiment", "evaluation"],
    },
    {
      slug: "sources",
      label: "Sources",
      description: "Primary references, citations, provenance, and credibility checks.",
      keywords: ["sources", "citation", "reference", "paper", "provenance", "credibility"],
    },
    {
      slug: "analysis",
      label: "Analysis",
      description: "Interpretation, data analysis, and evidence synthesis.",
      keywords: ["analysis", "data", "interpretation", "evidence", "findings", "synthesis"],
    },
    {
      slug: "writing",
      label: "Writing",
      description: "Drafting, clarity, structure, and argument framing.",
      keywords: ["writing", "draft", "structure", "clarity", "argument", "narrative"],
    },
    {
      slug: "review",
      label: "Review",
      description: "Peer feedback, revision notes, and quality checks.",
      keywords: ["review", "peer-review", "feedback", "revision", "critique", "quality"],
    },
  ],
  creative: [
    {
      slug: "worldbuilding",
      label: "Worldbuilding",
      description: "Setting rules, lore consistency, and environment details.",
      keywords: ["worldbuilding", "setting", "lore", "canon", "environment", "rules"],
    },
    {
      slug: "characters",
      label: "Characters",
      description: "Character goals, arcs, voice, and relationship dynamics.",
      keywords: ["characters", "character", "arc", "motivation", "voice", "relationship"],
    },
    {
      slug: "plot",
      label: "Plot",
      description: "Story beats, pacing, conflict, and narrative structure.",
      keywords: ["plot", "story", "beats", "conflict", "pacing", "structure"],
    },
    {
      slug: "style",
      label: "Style",
      description: "Tone, diction, constraints, and stylistic direction.",
      keywords: ["style", "tone", "voice", "diction", "register", "aesthetic"],
    },
    {
      slug: "research",
      label: "Research",
      description: "Reference gathering, fact checks, and contextual grounding.",
      keywords: ["research", "reference", "fact-check", "context", "source", "notes"],
    },
    {
      slug: "revision",
      label: "Revision",
      description: "Editing passes, rewrite strategy, and quality improvements.",
      keywords: ["revision", "edit", "rewrite", "polish", "draft", "improve"],
    },
  ],
  other: [
    {
      slug: "notes",
      label: "Notes",
      description: "General observations and quick capture items.",
      keywords: ["notes", "observation", "idea", "capture", "context"],
    },
    {
      slug: "reference",
      label: "Reference",
      description: "Supporting references, links, and background material.",
      keywords: ["reference", "links", "docs", "source", "background"],
    },
    {
      slug: "tasks",
      label: "Tasks",
      description: "Action items, follow-ups, and execution checklist details.",
      keywords: ["tasks", "todo", "action", "follow-up", "checklist"],
    },
  ],
};
const GENERAL_TOPIC: ProjectTopic = SOFTWARE_TOPICS.find((topic) => topic.slug === "general")!;
const DEFAULT_TOPIC_LIMIT = 8;
const SUGGESTION_LIMIT = 8;

function normalizeKeyword(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTopicSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

function titleCaseLabel(raw: string): string {
  return raw
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeTopic(topic: TopicInputShape): ProjectTopic {
  const name = typeof topic.name === "string" ? topic.name : "";
  const labelInput = typeof topic.label === "string" ? topic.label : name;
  const slugInput = typeof topic.slug === "string" ? topic.slug : labelInput;
  const slug = normalizeTopicSlug(slugInput || labelInput);
  const label = (labelInput || titleCaseLabel(slug)).trim() || titleCaseLabel(slug);
  const description = (typeof topic.description === "string" ? topic.description : "").trim();
  const keywords = Array.from(new Set(
    (Array.isArray(topic.keywords) ? topic.keywords : [])
      .map((keyword) => normalizeKeyword(String(keyword)))
      .filter((keyword) => keyword.length > 1)
  ));
  return { slug, label, description, keywords };
}

function normalizeTopics(topics: TopicInputShape[]): ProjectTopic[] {
  return topics.map(normalizeTopic);
}

function dedupeTopics(topics: ProjectTopic[]): ProjectTopic[] {
  const seen = new Set<string>();
  const unique: ProjectTopic[] = [];
  for (const topic of topics) {
    if (!topic.slug || seen.has(topic.slug)) continue;
    seen.add(topic.slug);
    unique.push(topic);
  }
  return unique;
}

function validateTopics(topics: ProjectTopic[]): string | null {
  if (!Array.isArray(topics) || topics.length === 0) return "Provide at least one topic.";
  const seen = new Set<string>();
  const keywordOwners = new Map<string, string>();
  let hasGeneral = false;
  for (const topic of topics) {
    if (!topic.slug || !isValidProjectName(topic.slug)) {
      return `Invalid topic slug: "${topic.slug || "(empty)"}".`;
    }
    if (!topic.label.trim()) return `Topic "${topic.slug}" is missing a label.`;
    if (seen.has(topic.slug)) return `Duplicate topic slug: "${topic.slug}".`;
    seen.add(topic.slug);
    for (const keyword of topic.keywords) {
      const owner = keywordOwners.get(keyword);
      if (owner && owner !== topic.slug) {
        return `Duplicate topic keyword: "${keyword}" is used by both "${owner}" and "${topic.slug}".`;
      }
      keywordOwners.set(keyword, topic.slug);
    }
    if (topic.slug === "general") hasGeneral = true;
  }
  if (!hasGeneral) return "Topics must include the reserved fallback topic \"general\".";
  return null;
}

function ensureGeneralTopic(topics: ProjectTopic[]): ProjectTopic[] {
  if (topics.some((topic) => topic.slug === "general")) return topics;
  return [...topics, { ...GENERAL_TOPIC, keywords: [...GENERAL_TOPIC.keywords] }];
}

function topicConfigPath(cortexPath: string, project: string): string | null {
  return safeProjectPath(cortexPath, project, TOPIC_CONFIG_FILENAME);
}

function projectDirPath(cortexPath: string, project: string): string | null {
  return safeProjectPath(cortexPath, project);
}

export function topicReferenceDir(cortexPath: string, project: string): string | null {
  return safeProjectPath(cortexPath, project, "reference", "topics");
}

export function topicReferenceRelativePath(slug: string): string {
  return path.posix.join("reference", "topics", `${slug}.md`);
}

export function topicReferencePath(cortexPath: string, project: string, slug: string): string | null {
  return safeProjectPath(cortexPath, project, "reference", "topics", `${normalizeTopicSlug(slug)}.md`);
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (err: unknown) {
    debugLog(`readJsonFile: failed to parse ${filePath}: ${errorMessage(err)}`);
    return null;
  }
}

function countByTerm(terms: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of terms) {
    const current = counts.get(term) ?? 0;
    counts.set(term, current + 1);
  }
  return counts;
}

function readTopicInputContent(cortexPath: string, project: string): string[] {
  const parts: string[] = [];
  for (const file of ["CLAUDE.md", "FINDINGS.md"]) {
    const filePath = safeProjectPath(cortexPath, project, file);
    if (!filePath || !fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf8").trim();
    if (content) parts.push(content);
  }
  const referenceDir = safeProjectPath(cortexPath, project, "reference");
  if (referenceDir && fs.existsSync(referenceDir)) {
    for (const filePath of readReferenceMarkdownFiles(referenceDir)) {
      try {
        const content = fs.readFileSync(filePath, "utf8").trim();
        if (content) parts.push(content);
      } catch {
        // Ignore unreadable files and continue.
      }
    }
  }
  return parts;
}

interface TopicContentSignal {
  hasContent: boolean;
  corpus: string;
  corpusLower: string;
  termCounts: Map<string, number>;
}

function buildTopicContentSignal(cortexPath: string, project: string): TopicContentSignal {
  const parts = readTopicInputContent(cortexPath, project);
  const corpus = parts.join("\n");
  if (!corpus.trim()) {
    return { hasContent: false, corpus: "", corpusLower: "", termCounts: new Map<string, number>() };
  }
  const keywordSignal = extractKeywords(corpus);
  const termCounts = countByTerm(tokenizeSuggestionTerms(`${corpus}\n${keywordSignal}`));
  return { hasContent: true, corpus, corpusLower: corpus.toLowerCase(), termCounts };
}

function termScore(termCounts: Map<string, number>, term: string): number {
  const normalized = normalizeKeyword(term);
  if (!normalized) return 0;
  return termCounts.get(normalized) ?? 0;
}

function buildAdaptiveTopicCandidates(signal: TopicContentSignal, catalog: ProjectTopic[]): Array<{ topic: ProjectTopic; score: number }> {
  const scored: Array<{ topic: ProjectTopic; score: number }> = [];
  for (const topic of catalog) {
    if (topic.slug === "general") continue;
    const base = termScore(signal.termCounts, topic.label);
    const keywordScore = topic.keywords.reduce((sum, keyword) => sum + termScore(signal.termCounts, keyword), 0);
    const score = base + keywordScore;
    if (score <= 0) continue;
    scored.push({ topic, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.topic.label.localeCompare(b.topic.label));
}

function buildHeuristicTopicCandidates(signal: TopicContentSignal, takenSlugs: Set<string>): Array<{ topic: ProjectTopic; score: number }> {
  const entries = [...signal.termCounts.entries()]
    .filter(([term, count]) => count >= 3 && term.length >= 4 && term.length <= 48)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out: Array<{ topic: ProjectTopic; score: number }> = [];
  for (const [term, score] of entries) {
    if (out.length >= DEFAULT_TOPIC_LIMIT) break;
    if (term.split(" ").length > 2) continue;
    const slug = normalizeTopicSlug(term);
    if (!slug || takenSlugs.has(slug) || slug === "general") continue;
    takenSlugs.add(slug);
    const keywords = Array.from(new Set(
      term.split(" ")
        .concat(slug.split("-"))
        .map((keyword) => normalizeKeyword(keyword))
        .filter((keyword) => keyword.length > 2)
    )).slice(0, 6);
    out.push({
      topic: {
        slug,
        label: titleCaseLabel(term),
        description: "Suggested from repeated terminology in project findings and reference docs.",
        keywords,
      },
      score,
    });
  }
  return out;
}

function confidenceFromScore(score: number): number {
  const value = Math.min(0.99, 0.2 + Math.log1p(Math.max(0, score)) / 3.2);
  return Number(value.toFixed(2));
}

export function normalizeBuiltinTopicDomain(domain?: string): keyof typeof DOMAIN_TOPICS {
  if (!domain) return "software";
  const normalized = domain.trim().toLowerCase();
  if (normalized === "writing") return "creative";
  if (normalized in DOMAIN_TOPICS) return normalized as keyof typeof DOMAIN_TOPICS;
  return "software";
}

function resolveDomainTopics(domain?: string): ProjectTopic[] {
  return DOMAIN_TOPICS[normalizeBuiltinTopicDomain(domain)];
}

export function getBuiltinTopicConfig(domain?: string): BuiltinTopic[] {
  return ensureGeneralTopic(resolveDomainTopics(domain))
    .map((topic) => ({
      name: topic.label,
      description: topic.description,
      keywords: [...topic.keywords],
    }));
}

function readProjectDomain(cortexPath: string, project: string): string | undefined {
  const configPath = topicConfigPath(cortexPath, project);
  if (!configPath || !fs.existsSync(configPath)) return undefined;
  const parsed = readJsonFile<ProjectTopicConfigFile>(configPath);
  return typeof parsed?.domain === "string" ? parsed.domain : undefined;
}

export function getBuiltinTopics(cortexPath?: string, project?: string): ProjectTopic[] {
  const domain = (cortexPath && project) ? readProjectDomain(cortexPath, project) : undefined;
  const fallback = ensureGeneralTopic(resolveDomainTopics(domain)).map((topic) => ({ ...topic, keywords: [...topic.keywords] }));
  if (!cortexPath || !project || !isValidProjectName(project)) return fallback;

  const signal = buildTopicContentSignal(cortexPath, project);
  if (!signal.hasContent) return fallback;

  const adaptive: ProjectTopic[] = [];
  const taken = new Set<string>();
  for (const candidate of buildAdaptiveTopicCandidates(signal, fallback)) {
    if (adaptive.length >= DEFAULT_TOPIC_LIMIT - 1) break;
    if (candidate.score < 2) continue;
    if (taken.has(candidate.topic.slug)) continue;
    taken.add(candidate.topic.slug);
    adaptive.push({ ...candidate.topic, keywords: [...candidate.topic.keywords] });
  }
  for (const candidate of buildHeuristicTopicCandidates(signal, taken)) {
    if (adaptive.length >= DEFAULT_TOPIC_LIMIT - 1) break;
    adaptive.push(candidate.topic);
  }

  const merged = ensureGeneralTopic(dedupeTopics(adaptive));
  if (merged.length <= 1) return fallback;
  return merged;
}

export function readProjectTopics(cortexPath: string, project: string): { source: ProjectTopicSource; topics: ProjectTopic[]; domain?: string } {
  const builtinTopics = getBuiltinTopics(cortexPath, project);
  const configPath = topicConfigPath(cortexPath, project);
  if (!configPath || !fs.existsSync(configPath)) {
    return { source: "default", topics: builtinTopics };
  }
  const parsed = readJsonFile<ProjectTopicConfigFile>(configPath);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.topics)) {
    return { source: "default", topics: builtinTopics };
  }
  const normalized = ensureGeneralTopic(normalizeTopics(parsed.topics));
  const validationError = validateTopics(normalized);
  if (validationError) {
    debugLog(`readProjectTopics: invalid ${configPath}: ${validationError}`);
    return { source: "default", topics: builtinTopics };
  }
  return { source: "custom", topics: normalized, domain: typeof parsed.domain === "string" ? parsed.domain : undefined };
}

export function readPinnedTopics(cortexPath: string, project: string): ProjectTopic[] {
  const configPath = topicConfigPath(cortexPath, project);
  if (!configPath || !fs.existsSync(configPath)) return [];
  const parsed = readJsonFile<ProjectTopicConfigFile>(configPath);
  if (!parsed || !Array.isArray(parsed.pinnedTopics)) return [];
  return dedupeTopics(normalizeTopics(parsed.pinnedTopics)).filter((topic) => topic.slug !== "general");
}

function writePinnedTopics(cortexPath: string, project: string, pinnedTopics: ProjectTopic[]): { ok: true; pinnedTopics: ProjectTopic[] } | { ok: false; error: string } {
  if (!isValidProjectName(project)) return { ok: false, error: `Invalid project: "${project}".` };
  const configPath = topicConfigPath(cortexPath, project);
  if (!configPath) return { ok: false, error: `Invalid project path for "${project}".` };
  const pinned = dedupeTopics(normalizeTopics(pinnedTopics)).filter((topic) => topic.slug !== "general");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  withFileLock(configPath, () => {
    const existing = readJsonFile<ProjectTopicConfigFile>(configPath);
    const payload: ProjectTopicConfigFile = {
      version: 1,
      topics: ensureGeneralTopic(normalizeTopics(Array.isArray(existing?.topics) ? existing.topics : getBuiltinTopics(cortexPath, project))),
      pinnedTopics: pinned,
      ...(typeof existing?.domain === "string" ? { domain: existing.domain } : {}),
    };
    const tmpPath = `${configPath}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n");
    fs.renameSync(tmpPath, configPath);
  });
  return { ok: true, pinnedTopics: pinned };
}

export function pinProjectTopicSuggestion(
  cortexPath: string,
  project: string,
  topic: ProjectTopic,
): { ok: true; pinnedTopics: ProjectTopic[] } | { ok: false; error: string } {
  const current = readPinnedTopics(cortexPath, project);
  return writePinnedTopics(cortexPath, project, [...current, topic]);
}

export function unpinProjectTopicSuggestion(
  cortexPath: string,
  project: string,
  slug: string,
): { ok: true; pinnedTopics: ProjectTopic[] } | { ok: false; error: string } {
  const normalized = normalizeTopicSlug(slug);
  const current = readPinnedTopics(cortexPath, project).filter((topic) => topic.slug !== normalized);
  return writePinnedTopics(cortexPath, project, current);
}

export function writeProjectTopics(cortexPath: string, project: string, topics: ProjectTopic[]): { ok: true; topics: ProjectTopic[] } | { ok: false; error: string } {
  if (!isValidProjectName(project)) return { ok: false, error: `Invalid project: "${project}".` };
  const configPath = topicConfigPath(cortexPath, project);
  if (!configPath) return { ok: false, error: `Invalid project path for "${project}".` };
  const normalized = ensureGeneralTopic(normalizeTopics(topics));
  const validationError = validateTopics(normalized);
  if (validationError) return { ok: false, error: validationError };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  withFileLock(configPath, () => {
    const existing = readJsonFile<ProjectTopicConfigFile>(configPath);
    const payload: ProjectTopicConfigFile = {
      version: 1,
      topics: normalized,
      ...(Array.isArray(existing?.pinnedTopics) ? { pinnedTopics: dedupeTopics(normalizeTopics(existing.pinnedTopics)).filter((topic) => topic.slug !== "general") } : {}),
      ...(typeof existing?.domain === "string" ? { domain: existing.domain } : {}),
    };
    const tmpPath = `${configPath}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n");
    fs.renameSync(tmpPath, configPath);
  });
  return { ok: true, topics: normalized };
}

export function classifyTopicForText(text: string, topics: ProjectTopic[]): ProjectTopic {
  const lower = text.toLowerCase();
  let bestTopic = topics.find((topic) => topic.slug === "general") ?? topics[topics.length - 1];
  let bestScore = 0;
  for (const topic of topics) {
    if (topic.slug === "general") continue;
    let score = 0;
    for (const keyword of topic.keywords) {
      if (keyword && lower.includes(keyword)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestTopic = topic;
    }
  }
  return bestTopic;
}

function topicDocHeader(project: string, topic: ProjectTopic): string {
  const lines = [
    `# ${project} - ${topic.label}`,
    "",
    `<!-- cortex:auto-topic slug=${topic.slug} -->`,
  ];
  if (topic.description) lines.push(`<!-- cortex:topic-description ${topic.description.replace(/-->/g, "").trim()} -->`);
  lines.push("");
  return lines.join("\n");
}

function normalizeBullet(line: string): string {
  return line.replace(/<!--.*?-->/g, "").replace(/^-\s+/, "").trim().toLowerCase();
}

function collectArchivedBulletsRecursively(dirPath: string): Set<string> {
  const bullets = new Set<string>();
  if (!fs.existsSync(dirPath)) return bullets;
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const content = fs.readFileSync(fullPath, "utf8");
      for (const line of content.split("\n")) {
        if (!line.startsWith("- ")) continue;
        const normalized = normalizeBullet(line);
        if (normalized) bullets.add(normalized);
      }
    }
  }
  return bullets;
}

export function appendArchivedEntriesToTopicDoc(filePath: string, project: string, topic: ProjectTopic, entries: Array<{ date: string; bullet: string; citation?: string }>): void {
  if (entries.length === 0) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  withFileLock(filePath, () => {
    let existing = "";
    if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, "utf8");
    else existing = topicDocHeader(project, topic);
    const grouped = new Map<string, ArchivedTopicEntry[]>();
    for (const entry of entries) {
      const bucket = grouped.get(entry.date) ?? [];
      bucket.push(entry);
      grouped.set(entry.date, bucket);
    }
    const sections: string[] = [];
    for (const [date, groupedEntries] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      sections.push(`## Archived ${date}`, "");
      for (const entry of groupedEntries) {
        sections.push(entry.bullet);
        if (entry.citation) sections.push(entry.citation);
      }
      sections.push("");
    }
    const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmpPath, existing.trimEnd() + "\n\n" + sections.join("\n"));
    fs.renameSync(tmpPath, filePath);
  });
}

export function ensureTopicReferenceDoc(cortexPath: string, project: string, topic: ProjectTopic): { ok: true; path: string } | { ok: false; error: string } {
  const filePath = topicReferencePath(cortexPath, project, topic.slug);
  if (!filePath) return { ok: false, error: `Invalid topic doc path for "${topic.slug}".` };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      withFileLock(filePath, () => {
        if (fs.existsSync(filePath)) return;
        const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
        fs.writeFileSync(tmpPath, topicDocHeader(project, topic));
        fs.renameSync(tmpPath, filePath);
      });
    }
    return { ok: true, path: filePath };
  } catch (err: unknown) {
    return { ok: false, error: errorMessage(err) };
  }
}

function parseLegacyTopicEntries(content: string, project: string): { slug: string; entries: ArchivedTopicEntry[] } | { slug: string; error: string } {
  const lines = content.split("\n");
  const firstNonEmpty = lines.find((line) => line.trim().length > 0);
  if (!firstNonEmpty) return { slug: "general", error: "empty file" };
  const headingMatch = firstNonEmpty.match(new RegExp(`^#\\s+${project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+-\\s+(.+)$`, "i"));
  const fallbackSlug = headingMatch ? normalizeTopicSlug(headingMatch[1]) : "general";
  if (!headingMatch) return { slug: fallbackSlug, error: "missing auto-archive heading" };

  const entries: ArchivedTopicEntry[] = [];
  let currentDate = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0 || line === firstNonEmpty) continue;
    const markerMatch = line.match(AUTO_TOPIC_MARKER_RE);
    if (markerMatch) continue;
    const archivedHeading = line.match(ARCHIVED_SECTION_RE);
    if (archivedHeading) {
      currentDate = archivedHeading[1];
      continue;
    }
    if (!currentDate) return { slug: fallbackSlug, error: "content exists before archived sections" };
    if (!line.startsWith("- ")) {
      if (/^\s*<!--\s*cortex:topic-description\b/.test(line)) continue;
      return { slug: fallbackSlug, error: "contains non-archived prose" };
    }
    const next = lines[i + 1] || "";
    const hasCitation = /^\s*<!--\s*cortex:cite\s+\{.*\}\s*-->/.test(next);
    entries.push({
      date: currentDate,
      bullet: line,
      citation: hasCitation ? next : undefined,
    });
    if (hasCitation) i++;
  }

  if (entries.length === 0) return { slug: fallbackSlug, error: "no archived bullet entries" };
  return { slug: fallbackSlug, entries };
}

function readReferenceMarkdownFiles(referenceDir: string): string[] {
  if (!fs.existsSync(referenceDir)) return [];
  const files: string[] = [];
  const stack = [referenceDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) files.push(fullPath);
    }
  }
  return files.sort();
}

function relativeToProject(projectDir: string, filePath: string): string {
  return path.relative(projectDir, filePath).replace(/\\/g, "/");
}

function docTitleFromContent(filePath: string, content: string): string {
  const heading = content.split("\n").find((line) => /^#\s+/.test(line));
  if (heading) return heading.replace(/^#\s+/, "").trim();
  return path.basename(filePath, ".md");
}

function entryCountFromContent(content: string): number {
  return content.split("\n").filter((line) => line.startsWith("- ")).length;
}

function safeStatIso(filePath: string): string {
  try { return new Date(fs.statSync(filePath).mtimeMs).toISOString(); } catch { return ""; }
}

export function listProjectTopicDocs(cortexPath: string, project: string, topics?: ProjectTopic[]): ProjectTopicDocInfo[] {
  const projectDir = projectDirPath(cortexPath, project);
  if (!projectDir) return [];
  const topicList = topics ?? readProjectTopics(cortexPath, project).topics;
  return topicList.map((topic) => {
    const filePath = topicReferencePath(cortexPath, project, topic.slug);
    const exists = Boolean(filePath && fs.existsSync(filePath));
    let entryCount = 0;
    if (filePath && exists) {
      entryCount = entryCountFromContent(fs.readFileSync(filePath, "utf8"));
    }
    return {
      slug: topic.slug,
      label: topic.label,
      file: topicReferenceRelativePath(topic.slug),
      path: filePath || topicReferenceRelativePath(topic.slug),
      exists,
      autoManaged: true,
      entryCount,
      lastModified: filePath && exists ? safeStatIso(filePath) : "",
    };
  });
}

export function listProjectReferenceDocs(cortexPath: string, project: string, topics?: ProjectTopic[]): ReferenceListResponse {
  const projectDir = projectDirPath(cortexPath, project);
  if (!projectDir) return { topicDocs: [], otherDocs: [] };
  const topicDocs = listProjectTopicDocs(cortexPath, project, topics);
  const referenceDir = safeProjectPath(cortexPath, project, "reference");
  if (!referenceDir || !fs.existsSync(referenceDir)) return { topicDocs, otherDocs: [] };
  const otherDocs: ProjectReferenceDocInfo[] = [];
  for (const filePath of readReferenceMarkdownFiles(referenceDir)) {
    const rel = relativeToProject(projectDir, filePath);
    if (rel.startsWith("reference/topics/")) continue;
    const content = fs.readFileSync(filePath, "utf8");
    const marker = content.split("\n").find((line) => AUTO_TOPIC_MARKER_RE.test(line));
    otherDocs.push({
      file: rel,
      path: filePath,
      title: docTitleFromContent(filePath, content),
      autoManaged: Boolean(marker),
      entryCount: entryCountFromContent(content),
      lastModified: safeStatIso(filePath),
    });
  }
  return { topicDocs, otherDocs };
}

export function listLegacyTopicDocs(cortexPath: string, project: string): LegacyTopicDocInfo[] {
  const projectDir = projectDirPath(cortexPath, project);
  const referenceDir = safeProjectPath(cortexPath, project, "reference");
  if (!projectDir || !referenceDir || !fs.existsSync(referenceDir)) return [];
  const files = fs.readdirSync(referenceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(referenceDir, entry.name))
    .sort();
  return files.map((filePath) => {
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = parseLegacyTopicEntries(content, project);
    return {
      slug: path.basename(filePath, ".md"),
      file: relativeToProject(projectDir, filePath),
      path: filePath,
      title: docTitleFromContent(filePath, content),
      autoManaged: parsed && !("error" in parsed),
      entryCount: entryCountFromContent(content),
      lastModified: safeStatIso(filePath),
      eligible: !("error" in parsed),
      reason: "error" in parsed ? parsed.error : undefined,
    };
  });
}

function tokenizeSuggestionTerms(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  const terms = [...words];
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    if (!STOP_WORDS.has(words[i]) && !STOP_WORDS.has(words[i + 1])) terms.push(bigram);
  }
  return terms;
}

function collectSuggestionCorpus(cortexPath: string, project: string): string {
  const parts: string[] = [];
  for (const file of ["CLAUDE.md", "summary.md", "FINDINGS.md"]) {
    const filePath = safeProjectPath(cortexPath, project, file);
    if (!filePath || !fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf8");
    if (file === "FINDINGS.md") {
      const recentBullets = content.split("\n").filter((line) => line.startsWith("- ")).slice(-10).join("\n");
      parts.push(recentBullets);
      continue;
    }
    parts.push(content);
  }
  const generalDoc = topicReferencePath(cortexPath, project, "general");
  if (generalDoc && fs.existsSync(generalDoc)) parts.push(fs.readFileSync(generalDoc, "utf8"));
  for (const legacyDoc of listLegacyTopicDocs(cortexPath, project)) {
    if (!legacyDoc.eligible) continue;
    try { parts.push(fs.readFileSync(legacyDoc.path, "utf8")); } catch {}
  }
  return parts.join("\n");
}

export function suggestTopics(cortexPath: string, project: string, topics?: ProjectTopic[]): ProjectTopicSuggestion[] {
  const currentTopics = topics ?? readProjectTopics(cortexPath, project).topics;
  const pinnedTopics = readPinnedTopics(cortexPath, project);
  if (pinnedTopics.length > 0) {
    return pinnedTopics.slice(0, SUGGESTION_LIMIT).map((topic) => ({
      slug: topic.slug,
      label: topic.label,
      description: topic.description,
      keywords: [...topic.keywords],
      source: "pinned" as const,
      reason: "Pinned topic suggestion (manual override).",
      confidence: 1,
    }));
  }
  const taken = new Set<string>();
  const takenKeywords = new Set<string>();
  for (const topic of currentTopics) {
    taken.add(topic.slug);
    taken.add(topic.label.toLowerCase());
    for (const keyword of topic.keywords) takenKeywords.add(keyword);
  }

  const signal = buildTopicContentSignal(cortexPath, project);
  const corpus = `${signal.corpus}\n${collectSuggestionCorpus(cortexPath, project)}`;
  const corpusLower = corpus.toLowerCase();
  const keywordSignal = extractKeywords(corpus);
  const scoreMap = new Map<string, number>();
  for (const term of tokenizeSuggestionTerms(`${corpus}\n${keywordSignal}`)) {
    const normalized = normalizeKeyword(term);
    if (!normalized || normalized.length < 3) continue;
    if (taken.has(normalized) || takenKeywords.has(normalized)) continue;
    const current = scoreMap.get(normalized) ?? 0;
    scoreMap.set(normalized, current + 1);
  }

  const suggestions: ProjectTopicSuggestion[] = [];

  for (const builtin of getBuiltinTopics(cortexPath, project)) {
    if (builtin.slug === "general" || taken.has(builtin.slug)) continue;
    const score = builtin.keywords.reduce((count, keyword) => count + (corpusLower.includes(keyword) ? 1 : 0), 0);
    if (score <= 0) continue;
    suggestions.push({
      slug: builtin.slug,
      label: builtin.label,
      description: builtin.description,
      keywords: [...builtin.keywords.slice(0, 6)],
      source: "builtin",
      reason: "Matches repeated project language already present in this project.",
      confidence: confidenceFromScore(score),
    });
  }

  for (const [term, score] of [...scoreMap.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    if (suggestions.length >= SUGGESTION_LIMIT) break;
    if (score < 2) continue;
    const slug = normalizeTopicSlug(term);
    if (!slug || taken.has(slug) || takenKeywords.has(term)) continue;
    const keywords = Array.from(new Set(term.split(" ").concat(slug.split("-"))))
      .map((keyword) => normalizeKeyword(keyword))
      .filter((keyword) => keyword.length > 2)
      .slice(0, 6);
    if (keywords.length === 0) continue;
    suggestions.unshift({
      slug,
      label: titleCaseLabel(term),
      description: "Suggested from repeated domain language found in project context and archived findings.",
      keywords,
      source: "heuristic",
      reason: "Repeated project-specific language suggests this deserves its own topic.",
      confidence: confidenceFromScore(score),
    });
    taken.add(slug);
  }

  const deduped: ProjectTopicSuggestion[] = [];
  const seen = new Set<string>();
  for (const suggestion of suggestions) {
    if (seen.has(suggestion.slug)) continue;
    seen.add(suggestion.slug);
    deduped.push(suggestion);
    if (deduped.length >= SUGGESTION_LIMIT) break;
  }
  return deduped;
}

export const suggestProjectTopics = suggestTopics;

export function getProjectTopicsResponse(cortexPath: string, project: string): ProjectTopicsResponse {
  const { source, topics } = readProjectTopics(cortexPath, project);
  return {
    source,
    topics,
    suggestions: suggestTopics(cortexPath, project, topics),
    pinnedTopics: readPinnedTopics(cortexPath, project),
    legacyDocs: listLegacyTopicDocs(cortexPath, project),
    topicDocs: listProjectTopicDocs(cortexPath, project, topics),
  };
}

export function resolveReferenceContentPath(cortexPath: string, project: string, file: string): string | null {
  if (!isValidProjectName(project) || !file || file.includes("\0")) return null;
  if (!file.endsWith(".md")) return null;
  const filePath = safeProjectPath(cortexPath, project, file);
  if (!filePath) return null;
  const referenceRoot = safeProjectPath(cortexPath, project, "reference");
  if (!referenceRoot) return null;
  const normalizedRoot = referenceRoot + path.sep;
  if (filePath !== referenceRoot && !filePath.startsWith(normalizedRoot)) return null;
  return filePath;
}

export function readReferenceContent(cortexPath: string, project: string, file: string): { ok: true; content: string } | { ok: false; error: string } {
  const filePath = resolveReferenceContentPath(cortexPath, project, file);
  if (!filePath) return { ok: false, error: "Invalid project or reference file" };
  if (!fs.existsSync(filePath)) return { ok: false, error: `File not found: ${file}` };
  return { ok: true, content: fs.readFileSync(filePath, "utf8") };
}

export function reclassifyLegacyTopicDocs(cortexPath: string, project: string): ReclassifyTopicsResult {
  const { topics } = readProjectTopics(cortexPath, project);
  const referenceDir = safeProjectPath(cortexPath, project, "reference");
  if (!referenceDir || !fs.existsSync(referenceDir)) return { movedFiles: 0, movedEntries: 0, skipped: [] };
  const skipped: Array<{ file: string; reason: string }> = [];
  const archivedBullets = collectArchivedBulletsRecursively(path.join(referenceDir, "topics"));
  let movedFiles = 0;
  let movedEntries = 0;

  for (const legacyDoc of listLegacyTopicDocs(cortexPath, project)) {
    const result = readReferenceContent(cortexPath, project, legacyDoc.file);
    if (!result.ok) {
      skipped.push({ file: legacyDoc.file, reason: result.error });
      continue;
    }
    const parsed = parseLegacyTopicEntries(result.content, project);
    if ("error" in parsed) {
      skipped.push({ file: legacyDoc.file, reason: parsed.error });
      continue;
    }
    const grouped = new Map<string, ArchivedTopicEntry[]>();
    for (const entry of parsed.entries) {
      const normalized = normalizeBullet(entry.bullet);
      if (normalized && archivedBullets.has(normalized)) continue;
      const targetTopic = classifyTopicForText(entry.bullet, topics);
      const bucket = grouped.get(targetTopic.slug) ?? [];
      bucket.push(entry);
      grouped.set(targetTopic.slug, bucket);
      if (normalized) archivedBullets.add(normalized);
    }
    if (grouped.size === 0) {
      skipped.push({ file: legacyDoc.file, reason: "all entries already archived elsewhere" });
      continue;
    }
    try {
      for (const [slug, entries] of grouped) {
        const topic = topics.find((item) => item.slug === slug) ?? topics.find((item) => item.slug === "general")!;
        const targetPath = topicReferencePath(cortexPath, project, slug);
        if (!targetPath) throw new Error(`Invalid target topic path for "${slug}"`);
        appendArchivedEntriesToTopicDoc(targetPath, project, topic, entries);
        movedEntries += entries.length;
      }
      fs.unlinkSync(legacyDoc.path);
      movedFiles++;
    } catch (err: unknown) {
      skipped.push({ file: legacyDoc.file, reason: errorMessage(err) });
    }
  }

  return { movedFiles, movedEntries, skipped };
}
