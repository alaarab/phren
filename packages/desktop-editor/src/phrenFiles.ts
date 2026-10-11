// The phren: scheme as a read-only VS Code file system, so VS Code's services
// (model resolution, breadcrumbs, extensions reading a document) can read the
// files the desktop editor opens. Each file is registered as the editor opens
// it, with a reader that goes through the Hook; saves stay with the editor's
// own compare-and-swap path.
import { RegisteredFileSystemProvider, RegisteredReadOnlyFile, registerCustomProvider } from "@codingame/monaco-vscode-files-service-override";
import * as monaco from "monaco-editor";

// Registered before VS Code's services start (registerCustomProvider requires it).
let provider: RegisteredFileSystemProvider | null = null;
const registered = new Set<string>();
let reader: ((path: string) => Promise<string>) | null = null;
const encoder = new TextEncoder();

export function installPhrenFiles(): void {
  provider = new RegisteredFileSystemProvider(true);
  registerCustomProvider("phren", provider);
}

/** The editor pane hands in a reader for its session (path → text). */
export function setPhrenReader(next: ((path: string) => Promise<string>) | null): void { reader = next; }

/** Make phren:/<path> readable by VS Code's services. Idempotent. */
export function registerPhrenFile(path: string): void {
  if (!provider || registered.has(path)) return;
  registered.add(path);
  const uri = monaco.Uri.parse(`phren:/${path}`);
  provider.registerFile(new RegisteredReadOnlyFile(uri as never, async () => {
    if (!reader) throw new Error("No session is open.");
    return encoder.encode(await reader(path));
  }, 0));
}
