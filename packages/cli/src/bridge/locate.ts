import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { BridgeError, type Json } from "./protocol.js";
import { herdrRoot } from "./herdr.js";
import { phrenStoreRoot } from "./transcripts.js";

/**
 * Where a project lives on this computer, for the phone's "Open on a
 * computer". The store's phren.project.yaml only knows the folder the project
 * was added from — on whichever machine that was — so the answer comes from
 * what this machine has actually seen: the Hook's activity journal (every
 * folder an agent session ran in, newest first), Herdr's saved workspaces,
 * phren's registered path, then the usual project roots. Only folders that
 * exist here are offered.
 */
export interface LocatedFolder { directory: string; source: "activity" | "herdr" | "phren" | "search"; lastSeen?: string }

const PROJECT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SEARCH_ROOTS = ["", "Sites", "Projects", "projects", "Code", "code", "dev", "src", "repos", "workspace"];

export async function locateProject(project: string, activity: Json[], env: NodeJS.ProcessEnv = process.env): Promise<LocatedFolder[]> {
  if (!PROJECT_NAME.test(project) || project.length > 100) throw new BridgeError(400, "Invalid project name.");
  const found: LocatedFolder[] = [];
  const seen = new Set<string>();
  const offer = async (directory: string, source: LocatedFolder["source"], lastSeen?: string) => {
    let dir = path.resolve(directory);
    try {
      if (!(await stat(dir)).isDirectory()) return;
      // On a case-insensitive disk ~/projects and ~/Projects are one folder;
      // the real path (native, so it carries the on-disk case) dedupes them.
      dir = realpathSync.native(dir);
    } catch { return; /* not on this computer */ }
    if (seen.has(dir)) return;
    seen.add(dir);
    found.push({ directory: dir, source, ...(lastSeen ? { lastSeen } : {}) });
  };
  const namesProject = (directory: string) => directory.split("/").includes(project);

  // 1. Folders an agent session ran in, newest first — the strongest signal
  // that this is the folder the person means.
  for (const event of [...activity].reverse()) {
    const directory = typeof event.directory === "string" ? event.directory : undefined;
    if (directory && path.isAbsolute(directory) && namesProject(directory)) {
      // Trim to the project segment so a session started in a subfolder
      // still opens the project itself.
      const parts = directory.split("/");
      await offer(parts.slice(0, parts.lastIndexOf(project) + 1).join("/"), "activity", typeof event.at === "string" ? event.at : undefined);
    }
  }
  // 2. Workspaces Herdr has saved.
  try {
    const session = JSON.parse(await readFile(path.join(herdrRoot(), "session.json"), "utf8"));
    for (const match of JSON.stringify(session).matchAll(/"cwd":\s*"((?:\\.|[^"\\])*)"/g)) {
      const directory = JSON.parse(`"${match[1]}"`) as string;
      if (path.isAbsolute(directory) && namesProject(directory)) {
        const parts = directory.split("/");
        await offer(parts.slice(0, parts.lastIndexOf(project) + 1).join("/"), "herdr");
      }
    }
  } catch { /* no saved session */ }
  // 3. phren's own registration, when it points at this machine.
  try {
    const config = await readFile(path.join(phrenStoreRoot(env), project, "phren.project.yaml"), "utf8");
    const match = /^sourcePath:\s*(.+)$/m.exec(config);
    if (match) await offer(match[1].trim().replace(/^['"]|['"]$/g, ""), "phren");
  } catch { /* unregistered */ }
  // 4. The roots phren's locator searches.
  const home = homedir();
  for (const root of [...(env.PROJECTS_DIR ? [env.PROJECTS_DIR] : []), ...SEARCH_ROOTS.map(r => path.join(home, r))]) {
    await offer(path.join(root, project), "search");
  }
  return found.slice(0, 8);
}
