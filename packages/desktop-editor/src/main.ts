// Phren desktop's editor host: VS Code's editor services (monaco-vscode-api)
// in editor-only mode, VS Code's default themes and grammars, and an extension
// host in a web worker, exposed to the plain-JS desktop UI as window.PhrenEditorHost.
import { initialize, LogLevel } from "@codingame/monaco-vscode-api";
import { registerExtension, ExtensionHostKind } from "@codingame/monaco-vscode-api/extensions";
import getConfigurationServiceOverride, { initUserConfiguration, updateUserConfiguration } from "@codingame/monaco-vscode-configuration-service-override";
import getExtensionServiceOverride from "@codingame/monaco-vscode-extensions-service-override";
import getFilesServiceOverride, { registerCustomProvider } from "@codingame/monaco-vscode-files-service-override";
import getKeybindingsServiceOverride from "@codingame/monaco-vscode-keybindings-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getLogServiceOverride from "@codingame/monaco-vscode-log-service-override";
import getModelServiceOverride from "@codingame/monaco-vscode-model-service-override";
import getRemoteAgentServiceOverride from "@codingame/monaco-vscode-remote-agent-service-override";
import getTextmateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import "@codingame/monaco-vscode-theme-defaults-default-extension";
import "@codingame/monaco-vscode-all-language-default-extensions";
import * as monaco from "monaco-editor";
import * as vscode from "vscode";
import { phrenThemeExtension } from "./theme.js";
import { installPhrenFiles, registerPhrenFile, setPhrenReader } from "./phrenFiles.js";
import getQuickAccessServiceOverride from "@codingame/monaco-vscode-quickaccess-service-override";
import { currentTheme, extensionsStatus, loadInstalledExtensions, reloadExtensions, savedTheme, setTheme, themes } from "./extensions.js";

import { Worker } from "./fakeWorker.js";

const workers: Record<string, Worker> = {
  editorWorkerService: new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url), { type: "module" }),
  extensionHostWorkerMain: new Worker(new URL("@codingame/monaco-vscode-api/workers/extensionHost.worker", import.meta.url), { type: "module" }),
  TextMateWorker: new Worker(new URL("@codingame/monaco-vscode-textmate-service-override/worker", import.meta.url), { type: "module" }),
};
(window as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorkerUrl: (_: string, label: string) => workers[label]?.url.toString(),
  getWorkerOptions: (_: string, label: string) => workers[label]?.options,
};

// The daemon's Node extension host (REH) for this computer. Fetched before the
// editor starts: it decides whether VS Code joins a remote authority and lets
// the REH load the Node extensions the web worker host cannot.
interface RehInfo {
  available: boolean;
  authority?: string;
  connectionToken?: string;
  version?: string;
  reason?: string;
}

async function fetchReh(): Promise<RehInfo> {
  try {
    const reply = await fetch("/api/reh", { cache: "no-store" });
    if (!reply.ok) return { available: false };
    return (await reply.json()) as RehInfo;
  } catch {
    return { available: false };
  }
}

const reh = await fetchReh();
const remote = reh.available && reh.authority ? { authority: reh.authority, version: reh.version } : null;

/** A repository-absolute path as a "vscode-remote://" URI, or null without a REH. */
function remoteUri(absolutePath: string): string | null {
  if (!remote || !absolutePath.startsWith("/") || absolutePath.includes("\0")) return null;
  return `vscode-remote://${remote.authority}${absolutePath}`;
}

const DEFAULT_SETTINGS = {
  "workbench.colorTheme": "Phren Charcoal",
  "editor.fontFamily": "JetBrains Mono, ui-monospace, Menlo, monospace",
  "editor.fontSize": 13,
  "editor.minimap.enabled": false,
  "editor.scrollBeyondLastLine": false,
  "editor.renderLineHighlight": "line",
  "editor.semanticHighlighting.enabled": true,
};

async function boot() {
  // A theme picked earlier wins over the default (an extension theme applies once it loads).
  await initUserConfiguration(JSON.stringify({ ...DEFAULT_SETTINGS, ...(savedTheme() ? { "workbench.colorTheme": savedTheme() } : {}) }));
  // Custom file systems must be registered before the services start.
  installPhrenFiles();
  await initialize({
    ...getLogServiceOverride(),
    ...getConfigurationServiceOverride(),
    ...getFilesServiceOverride(),
    ...getModelServiceOverride(),
    ...getKeybindingsServiceOverride(),
    ...getLanguagesServiceOverride(),
    ...getTextmateServiceOverride(),
    ...getThemeServiceOverride(),
    // Extension code runs in a frame on its own origin ({{uuid}}.localhost), so
    // it never shares the desktop's cookie and cannot call the Hook through it.
    ...getExtensionServiceOverride({ enableWorkerExtensionHost: true, iframeAlternateDomain: `${location.protocol}//{{uuid}}.localhost:${location.port}` }),
    ...getQuickAccessServiceOverride({ isKeybindingConfigurationVisible: () => false, shouldUseGlobalPicker: () => false }),
    // A reachable REH serves the Node extensions itself via scanRemoteExtensions.
    ...(reh.available ? getRemoteAgentServiceOverride({ scanRemoteExtensions: true }) : {}),
  }, undefined, {
    developmentOptions: { logLevel: LogLevel.Warning },
    ...(remote ? { remoteAuthority: remote.authority, connectionToken: reh.connectionToken } : {}),
  });
  await phrenThemeExtension();
  await loadInstalledExtensions(reh.available);
}

const ready = boot();

(window as unknown as Record<string, unknown>).PhrenEditorHost = {
  ready, monaco, vscode, registerExtension, ExtensionHostKind, registerCustomProvider, updateUserConfiguration,
  reloadExtensions, themes, setTheme, currentTheme, extensionsStatus, setPhrenReader, registerPhrenFile,
  remote, remoteUri,
};
