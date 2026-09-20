import type { McpProfile } from "../mcp/profile.js";

export interface ModuleTool {
  name: string;
  profiles: readonly McpProfile[];
}

export interface ModuleAgentHook {
  agents: readonly string[];
  events: readonly string[];
  handler: string;
}

export interface ModuleRoute {
  method: "GET" | "POST" | "WS";
  path: string;
}

/** Declarations only: loading a manifest must not install or start its module. */
export interface ModuleManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  defaultEnabled: boolean;
  requires: readonly string[];
  tools: readonly ModuleTool[];
  cliCommands: readonly string[];
  agentHooks: readonly ModuleAgentHook[];
  hookRoutes: readonly ModuleRoute[];
  capabilities: readonly string[];
  storeFiles: readonly string[];
  localFiles: readonly string[];
  phoneScreens: readonly { screen: string; capability: string }[];
  skills: readonly string[];
}

export interface ModulesConfig {
  version: 1;
  enabled?: Record<string, boolean>;
  profiles?: Record<string, { enabled?: Record<string, boolean> }>;
}
