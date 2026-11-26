import { runPromptPipeline } from "../pipeline.js";
import type { RecallRunner } from "./index.js";

export const pipelineRunner: RecallRunner = (c, { phrenPath, db }) => runPromptPipeline({
  prompt: c.prompt,
  phrenPath,
  db,
  detectedProject: c.project,
  gitCtx: null,
  hotTopics: [],
});
