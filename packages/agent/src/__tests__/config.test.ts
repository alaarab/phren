import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../config.js";

describe("parseArgs", () => {
  it("parses bare task string", () => {
    const args = parseArgs(["fix", "the", "bug"]);
    expect(args.task).toBe("fix the bug");
  });

  it("defaults to auto-confirm permissions", () => {
    expect(parseArgs([]).permissions).toBe("auto-confirm");
  });

  it("defaults maxTurns to 50", () => {
    expect(parseArgs([]).maxTurns).toBe(50);
  });

  it("defaults budget to null", () => {
    expect(parseArgs([]).budget).toBeNull();
  });

  it("defaults boolean flags to false", () => {
    const args = parseArgs([]);
    expect(args.plan).toBe(false);
    expect(args.dryRun).toBe(false);
    expect(args.verbose).toBe(false);
    expect(args.interactive).toBe(false);
    expect(args.help).toBe(false);
    expect(args.version).toBe(false);
  });

  // ── Flag parsing ────────────────────────────────────────────────────

  it("parses --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("parses -h", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("parses --version", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
  });

  it("parses -v", () => {
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  it("parses --dry-run", () => {
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
  });

  it("parses --verbose", () => {
    expect(parseArgs(["--verbose"]).verbose).toBe(true);
  });

  it("parses --interactive", () => {
    expect(parseArgs(["--interactive"]).interactive).toBe(true);
  });

  it("parses -i", () => {
    expect(parseArgs(["-i"]).interactive).toBe(true);
  });

  it("parses --plan", () => {
    expect(parseArgs(["--plan"]).plan).toBe(true);
  });

  // ── Value flags ─────────────────────────────────────────────────────

  it("parses --provider", () => {
    expect(parseArgs(["--provider", "anthropic"]).provider).toBe("anthropic");
  });

  it("parses --model", () => {
    expect(parseArgs(["--model", "gpt-4o"]).model).toBe("gpt-4o");
  });

  it("parses --project", () => {
    expect(parseArgs(["--project", "phren"]).project).toBe("phren");
  });

  it("parses --max-turns", () => {
    expect(parseArgs(["--max-turns", "25"]).maxTurns).toBe(25);
  });

  it("parses --budget", () => {
    expect(parseArgs(["--budget", "5.50"]).budget).toBeCloseTo(5.5);
  });

  it("parses --permissions suggest", () => {
    expect(parseArgs(["--permissions", "suggest"]).permissions).toBe("suggest");
  });

  it("parses --permissions full-auto", () => {
    expect(parseArgs(["--permissions", "full-auto"]).permissions).toBe("full-auto");
  });

  it("ignores invalid permission mode", () => {
    expect(parseArgs(["--permissions", "invalid"]).permissions).toBe("auto-confirm");
  });

  // ── Mixed flags and positional ──────────────────────────────────────

  it("parses mixed flags and task", () => {
    const args = parseArgs(["--verbose", "--provider", "codex", "add", "validation"]);
    expect(args.verbose).toBe(true);
    expect(args.provider).toBe("codex");
    expect(args.task).toBe("add validation");
  });

  it("handles invalid maxTurns gracefully", () => {
    expect(parseArgs(["--max-turns", "abc"]).maxTurns).toBe(50);
  });

  it("handles invalid budget gracefully", () => {
    expect(parseArgs(["--budget", "abc"]).budget).toBeNull();
  });

  // ── Environment variable fallback ───────────────────────────────────

  describe("env vars", () => {
    const origModel = process.env.PHREN_AGENT_MODEL;

    afterEach(() => {
      if (origModel === undefined) delete process.env.PHREN_AGENT_MODEL;
      else process.env.PHREN_AGENT_MODEL = origModel;
    });

    it("falls back to PHREN_AGENT_MODEL when --model not provided", () => {
      process.env.PHREN_AGENT_MODEL = "claude-sonnet-4";
      expect(parseArgs([]).model).toBe("claude-sonnet-4");
    });

    it("prefers --model over PHREN_AGENT_MODEL", () => {
      process.env.PHREN_AGENT_MODEL = "from-env";
      expect(parseArgs(["--model", "from-flag"]).model).toBe("from-flag");
    });
  });
});
