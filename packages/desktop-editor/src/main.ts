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
import getTextmateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import "@codingame/monaco-vscode-theme-defaults-default-extension";
import "@codingame/monaco-vscode-all-language-default-extensions";
import * as monaco from "monaco-editor";
import * as vscode from "vscode";
import { phrenThemeExtension } from "./theme.js";
import { installPhrenFiles, registerPhrenFile, setPhrenReader } from "./phrenFiles.js";
import getQuickAccessServiceOverride from "@codingame/monaco-vscode-quickaccess-service-override";
import { currentTheme, loadInstalledExtensions, reloadExtensions, savedTheme, setTheme, themes } from "./extensions.js";

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
  }, undefined, { developmentOptions: { logLevel: LogLevel.Warning } });
  await phrenThemeExtension();
  await loadInstalledExtensions();
}

const ready = boot();

(window as unknown as Record<string, unknown>).PhrenEditorHost = {
  ready, monaco, vscode, registerExtension, ExtensionHostKind, registerCustomProvider, updateUserConfiguration,
  reloadExtensions, themes, setTheme, currentTheme, setPhrenReader, registerPhrenFile,
};
