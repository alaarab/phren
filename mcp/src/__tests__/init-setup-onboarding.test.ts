import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { makeTempDir } from "../test-helpers.js";
import {
  bootstrapFromExisting,
  detectProjectDir,
  ensureProjectScaffold,
  ensureGitignoreEntry,
  inferInitScaffoldFromRepo,
  isProjectTracked,
  upsertProjectEnvVar,
} from "../init/init-setup.js";

describe("init setup onboarding helpers", () => {
  let tmp: { path: string; cleanup: () => void };
  let phrenPath: string;
  let projectRoot: string;

  beforeEach(() => {
    tmp = makeTempDir("init-setup-onboarding-");
    phrenPath = path.join(tmp.path, ".phren");
    projectRoot = path.join(tmp.path, "app");
    fs.mkdirSync(path.join(phrenPath, "profiles"), { recursive: true });
    fs.writeFileSync(path.join(phrenPath, "machines.yaml"), `${os.hostname()}: work\n`);
    fs.writeFileSync(path.join(phrenPath, "profiles", "personal.yaml"), "name: personal\nprojects:\n  - app-api\n");
    fs.writeFileSync(path.join(phrenPath, "profiles", "work.yaml"), "name: work\nprojects:\n  - global\n");
    fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "CLAUDE.md"), "# app\n\nApp project.\n");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("detects the repo root from nested directories", () => {
    const nestedDir = path.join(projectRoot, "packages", "web");
    fs.mkdirSync(nestedDir, { recursive: true });
    expect(detectProjectDir(nestedDir, phrenPath)).toBe(projectRoot);
  });

  it("detects an AGENTS.md-rooted project before git is initialized", () => {
    const codexRoot = path.join(tmp.path, "codex-app");
    const nestedDir = path.join(codexRoot, "src", "feature");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(codexRoot, "AGENTS.md"), "# codex-app\n");

    expect(detectProjectDir(nestedDir, phrenPath)).toBe(codexRoot);
  });

  it("checks tracking against the active profile when provided", () => {
    expect(isProjectTracked(phrenPath, "app", "work")).toBe(false);
    expect(isProjectTracked(phrenPath, "app-api", "personal")).toBe(true);
  });

  it("adds the exact project to the selected profile without substring collisions", () => {
    const projectResult = bootstrapFromExisting(phrenPath, projectRoot, "work");
    expect(projectResult.project).toBe("app");

    const personal = fs.readFileSync(path.join(phrenPath, "profiles", "personal.yaml"), "utf8");
    const work = fs.readFileSync(path.join(phrenPath, "profiles", "work.yaml"), "utf8");

    expect(personal).toContain("app-api");
    expect(personal).not.toMatch(/\n\s*-\s+app\n/);
    expect(work).toMatch(/\n\s*-\s+app\n/);
  });

  it("falls back to the machine-mapped profile when none is provided", () => {
    const projectResult = bootstrapFromExisting(phrenPath, projectRoot);

    expect(projectResult.project).toBe("app");
    expect(fs.readFileSync(path.join(phrenPath, "profiles", "work.yaml"), "utf8")).toMatch(/\n\s*-\s+app\n/);
    expect(fs.readFileSync(path.join(phrenPath, "profiles", "personal.yaml"), "utf8")).not.toMatch(/\n\s*-\s+app\n/);
  });

  it("does not overwrite an existing summary when re-adding a project", () => {
    bootstrapFromExisting(phrenPath, projectRoot, "work");
    const summaryPath = path.join(phrenPath, "app", "summary.md");
    fs.writeFileSync(summaryPath, "# app\n\nCurated summary.\n");

    bootstrapFromExisting(phrenPath, projectRoot, "work");

    expect(fs.readFileSync(summaryPath, "utf8")).toContain("Curated summary.");
    expect(fs.readFileSync(summaryPath, "utf8")).not.toContain("Bootstrapped from");
  });

  it("does not overwrite an existing CLAUDE.md when re-adding a project", () => {
    bootstrapFromExisting(phrenPath, projectRoot, "work");
    const claudePath = path.join(phrenPath, "app", "CLAUDE.md");
    fs.writeFileSync(claudePath, "# app\n\nCurated phren CLAUDE.\n");

    bootstrapFromExisting(phrenPath, projectRoot, "work");

    expect(fs.readFileSync(claudePath, "utf8")).toContain("Curated phren CLAUDE.");
    expect(fs.readFileSync(claudePath, "utf8")).not.toContain("App project.");
  });

  it("supports repo-managed ownership without creating a competing phren CLAUDE.md", () => {
    const result = bootstrapFromExisting(phrenPath, projectRoot, { profile: "work", ownership: "repo-managed" });

    expect(result.project).toBe("app");
    expect(result.ownership).toBe("repo-managed");
    expect(result.claudePath).toBe(path.join(projectRoot, "CLAUDE.md"));
    expect(fs.existsSync(path.join(phrenPath, "app", "CLAUDE.md"))).toBe(false);
    expect(fs.readFileSync(path.join(phrenPath, "app", "phren.project.yaml"), "utf8")).toContain("ownership: repo-managed");
  });

  it("writes domain topic-config entries in BuiltinTopic shape", () => {
    const projectDir = path.join(phrenPath, "mixlab");
    ensureProjectScaffold(projectDir, "mixlab", "music");

    const config = JSON.parse(fs.readFileSync(path.join(projectDir, "topic-config.json"), "utf8"));
    expect(config.version).toBe(1);
    expect(config.domain).toBe("music");
    expect(Array.isArray(config.topics)).toBe(true);
    expect(config.topics.length).toBeGreaterThan(0);
    expect(config.topics[0]).toHaveProperty("name");
    expect(config.topics[0]).toHaveProperty("description");
    expect(config.topics[0]).toHaveProperty("keywords");
    expect(config.topics[0]).not.toHaveProperty("slug");
    expect(config.topics[0]).not.toHaveProperty("label");
  });

  it("defaults topic-config domain to software when no domain is provided", () => {
    const projectDir = path.join(phrenPath, "default-domain");
    ensureProjectScaffold(projectDir, "default-domain");

    const config = JSON.parse(fs.readFileSync(path.join(projectDir, "topic-config.json"), "utf8"));
    expect(config.domain).toBe("software");
    expect(config.topics.some((topic: { name?: string }) => topic.name === "General")).toBe(true);
  });

  it("infers domain/topics from repo content before falling back", () => {
    fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({
      name: "app",
      description: "Semantic memory retrieval with embeddings and vector search",
      keywords: ["memory", "embeddings", "retrieval", "vector", "search"],
      scripts: { build: "tsc -p .", test: "vitest" },
    }, null, 2));
    fs.writeFileSync(path.join(projectRoot, "README.md"), "# app\n\nembeddings embeddings embeddings\nvector search retrieval\n");
    fs.writeFileSync(path.join(projectRoot, "tsconfig.json"), "{\n  \"compilerOptions\": {}\n}\n");
    fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "docs", "architecture.md"), "retrieval pipeline and embeddings index\n");

    const inferred = inferInitScaffoldFromRepo(projectRoot);
    expect(inferred).not.toBeNull();
    expect(inferred?.domain).toBe("software");
    expect(inferred?.topics.some((topic) => topic.name === "Embeddings")).toBe(true);
    expect(inferred?.referenceHints).toContain("README.md");
  });

  it("uses inferred scaffold for topic-config and CLAUDE scaffold", () => {
    const projectDir = path.join(phrenPath, "adaptive");
    ensureProjectScaffold(projectDir, "adaptive", "software", {
      domain: "software",
      topics: [
        { name: "API", description: "API contracts", keywords: ["api", "endpoint"] },
        { name: "Embeddings", description: "Vector retrieval behavior", keywords: ["embedding", "vector"] },
        { name: "General", description: "Fallback", keywords: [] },
      ],
      referenceHints: ["README.md", "docs/"],
      commandHints: ["npm run build", "npm run test"],
      confidence: 0.9,
      reason: "test scaffold",
    });

    const config = JSON.parse(fs.readFileSync(path.join(projectDir, "topic-config.json"), "utf8"));
    expect(config.topics.some((topic: { name: string }) => topic.name === "Embeddings")).toBe(true);
    const claude = fs.readFileSync(path.join(projectDir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("## Reference Structure");
    expect(claude).toContain("README.md");
  });

  it("adds .phren/ to repo .gitignore once", () => {
    expect(ensureGitignoreEntry(projectRoot, ".phren/")).toBe(true);
    expect(ensureGitignoreEntry(projectRoot, ".phren/")).toBe(false);
    const gitignore = fs.readFileSync(path.join(projectRoot, ".gitignore"), "utf8");
    expect(gitignore).toContain(".phren/");
    expect((gitignore.match(/\.phren\//g) || []).length).toBe(1);
  });

  it("upserts PHREN_PATH in project .env", () => {
    const target = path.join(projectRoot, ".phren");
    expect(upsertProjectEnvVar(projectRoot, "PHREN_PATH", target)).toBe(true);
    expect(fs.readFileSync(path.join(projectRoot, ".env"), "utf8")).toContain(`PHREN_PATH=${target}`);

    const next = path.join(projectRoot, ".phren-custom");
    expect(upsertProjectEnvVar(projectRoot, "PHREN_PATH", next)).toBe(true);
    const envFile = fs.readFileSync(path.join(projectRoot, ".env"), "utf8");
    expect(envFile).toContain(`PHREN_PATH=${next}`);
    expect(envFile).not.toMatch(new RegExp(`^PHREN_PATH=${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  });
});
