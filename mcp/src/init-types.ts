/**
 * Shared types for init modules. Separated to avoid circular dependencies.
 */
import type { InstallMode } from "./shared.js";
import type { ProjectOwnershipMode } from "./project-config.js";
import type { ProactivityLevel } from "./proactivity.js";
import type { McpMode, WorkflowRiskSection, StorageLocationChoice } from "./init-walkthrough.js";
import type { InitProjectDomain, InferredInitScaffold } from "./init/setup.js";

export type SkillsScope = "global" | "project";

export interface InitOptions {
  mode?: InstallMode;
  machine?: string;
  profile?: string;
  mcp?: McpMode;
  hooks?: McpMode;
  projectOwnershipDefault?: ProjectOwnershipMode;
  findingsProactivity?: ProactivityLevel;
  taskProactivity?: ProactivityLevel;
  lowConfidenceThreshold?: number;
  riskySections?: WorkflowRiskSection[];
  taskMode?: "off" | "manual" | "suggest" | "auto";
  findingSensitivity?: "minimal" | "conservative" | "balanced" | "aggressive";
  skillsScope?: SkillsScope;
  applyStarterUpdate?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  // Built-in template names are directory-based under starter/templates/.
  // Keep string-compatible so custom package templates continue to work.
  template?: "python-project" | "monorepo" | "library" | "frontend" | string;
  /** Set by walkthrough to pass project name to init logic */
  _walkthroughProject?: string;
  /** Set by walkthrough for personalized GitHub next-steps output */
  _walkthroughGithub?: { username?: string; repo: string };
  /** Set by walkthrough to seed project docs/topics by domain */
  _walkthroughDomain?: InitProjectDomain;
  /** Set by walkthrough to seed adaptive project scaffold from current repo content */
  _walkthroughInferredScaffold?: InferredInitScaffold;
  /** Set by walkthrough when user enables auto-capture; triggers writing ~/.phren/.env */
  _walkthroughAutoCapture?: boolean;
  /** Set by walkthrough when user opts into local semantic search */
  _walkthroughSemanticSearch?: boolean;
  /** Set by walkthrough when user enables LLM semantic dedup */
  _walkthroughSemanticDedup?: boolean;
  /** Set by walkthrough when user enables LLM conflict detection */
  _walkthroughSemanticConflict?: boolean;
  /** Set by walkthrough when user provides a git clone URL for existing phren */
  _walkthroughCloneUrl?: string;
  /** Set by walkthrough when the user wants the current repo enrolled immediately */
  _walkthroughBootstrapCurrentProject?: boolean;
  /** Set by walkthrough for the ownership mode selected for the current repo */
  _walkthroughBootstrapOwnership?: ProjectOwnershipMode;
  /** Set by walkthrough to select where phren data is stored */
  _walkthroughStorageChoice?: StorageLocationChoice;
  /** Set by walkthrough to pass resolved storage path to init logic */
  _walkthroughStoragePath?: string;
  /** Set by walkthrough when project-local storage is chosen */
  _walkthroughStorageRepoRoot?: string;
}
