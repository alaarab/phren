import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";
import { ROOT } from "./package-metadata.js";

type AgentCliModule = {
  runAgentCli?: (args: string[]) => Promise<void> | void;
};

async function tryImport(candidate: string): Promise<AgentCliModule | null> {
  try {
    return await import(candidate) as AgentCliModule;
  } catch {
    return null;
  }
}

async function loadBundledAgentModule(): Promise<AgentCliModule | null> {
  const workspaceCandidates = [
    path.join(ROOT, "..", "agent", "src", "index.ts"),
    path.join(ROOT, "..", "agent", "dist", "index.js"),
  ];

  for (const candidate of workspaceCandidates) {
    if (!fs.existsSync(candidate)) continue;
    const mod = await tryImport(pathToFileURL(candidate).href);
    if (mod?.runAgentCli) return mod;
  }

  const packageModule = await tryImport("@phren/agent");
  if (packageModule?.runAgentCli) return packageModule;

  return null;
}

export async function runBundledAgentCli(args: string[]): Promise<void> {
  const mod = await loadBundledAgentModule();
  if (mod?.runAgentCli) {
    await mod.runAgentCli(args);
    return;
  }

  try {
    execFileSync("phren-agent", args, { stdio: "inherit" });
    return;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "status" in err) {
      const status = (err as { status?: number }).status;
      process.exit(status ?? 1);
    }
    throw new Error(
      "Integrated agent runtime is unavailable. Install or build @phren/agent, or use `phren manage ...` for memory operations."
    );
  }
}
