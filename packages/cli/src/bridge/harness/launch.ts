import { access, readFile } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicInPrivateDir, bridgeRoot, BridgeError } from "../protocol.js";
import { runnerPaths } from "./runner-client.js";
import { runnerConfigSchema, type RunnerConfig } from "./runner.js";

export const harnessBackend = z.string().regex(/^(claude-sdk|acp:[a-z][a-z0-9-]{0,31})$/);
/** Backends use installed executables named in owner configuration, never phone-supplied commands. */
export async function configuredHarness(kind: string, requested?: unknown): Promise<Pick<RunnerConfig, "backend" | "executable" | "args"> | undefined> {
  const backend = requested === undefined || requested === null ? kind === "claude" && process.env.PHREN_CLAUDE_SDK === "1" ? "claude-sdk" : undefined : harnessBackend.parse(requested);
  if (!backend) return undefined;
  if (backend === "claude-sdk") {
    if (kind !== "claude") throw new BridgeError(400, "Claude SDK requires the Claude harness.");
    const executable = process.env.PHREN_CLAUDE_EXECUTABLE ?? (process.env.PATH ?? "").split(path.delimiter).filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, "claude")).find(file => { try { return requireAccess(file); } catch { return false; } });
    if (!executable || !path.isAbsolute(executable)) throw new BridgeError(409, "The installed Claude binary was not found by absolute path; no SDK launch was attempted.");
    await access(executable, constants.X_OK); return { backend, executable, args: [] };
  }
  if (kind !== "phren") throw new BridgeError(400, "Configured ACP workers use the Phren runner; their actual provider is reported separately.");
  const file = process.env.PHREN_ACP_CONFIG ?? path.join(bridgeRoot(), "acp.json");
  let config: Record<string, unknown>; try { config = JSON.parse(await readFile(file, "utf8")); } catch { throw new BridgeError(409, "ACP command configuration is missing."); }
  const command = z.object({ executable: z.string().min(1).max(4096).refine(path.isAbsolute), args: z.array(z.string().max(4096)).max(100).default([]) }).strict().parse(config[backend.slice(4)]);
  await access(command.executable, constants.X_OK); return { backend, ...command };
}
function requireAccess(file: string) { accessSync(file, constants.X_OK); return true; }

export function runnerCommand(configFile: string): { file: string; args: string[] } {
  const entry = process.argv[1];
  if (!entry || !path.isAbsolute(entry)) throw new Error("Structured launches require the absolute running Hook/CLI entry.");
  const standalone = /(?:bridge-hook\.mjs|hook-main\.js)$/.test(entry);
  const source = configFile.endsWith(".claude.json") ? "claude" : configFile.endsWith(".codex.json") ? "codex" : "phren";
  return { file: process.execPath, args: [entry, ...(standalone ? [] : ["bridge"]), "harness-runner", "--source=" + source, configFile] };
}
export async function prepareHarnessCommand(config: RunnerConfig) {
  const value = runnerConfigSchema.parse(config);
  const suffix = value.backend === "claude-sdk" ? ".claude.json" : value.backend === "codex-stdio" ? ".codex.json" : ".phren.json";
  const file = value.pane ? runnerPaths(value.pane.server, value.pane.pane).entry + suffix
    : path.join(bridgeRoot(), "harness", `${process.pid}-${Date.now()}${suffix}`);
  await atomicInPrivateDir(file, value); return runnerCommand(file);
}
