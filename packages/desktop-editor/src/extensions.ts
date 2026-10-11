// Installed VS Code extensions, from the desktop daemon's store, registered
// with VS Code's extension service. Web extensions run in the worker extension
// host; Node-only ones contribute their themes, grammars and snippets but not
// their code, unless a Node extension host (REH) is up to run them.
import { getService, IExtensionService, IWorkbenchThemeService } from "@codingame/monaco-vscode-api";
import { ExtensionHostKind, registerExtension } from "@codingame/monaco-vscode-api/extensions";
import { updateUserConfiguration } from "@codingame/monaco-vscode-configuration-service-override";

interface InstalledExtension {
  id: string; version: string; enabled: boolean; kind: "web" | "declarative" | "node";
  manifest: Record<string, unknown>; files: string[];
}

const registered = new Map<string, { dispose(): Promise<void> }>();
// Set by the first load; reloadExtensions reuses it to keep the same policy.
let hasRemoteHost = false;

/** Register every enabled installed extension; returns the ids it loaded. With a
 * Node host up, Node extensions are left to the REH's own scan. */
export async function loadInstalledExtensions(remoteActive: boolean): Promise<string[]> {
  hasRemoteHost = remoteActive;
  let list: InstalledExtension[] = [];
  try {
    const reply = await fetch("/api/extensions", { cache: "no-store" });
    if (reply.ok) list = ((await reply.json()) as { extensions: InstalledExtension[] }).extensions ?? [];
  } catch { /* the daemon has no extension store yet */ }
  const loaded: string[] = [];
  for (const ext of list) {
    if (!ext.enabled || registered.has(ext.id)) continue;
    // The REH scans and runs Node extensions itself.
    if (hasRemoteHost && ext.kind === "node") continue;
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
  await loadInstalledExtensions(hasRemoteHost);
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

/** What each loaded extension is doing: where it runs and whether it started. */
export async function extensionsStatus(): Promise<Array<{ id: string; host: string; activated: boolean; error?: string }>> {
  const service = await getService(IExtensionService);
  const status = service.getExtensionsStatus();
  return service.extensions.map(ext => {
    const id = ext.identifier.value;
    const entry = status[id];
    const messages = entry?.messages?.map(m => m.message).filter(Boolean) ?? [];
    return { id, host: ext.extensionLocation.scheme, activated: !!entry?.activationTimes, ...(messages.length ? { error: messages.join("; ").slice(0, 300) } : {}) };
  });
}
