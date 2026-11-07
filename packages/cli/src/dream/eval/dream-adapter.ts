// Connects the eval harness to the dreaming engine. The harness scripts the
// model with a `runHelper`-shaped runner; the engine takes a DreamRunner.
import { helperFor, runHelper, type HelperChoice } from "../../bridge/helper.js";
import { dream, type DreamRunner } from "../run.js";

export type { DreamChange, DreamEvidence, DreamChangeset } from "../types.js";

/** A `runHelper`-shaped runner (bridge/helper.ts). */
export type HelperRunner = typeof runHelper;

export interface EvalDreamOptions {
  dryRun?: boolean;
  mode?: "propose" | "apply";
  now?: Date;
  force?: boolean;
  /** Omitted for a real-model run: the engine then uses the project's helper. */
  runner?: HelperRunner;
}

export type DreamFn = (project: string, opts: EvalDreamOptions) => Promise<unknown>;

export function asDreamRunner(runner: HelperRunner): DreamRunner {
  return async (request, project, phrenPath) => {
    // A scripted runner needs no real helper account; a real one does.
    let choice: HelperChoice;
    try { choice = helperFor(phrenPath, project); }
    catch { choice = { project, account: "default", model: request.model || "scripted", home: { id: "default", dir: process.env.HOME ?? "", configFile: "", isDefault: true } } as HelperChoice; }
    if (request.model) choice.model = request.model;
    const result = await runner(choice, { prompt: request.prompt, cwd: request.cwd, timeoutSeconds: request.timeoutSeconds, signal: request.signal });
    return { ok: result.ok, output: result.output, model: result.model, durationMs: result.durationMs };
  };
}

export const defaultDream: DreamFn = (project, { runner, ...rest }) =>
  dream(project, { ...rest, ...(runner ? { runner: asDreamRunner(runner) } : {}) });
