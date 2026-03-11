import { describe, expect, it } from "vitest";
import * as path from "path";
import {
  hookConfigPaths,
  probeVsCodeConfig,
  resolveCodexMcpConfig,
  vscodeMcpCandidates,
} from "../provider-adapters.js";

describe("provider adapter path resolution", () => {
  it("normalizes Windows USERPROFILE paths into WSL-style VS Code candidates", () => {
    const env = {
      HOME: "/home/tester",
      USERPROFILE: "C:\\Users\\Tester",
      USERNAME: "Tester",
    } as NodeJS.ProcessEnv;

    const candidates = vscodeMcpCandidates(env);
    expect(candidates).toContain("/mnt/c/Users/Tester/AppData/Roaming/Code/User");
  });

  it("prefers the normalized USERPROFILE path when VS Code is detected without an existing config", () => {
    const env = {
      HOME: "/home/tester",
      USERPROFILE: "C:\\Users\\Tester",
      USERNAME: "Tester",
    } as NodeJS.ProcessEnv;

    const result = probeVsCodeConfig(() => true, env);
    expect(result.installed).toBe(true);
    expect(result.targetDir).toBe("/mnt/c/Users/Tester/AppData/Roaming/Code/User");
  });

  it("keeps Codex hook config rooted in cortexPath even when HOME points elsewhere", () => {
    const cortexPath = "/tmpcortex-store";
    const env = {
      HOME: "/Users/tester",
      USERPROFILE: "C:\\Users\\Tester",
    } as NodeJS.ProcessEnv;

    const hookPaths = hookConfigPaths(cortexPath);
    expect(hookPaths.codex).toBe(path.join(cortexPath, "codex.json"));

    const codex = resolveCodexMcpConfig(cortexPath, () => false, env);
    expect(codex.jsonCandidates.at(-1)).toBe(path.join(cortexPath, "codex.json"));
    expect(codex.tomlPath).toBe("/Users/tester/.codex/config.toml");
  });
});
