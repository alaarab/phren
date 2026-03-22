export { ACTION_KEYS, type ActionKey, type CapabilityEntry, type CapabilityManifest } from "./types.js";
export { cliManifest } from "../cli/cli.js";
export { mcpManifest } from "./mcp.js";
export { vscodeManifest } from "./vscode.js";
export { webUiManifest } from "./web-ui.js";

import { cliManifest } from "../cli/cli.js";
import { mcpManifest } from "./mcp.js";
import { vscodeManifest } from "./vscode.js";
import { webUiManifest } from "./web-ui.js";
import type { CapabilityManifest } from "./types.js";

export const ALL_MANIFESTS: CapabilityManifest[] = [
  cliManifest,
  mcpManifest,
  vscodeManifest,
  webUiManifest,
];
