import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { makeTempDir } from "./test-helpers.js";
import { migrateLegacyAgentInstructions, resolveAgentInstructionsPath } from "./agent-instructions.js";

describe("agent instructions migration", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  it("copies a legacy CLAUDE.md to AGENTS.md and retains the source", () => {
    const tmp = makeTempDir("phren-agents-migration-");
    cleanup = tmp.cleanup;
    fs.writeFileSync(path.join(tmp.path, "CLAUDE.md"), "# Legacy\n");

    expect(migrateLegacyAgentInstructions(tmp.path)).toBe(true);
    expect(fs.readFileSync(path.join(tmp.path, "AGENTS.md"), "utf8")).toBe("# Legacy\n");
    expect(fs.readFileSync(path.join(tmp.path, "CLAUDE.md"), "utf8")).toBe("# Legacy\n");
  });

  it("keeps AGENTS.md authoritative when both files exist", () => {
    const tmp = makeTempDir("phren-agents-precedence-");
    cleanup = tmp.cleanup;
    fs.writeFileSync(path.join(tmp.path, "AGENTS.md"), "# Canonical\n");
    fs.writeFileSync(path.join(tmp.path, "CLAUDE.md"), "# Legacy\n");

    expect(migrateLegacyAgentInstructions(tmp.path)).toBe(false);
    expect(resolveAgentInstructionsPath(tmp.path)).toBe(path.join(tmp.path, "AGENTS.md"));
    expect(fs.readFileSync(path.join(tmp.path, "AGENTS.md"), "utf8")).toBe("# Canonical\n");
    expect(fs.readFileSync(path.join(tmp.path, "CLAUDE.md"), "utf8")).toBe("# Legacy\n");
  });
});
