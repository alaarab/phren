// VS Code extensions for the desktop: install from Open VSX, list, enable, remove.
// Installed at <config>/phren/desktop-extensions/<publisher>.<name>/ as the
// unzipped extension/ folder plus a phren.json record.
import { createHash } from "node:crypto";
import { installIntoReh, rehExtensionsDir, uninstallFromReh } from "./reh.js";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { unzipSync } from "fflate";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\.[A-Za-z0-9][A-Za-z0-9-]*$/;
const OPEN_VSX = "https://open-vsx.org/api";
const MAX_VSIX = 60 * 1024 * 1024;
const MAX_FILES = 5000;

export type ExtensionKind = "web" | "declarative" | "node";

export interface ExtensionManifest {
  name?: string;
  displayName?: string;
  description?: string;
  publisher?: string;
  version?: string;
  icon?: string;
  browser?: string;
  main?: string;
  [key: string]: unknown;
}

export interface InstalledExtension {
  id: string;
  version: string;
  displayName: string;
  description: string;
  publisher: string;
  enabled: boolean;
  kind: ExtensionKind;
  icon?: string;
  manifest: ExtensionManifest;
  files: string[];
}

export interface ExtensionSearchResult {
  namespace: string;
  name: string;
  version: string;
  displayName: string;
  description: string;
  downloadCount: number;
  icon?: string;
}

/** Errors carry the HTTP status the route should answer with. */
export class ExtensionError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ExtensionError";
    this.status = status;
  }
}

interface ExtensionRecord {
  id: string;
  version: string;
  installedAt: string;
  enabled: boolean;
  source: "open-vsx";
}

interface OpenVsxSearchItem {
  namespace?: string;
  name?: string;
  version?: string;
  displayName?: string;
  description?: string;
  downloadCount?: number;
  icon?: string;
  files?: { icon?: string };
}

/** Where installed extensions live: $PHREN_DESKTOP_EXTENSIONS, else
 * $XDG_CONFIG_HOME/phren/desktop-extensions, else ~/.config/phren/desktop-extensions. */
export function extensionsRoot(): string {
  if (process.env.PHREN_DESKTOP_EXTENSIONS) return process.env.PHREN_DESKTOP_EXTENSIONS;
  const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(config, "phren", "desktop-extensions");
}

/** A browser entry runs in the web worker host; a Node-only main needs a Node host. */
export function classify(manifest: ExtensionManifest): ExtensionKind {
  if (typeof manifest.browser === "string" && manifest.browser.length > 0) return "web";
  if (typeof manifest.main === "string" && manifest.main.length > 0) return "node";
  return "declarative";
}

function extensionDir(id: string): string {
  if (!ID_RE.test(id)) throw new ExtensionError(400, "Invalid extension id.");
  return join(extensionsRoot(), id);
}

async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

// Every file under `base`, posix-relative, capped so a huge package cannot flood the UI.
async function listFiles(base: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(relative(base, full).split(sep).join("/"));
    }
  };
  await walk(base);
  return out;
}

async function readExtension(id: string): Promise<InstalledExtension | null> {
  const dir = join(extensionsRoot(), id);
  const record = (await readJsonFile(join(dir, "phren.json"))) as ExtensionRecord | undefined;
  if (!record || record.source !== "open-vsx") return null;
  const manifest = (await readJsonFile(join(dir, "extension", "package.json"))) as ExtensionManifest | undefined;
  if (!manifest || typeof manifest !== "object") return null;
  const icon = typeof manifest.icon === "string" && manifest.icon.length > 0
    ? `/extension-files/${id}/${manifest.icon}`
    : undefined;
  return {
    id,
    version: record.version || manifest.version || "",
    displayName: manifest.displayName || manifest.name || id,
    description: manifest.description ?? "",
    publisher: manifest.publisher || id.split(".")[0],
    enabled: record.enabled,
    kind: classify(manifest),
    icon,
    manifest,
    files: await listFiles(join(dir, "extension")),
  };
}

export async function listExtensions(): Promise<InstalledExtension[]> {
  const root = extensionsRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: InstalledExtension[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
    const ext = await readExtension(entry.name);
    if (ext) out.push(ext);
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
}

export async function searchOpenVsx(q: string, fetchImpl: typeof fetch = fetch): Promise<ExtensionSearchResult[]> {
  const body = await fetchJson(
    `${OPEN_VSX}/-/search?query=${encodeURIComponent(q)}&size=30`,
    fetchImpl,
    "Open VSX search",
  ) as { extensions?: OpenVsxSearchItem[] };
  const out: ExtensionSearchResult[] = [];
  for (const item of body.extensions ?? []) {
    if (!item.namespace || !item.name) continue;
    const icon = item.files?.icon ?? item.icon;
    out.push({
      namespace: item.namespace,
      name: item.name,
      version: item.version ?? "",
      displayName: item.displayName || item.name,
      description: item.description ?? "",
      downloadCount: item.downloadCount ?? 0,
      icon,
    });
  }
  return out;
}

export async function installFromOpenVsx(
  namespace: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InstalledExtension> {
  if (!NAME_RE.test(namespace) || !NAME_RE.test(name)) {
    throw new ExtensionError(400, "Invalid namespace or name.");
  }
  const id = `${namespace}.${name}`;
  const meta = await fetchJson(`${OPEN_VSX}/${namespace}/${name}/latest`, fetchImpl, "Open VSX") as {
    version?: string;
    files?: { download?: string; sha256?: string };
  };
  const download = meta.files?.download;
  const sha256Url = meta.files?.sha256;
  if (!download || !sha256Url) throw new ExtensionError(502, "Open VSX returned no download for this extension.");
  // files.sha256 is a link to a text file whose first token is the hex digest.
  let expected: string;
  try {
    const shaRes = await fetchImpl(sha256Url);
    if (!shaRes.ok) throw new Error(String(shaRes.status));
    const match = /\b[0-9a-fA-F]{64}\b/.exec(await shaRes.text());
    if (!match) throw new Error("no digest");
    expected = match[0];
  } catch {
    throw new ExtensionError(502, "Open VSX did not provide this extension's checksum.");
  }

  let res: Response;
  try {
    res = await fetchImpl(download);
  } catch {
    throw new ExtensionError(502, "The extension download failed.");
  }
  if (!res.ok) throw new ExtensionError(502, `The extension download failed (${res.status}).`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_VSIX) throw new ExtensionError(502, "The extension is larger than 60 MB.");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected.toLowerCase()) {
    throw new ExtensionError(502, "The extension's checksum does not match Open VSX.");
  }

  const files = extractExtensionFolder(bytes);
  if (!files.has("package.json")) throw new ExtensionError(502, "The extension has no package.json.");

  await writeExtension(id, meta.version || "0.0.0", files);
  // Keep the verified package beside it: a Node-only extension's code runs in
  // the Node extension host, which installs from the VSIX.
  await writeFile(join(extensionDir(id), "package.vsix"), bytes, { mode: 0o600 });
  const ext = await readExtension(id);
  if (!ext) throw new ExtensionError(502, "The extension could not be installed.");
  if (ext.kind === "node") await installIntoReh(join(extensionDir(id), "package.vsix")).catch(() => false);
  return ext;
}

/** Put every installed Node-only extension into the Node extension host
 * (those installed before it was built). Returns the ids it added. */
export async function syncNodeExtensions(): Promise<string[]> {
  const present = existsSync(rehExtensionsDir()) ? (await readdir(rehExtensionsDir())).map(n => n.toLowerCase()) : [];
  const added: string[] = [];
  for (const ext of await listExtensions()) {
    if (ext.kind !== "node" || !ext.enabled) continue;
    if (present.some(n => n.startsWith(`${ext.id.toLowerCase()}-`))) continue;
    const vsix = join(extensionDir(ext.id), "package.vsix");
    if (!existsSync(vsix)) continue;
    if (await installIntoReh(vsix).catch(() => false)) added.push(ext.id);
  }
  return added;
}

export async function uninstall(id: string): Promise<void> {
  const dir = extensionDir(id);
  if (!existsSync(dir)) throw new ExtensionError(404, `Unknown extension ${id}.`);
  await uninstallFromReh(id);
  await rm(dir, { recursive: true, force: true });
}

export async function setEnabled(id: string, enabled: boolean): Promise<InstalledExtension> {
  const dir = extensionDir(id);
  const record = (await readJsonFile(join(dir, "phren.json"))) as ExtensionRecord | undefined;
  if (!record || record.source !== "open-vsx") throw new ExtensionError(404, `Unknown extension ${id}.`);
  record.enabled = enabled;
  await writeFile(join(dir, "phren.json"), JSON.stringify(record, null, 2));
  const ext = await readExtension(id);
  if (!ext) throw new ExtensionError(404, `Unknown extension ${id}.`);
  return ext;
}

/** Absolute path of a file under an extension's extension/ folder, or null when
 * the id is bad or the path escapes that folder. */
export function extensionFilePath(id: string, rel: string): string | null {
  if (!ID_RE.test(id)) return null;
  const base = join(extensionsRoot(), id, "extension");
  const full = resolve(base, rel);
  return full === base || full.startsWith(base + sep) ? full : null;
}

async function fetchJson(url: string, fetchImpl: typeof fetch, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch {
    throw new ExtensionError(502, `${what} is unreachable.`);
  }
  if (!res.ok) throw new ExtensionError(502, `${what} failed (${res.status}).`);
  try {
    return await res.json();
  } catch {
    throw new ExtensionError(502, `${what} returned invalid JSON.`);
  }
}

function unsafeRel(rel: string): boolean {
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return true;
  return rel.split("/").some((part) => part === "..");
}

/** Unzip a VSIX and keep only extension/** as rel path → bytes. fflate drops
 * unix modes, so a zip symlink lands here as an ordinary file (never a link). */
function extractExtensionFolder(vsix: Uint8Array): Map<string, Uint8Array> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(vsix);
  } catch {
    throw new ExtensionError(502, "The VSIX could not be read.");
  }
  const out = new Map<string, Uint8Array>();
  for (const [raw, data] of Object.entries(entries)) {
    const path = raw.replace(/\\/g, "/");
    if (!path.startsWith("extension/")) continue;
    const rel = path.slice("extension/".length);
    if (!rel) continue;
    if (unsafeRel(rel)) throw new ExtensionError(502, "The VSIX contains an unsafe path.");
    out.set(rel, data);
  }
  return out;
}

// Write fully to a temp sibling, swap the old version aside, then rename into
// place so a half-written extension is never live.
async function writeExtension(id: string, version: string, files: Map<string, Uint8Array>): Promise<void> {
  const root = extensionsRoot();
  await mkdir(root, { recursive: true });
  const target = join(root, id);
  const previous = (await readJsonFile(join(target, "phren.json"))) as ExtensionRecord | undefined;
  const tmp = await mkdtemp(join(root, ".install-"));
  try {
    for (const [rel, data] of files) {
      const dest = join(tmp, "extension", rel);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, data);
    }
    const record: ExtensionRecord = {
      id,
      version,
      installedAt: new Date().toISOString(),
      enabled: previous?.enabled ?? true,
      source: "open-vsx",
    };
    await writeFile(join(tmp, "phren.json"), JSON.stringify(record, null, 2));

    const backup = existsSync(target) ? join(root, `.old-${id}-${Date.now()}`) : null;
    if (backup) await rename(target, backup);
    await rename(tmp, target);
    if (backup) await rm(backup, { recursive: true, force: true });
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}
