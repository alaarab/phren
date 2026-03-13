import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "./test-helpers.js";
import { getBuiltinTopics, pinProjectTopicSuggestion, readProjectTopics, suggestProjectTopics, suggestTopics, writeProjectTopics } from "./project-topics.js";

let tmpDir = "";
let tmpCleanup: (() => void) | undefined;

function makeProject(root: string, name: string, files: Record<string, string>): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const fullPath = path.join(dir, file);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

beforeEach(() => {
  ({ path: tmpDir, cleanup: tmpCleanup } = makeTempDir("cortex-project-topics-"));
});

afterEach(() => {
  tmpCleanup?.();
  tmpCleanup = undefined;
});

describe("project topic config", () => {
  it("reads topic-config entries using BuiltinTopic shape", () => {
    makeProject(tmpDir, "music", {
      "topic-config.json": JSON.stringify({
        version: 1,
        domain: "music",
        topics: [
          { name: "Composition", description: "Songwriting decisions.", keywords: ["composition", "melody"] },
        ],
      }, null, 2) + "\n",
    });

    const result = readProjectTopics(tmpDir, "music");
    expect(result.source).toBe("custom");
    expect(result.topics.map((topic) => topic.slug)).toEqual(["composition", "general"]);
  });

  it("falls back to built-in starter topics when config is missing", () => {
    makeProject(tmpDir, "demo", { "FINDINGS.md": "# demo FINDINGS\n" });
    const result = readProjectTopics(tmpDir, "demo");
    expect(result.source).toBe("default");
    expect(result.topics.some((topic) => topic.slug === "general")).toBe(true);
    expect(result.topics.some((topic) => topic.slug !== "general")).toBe(true);
  });

  it("rejects invalid topic definitions on write", () => {
    makeProject(tmpDir, "demo", { "FINDINGS.md": "# demo FINDINGS\n" });
    const invalidSlug = writeProjectTopics(tmpDir, "demo", [
      { slug: "!!!", label: "Bad", description: "", keywords: [] },
      { slug: "general", label: "General", description: "", keywords: [] },
    ]);
    expect(invalidSlug.ok).toBe(false);

    const duplicate = writeProjectTopics(tmpDir, "demo", [
      { slug: "rendering", label: "Rendering", description: "", keywords: ["shader"] },
      { slug: "rendering", label: "Rendering 2", description: "", keywords: ["frame"] },
      { slug: "general", label: "General", description: "", keywords: [] },
    ]);
    expect(duplicate.ok).toBe(false);

    const duplicateKeyword = writeProjectTopics(tmpDir, "demo", [
      { slug: "rendering", label: "Rendering", description: "", keywords: ["shader"] },
      { slug: "gameplay", label: "Gameplay", description: "", keywords: ["shader", "combat"] },
      { slug: "general", label: "General", description: "", keywords: [] },
    ]);
    expect(duplicateKeyword.ok).toBe(false);
  });

  it("reads custom project topics as the classification source of truth", () => {
    makeProject(tmpDir, "game", {
      "FINDINGS.md": [
        "# game FINDINGS",
        "",
        "## 2026-03-01",
        "",
        "- Shader compilation hitch on first frame",
        "- Combat pause state desync",
      ].join("\n"),
      "summary.md": "A game project focused on rendering and combat systems.",
    });
    const saved = writeProjectTopics(tmpDir, "game", [
      { slug: "rendering", label: "Rendering", description: "Graphics and frames", keywords: ["shader", "frame", "render"] },
      { slug: "gameplay", label: "Gameplay", description: "Combat and gameplay state", keywords: ["combat", "gameplay", "pause", "state"] },
      { slug: "general", label: "General", description: "Fallback", keywords: [] },
    ]);
    expect(saved.ok).toBe(true);

    const result = readProjectTopics(tmpDir, "game");
    expect(result.source).toBe("custom");
    expect(result.topics.map((topic) => topic.slug)).toEqual(["rendering", "gameplay", "general"]);
  });

  it("produces deterministic topic suggestions from project language", () => {
    makeProject(tmpDir, "game", {
      "CLAUDE.md": "Rendering, shaders, frame timing, and combat gameplay all matter in this project.",
      "summary.md": "A game project with shader pipelines and combat systems.",
      "FINDINGS.md": [
        "# game FINDINGS",
        "",
        "## 2026-03-01",
        "",
        "- Shader compilation hitch on first frame",
        "- Combat gameplay state resets after pause",
      ].join("\n"),
    });
    const suggestions = suggestProjectTopics(tmpDir, "game", [
      { slug: "general", label: "General", description: "Fallback", keywords: [] },
    ]);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some((topic) => typeof topic.confidence === "number")).toBe(true);
    expect(suggestions.some((topic) => (topic.keywords || []).some((keyword) => keyword === "shader" || keyword === "combat"))).toBe(true);
  });

  it("uses the managed general topic doc as suggestion input", () => {
    makeProject(tmpDir, "game", {
      "reference/topics/general.md": [
        "# game - General",
        "",
        "<!-- cortex:auto-topic slug=general -->",
        "",
        "## Archived 2026-03-01",
        "",
        "- Navmesh baking fails after terrain streaming",
        "- Navmesh rebuild hitches on large levels",
      ].join("\n"),
    });
    const suggestions = suggestProjectTopics(tmpDir, "game", [
      { slug: "general", label: "General", description: "Fallback", keywords: [] },
    ]);
    expect(suggestions.some((topic) => topic.slug === "navmesh" || topic.keywords.includes("navmesh"))).toBe(true);
  });

  it("uses adaptive defaults when project content exists", () => {
    makeProject(tmpDir, "demo", {
      "CLAUDE.md": "Auth, token lifecycle, and oauth flow; auth checks around jwt refresh.",
      "FINDINGS.md": "# demo FINDINGS\n\n- OAuth token refresh loop under auth middleware\n- JWT token expires before refresh\n",
      "reference/notes.md": "# Notes\n\nAuth middleware and token validation behavior.",
    });
    const topics = getBuiltinTopics(tmpDir, "demo");
    expect(topics.some((topic) => topic.slug === "auth")).toBe(true);
    expect(topics.some((topic) => topic.slug === "general")).toBe(true);
  });

  it("falls back to starter defaults when no content exists", () => {
    makeProject(tmpDir, "empty", {});
    const topics = getBuiltinTopics(tmpDir, "empty");
    expect(topics.some((topic) => topic.slug === "frontend")).toBe(true);
    expect(topics.some((topic) => topic.slug === "general")).toBe(true);
  });

  it("lets pinned topic suggestions override adaptive suggestions", () => {
    makeProject(tmpDir, "music", {
      "CLAUDE.md": "This project talks about stems and arrangement.",
      "FINDINGS.md": "# music FINDINGS\n\n- Stem export breaks for arrangement revisions\n",
    });
    const pinResult = pinProjectTopicSuggestion(tmpDir, "music", {
      slug: "arrangement",
      label: "Arrangement",
      description: "Pinned override",
      keywords: ["arrangement", "stems"],
    });
    expect(pinResult.ok).toBe(true);
    const suggestions = suggestTopics(tmpDir, "music", [
      { slug: "general", label: "General", description: "Fallback", keywords: [] },
    ]);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].source).toBe("pinned");
    expect(suggestions[0].slug).toBe("arrangement");
    expect(suggestions[0].confidence).toBe(1);
  });
});
