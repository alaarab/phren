// Installed VS Code extensions, from the desktop daemon's store, registered
// with VS Code's extension service. Web extensions run in the worker extension
// host; Node-only ones contribute their themes, grammars and snippets but not
// their code (no Node extension host yet).
import { getService, IWorkbenchThemeService } from "@codingame/monaco-vscode-api";
import { ExtensionHostKind, registerExtension } from "@codingame/monaco-vscode-api/extensions";
import { updateUserConfiguration } from "@codingame/monaco-vscode-configuration-service-override";

interface InstalledExtension {
  id: string; version: string; enabled: boolean; kind: "web" | "declarative" | "node";
  manifest: Record<string, unknown>; files: string[];
}

const registered = new Map<string, { dispose(): Promise<void> }>();

/** Register every enabled installed extension; returns the ids it loaded. */
export async function loadInstalledExtensions(): Promise<string[]> {
  let list: InstalledExtension[] = [];
  try {
    const reply = await fetch("/api/extensions", { cache: "no-store" });
    if (reply.ok) list = ((await reply.json()) as { extensions: InstalledExtension[] }).extensions ?? [];
  } catch { /* the daemon has no extension store yet */ }
  const loaded: string[] = [];
  for (const ext of list) {
    if (!ext.enabled || registered.has(ext.id)) continue;
    // A Node-only extension keeps its declarative parts; its code cannot run here.
    const manifest = { ...ext.manifest } as Record<string, unknown>;
    if (ext.kind === "node") { delete manifest.main; delete manifest.activationEvents; }
    try {
      const result = registerExtension(manifest as never, ExtensionHostKind.LocalWebWorker, { system: false });
      for (const file of ext.files) {
        // Absolute: the extension host runs in a sandboxed frame where a relative
        // URL would not resolve to the daemon.
        const url = new URL(`/extension-files/${encodeURIComponent(ext.id)}/${file.split("/").map(encodeURIComponent).join("/")}`, location.href);
        result.registerFileUrl(file, url.href);
      }
      registered.set(ext.id, result);
      await result.whenReady().catch(() => {});
      loaded.push(ext.id);
    } catch (error) {
      console.warn(`Extension ${ext.id} could not be loaded:`, error);
    }
  }
  return loaded;
}

/** Bring the registered set in line with the store: drop removed or disabled
 * extensions, add new ones. True when it all applied without a reload. */
export async function reloadExtensions(): Promise<boolean> {
  let wanted = new Set<string>();
  try {
    const reply = await fetch("/api/extensions", { cache: "no-store" });
    const list = ((await reply.json()) as { extensions: InstalledExtension[] }).extensions ?? [];
    wanted = new Set(list.filter(e => e.enabled).map(e => e.id));
  } catch { return false; }
  let clean = true;
  for (const [id, handle] of registered) {
    if (wanted.has(id)) continue;
    try { await handle.dispose(); } catch { clean = false; }
    registered.delete(id);
  }
  await loadInstalledExtensions();
  return clean;
}

/** Every colour theme VS Code knows: built-in, Phren's, and installed extensions'. */
export async function themes(): Promise<Array<{ id: string; label: string }>> {
  const service = await getService(IWorkbenchThemeService);
  const all = await service.getColorThemes();
  return all.map(t => ({ id: t.settingsId ?? t.label, label: t.label }));
}

const THEME_KEY = "phren.desktop.colorTheme";

/** The theme the owner picked last, kept in this browser profile. */
export function savedTheme(): string | null {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

export async function setTheme(id: string): Promise<void> {
  try { localStorage.setItem(THEME_KEY, id); } catch { /* private window: this session only */ }
  await updateUserConfiguration(JSON.stringify({ "workbench.colorTheme": id }));
}

export async function currentTheme(): Promise<string> {
  const service = await getService(IWorkbenchThemeService);
  const theme = service.getColorTheme();
  return theme.settingsId ?? theme.label;
}
