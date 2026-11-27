import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import { hostname } from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { CORE_SCHEMA, load } from "js-yaml";
import {
  METADATA_REGEX, normalizeFindingText, parseAllContradictions, parseContradiction, parseCreatedDate,
  parseSupersedesRef, parseSupersession,
} from "../content/metadata.js";
import { parseFindingLifecycle } from "../finding/lifecycle.js";
import { iterateProjectFindings, type ProjectFinding } from "../finding/locate.js";
import { resolveRepoRootForPath } from "../git-worktree.js";
import { isRecord } from "../phren-core.js";
import { atomicWriteText, getProjectDirs, tryUnlink } from "../phren-paths.js";
import { escapeRegex, extractFragmentNames, normalizeWikilinkTarget } from "../shared/fragment-graph.js";
import { readStoreFragmentGraph } from "../shared/index.js";
import { getStoreProjectDirs, resolveAllStores } from "../store-registry.js";
import { parseStoreQualified } from "../store-routing.js";

const MANIFEST = ".phren-vault.json";
const GENERATED = "---\nphren: generated\n";
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const NOTE_FILE = /^(?:finding|fragment|project)-[a-z0-9_-]{1,200}\.md$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LOCK_KIND = "phren-vault-export";
const FINDING_TAG = /^\[([a-z][a-z0-9_-]*)\](?:\s+|$)/i;
const REVERSE_RELATION = { supersedes: "superseded_by", superseded_by: "supersedes", contradicts: "contradicts" } as const;
type Relation = keyof typeof REVERSE_RELATION;

interface Note {
  file: string;
  title: string;
}

interface VaultFinding extends Note {
  source: ProjectFinding;
  normalized: string;
  lifecycle: ReturnType<typeof parseFindingLifecycle>;
  relations: Set<string>;
  fragments: Set<VaultFragment>;
}

interface VaultProject extends Note {
  name: string;
  dir: string;
  store: ReturnType<typeof resolveAllStores>[number];
  findings: VaultFinding[];
  fragments: Set<VaultFragment>;
}

interface VaultFragment extends Note {
  types: Set<string>;
  projects: Set<VaultProject>;
  findings: Set<VaultFinding>;
  mention: RegExp;
}

function realDestination(target: string): string {
  if (fs.lstatSync(target, { throwIfNoEntry: false })) return fs.realpathSync.native(target);
  const parent = path.dirname(target);
  return parent === target ? target : path.join(realDestination(parent), path.basename(target));
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..";
}

function sourceCheckout(start: string): string | undefined {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.lstatSync(path.join(dir, ".git"), { throwIfNoEntry: false })) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function slug(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 72).replace(/^-+|-+$/g, "");
  return clean && clean === value ? clean : `${clean || "note"}--${digest(value).slice(0, 12)}`;
}

function wikilink(note: Note, heading?: string): string {
  const label = note.title.replace(/[\[\]|\\\r\n]/g, " ").trim();
  return `[[${note.file.slice(0, -3)}${heading ? `#${heading}` : ""}${label ? `|${label}` : ""}]]`;
}

function noteList(title: string, notes: Iterable<Note>): string {
  const links = Array.from(notes, note => wikilink(note)).sort();
  return links.length ? `\n## ${title}\n\n${links.map(link => `- ${link}`).join("\n")}\n` : "";
}

function markdown(properties: Record<string, string | string[] | null | undefined>, body: string): string {
  const fields = Object.entries(properties).filter(([, value]) => value !== undefined);
  return `${GENERATED}${fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n${body.trimEnd()}\n`;
}

function codeSpan(value: string): string {
  const fence = "`".repeat(Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length)) + 1);
  return `${fence} ${value.replace(/[\r\n]/g, " ")} ${fence}`;
}

function normalizeReference(raw: string): string {
  return normalizeFindingText(raw).replace(FINDING_TAG, "").replace(/"/g, "'");
}

function findingIndex(findings: VaultFinding[]) {
  const byFid = new Map<string, VaultFinding[]>();
  const byText = new Map<string, VaultFinding[]>();
  for (const finding of findings) {
    const fid = finding.source.fid?.toLowerCase();
    for (const [key, index] of [[fid, byFid], [finding.normalized, byText]] as const) {
      if (!key) continue;
      const bucket = index.get(key) ?? [];
      bucket.push(finding);
      index.set(key, bucket);
    }
  }
  const texts = [...byText.keys()].sort();
  return (ref: string, source: VaultFinding): VaultFinding | undefined => {
    const fid = /^fid:([a-z0-9]{8})$/i.exec(ref.trim())?.[1].toLowerCase();
    const text = fid ? fid : normalizeReference(ref);
    if (!text) return undefined;
    const exact = (fid ? byFid : byText).get(text);
    if (exact && (exact.length > 1 || exact[0] !== source)) {
      const includesSource = exact.length <= 2 && exact.includes(source);
      return exact.length - Number(includesSource) === 1 ? exact.find(finding => finding !== source) : undefined;
    }
    if (fid) return undefined;

    let lo = 0;
    let hi = texts.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (texts[mid] < text) lo = mid + 1;
      else hi = mid;
    }
    let match: VaultFinding | undefined;
    for (let i = lo; texts[i]?.startsWith(text); i++) for (const finding of byText.get(texts[i])!) {
      if (finding === source) continue;
      if (match) return undefined;
      match = finding;
    }
    return match;
  };
}

function linkRelations(projects: VaultProject[]): void {
  const byProject = new Map(projects.map(project => [project, findingIndex(project.findings)]));
  const projectsByName = new Map<string, VaultProject[]>();
  for (const project of projects) {
    const group = projectsByName.get(project.name) ?? [];
    group.push(project);
    projectsByName.set(project.name, group);
  }
  const byName = new Map<string, ReturnType<typeof findingIndex>>();
  for (const [name, matches] of projectsByName) {
    byName.set(name, matches.length === 1 ? byProject.get(matches[0])! : findingIndex(matches.flatMap(project => project.findings)));
  }
  for (const project of projects) for (const finding of project.findings) {
    const { line, citation } = finding.source;
    const { status, status_ref } = finding.lifecycle;
    const legacy = [...line.matchAll(METADATA_REGEX.conflictsWithAll)];
    const contradictions = parseAllContradictions(line);
    const refs: Array<[Relation, string | null | undefined, string?]> = [
      ["supersedes", parseSupersedesRef(line) ?? citation?.supersedes],
      ["superseded_by", parseSupersession(line)?.ref ?? (status === "superseded" ? status_ref : undefined)],
      ...contradictions.map((ref): [Relation, string] => ["contradicts", ref]),
      ...legacy.map(([comment, ref]): [Relation, string, string?] => ["contradicts", ref, comment.match(/\(from project:\s*([^)]+)\)/)?.[1].trim()]),
    ];
    if (!contradictions.length && !legacy.length) {
      refs.push(["contradicts", parseContradiction(line) ?? (status === "contradicted" ? status_ref : undefined)]);
    }
    for (const [relation, ref, otherProject] of refs) {
      if (!ref?.trim()) continue;
      const other = (otherProject ? byName.get(otherProject) : byProject.get(project))?.(ref, finding);
      if (other) {
        finding.relations.add(`- ${relation} ${wikilink(other)}`);
        other.relations.add(`- ${REVERSE_RELATION[relation]} ${wikilink(finding)}`);
      } else {
        finding.relations.add(`- ${relation} ${codeSpan(ref)}`);
      }
    }
  }
}

async function linkFragments(phrenPath: string, projects: VaultProject[]): Promise<Map<string, VaultFragment>> {
  const fragments = new Map<string, VaultFragment>();
  if (!projects.length) return fragments;
  const dirsByStore = new Map<string, string[]>();
  for (const { dir, store } of projects) {
    const dirs = dirsByStore.get(store.path) ?? [];
    dirs.push(dir);
    dirsByStore.set(store.path, dirs);
  }
  const byDir = new Map(projects.map(project => [project.dir, project]));
  const findingsByPath = new Map<string, Array<{ finding: VaultFinding; annotations: Set<string> }>>();
  for (const project of projects) for (const finding of project.findings) {
    const source = finding.source.file;
    const entries = findingsByPath.get(source) ?? [];
    const comments = finding.source.line.match(/<!--\s*(?:fragment|entity):.*?-->/gi) ?? [];
    entries.push({ finding, annotations: new Set(comments.flatMap(extractFragmentNames)) });
    findingsByPath.set(source, entries);
  }

  for (const { projectDir, sourcePath, name, type } of await readStoreFragmentGraph(phrenPath, dirsByStore)) {
    const project = byDir.get(projectDir)!;
    let fragment = fragments.get(name);
    if (!fragment) {
      fragment = {
        file: "", title: name, types: new Set(), projects: new Set(), findings: new Set(),
        mention: new RegExp(`(?<![\\w-])${escapeRegex(name)}(?![\\w-])`, "i"),
      };
      fragments.set(name, fragment);
    }
    fragment.types.add(type);
    project.fragments.add(fragment);
    fragment.projects.add(project);
    for (const { finding, annotations } of findingsByPath.get(sourcePath) ?? []) {
      if (annotations.has(name.toLowerCase()) || fragment.mention.test(finding.source.text)) {
        finding.fragments.add(fragment);
        fragment.findings.add(finding);
      }
    }
  }
  return fragments;
}

function sourceWikilinks(notes: Note[], documents: ReadonlyMap<string, string>, fragments: ReadonlyMap<string, Note>) {
  const files = new Map(notes.map(note => [note.file.slice(0, -3), note]));
  const titles = new Map<string, Note | null>();
  const headings = new Map<string, Map<string, string>>();
  for (const note of notes) {
    const title = note.title.trim().toLowerCase();
    titles.set(title, titles.has(title) ? null : note);
    const body = documents.get(note.file)!.replace(FRONTMATTER, "");
    const names = Array.from(body.matchAll(/^ {0,3}#{1,6}[ \t]+([^\r\n]+)$/gm), ([, heading]) => heading.replace(/[ \t]+#+[ \t]*$/, "").trim());
    headings.set(note.file, new Map(names.map(name => [name.toLowerCase(), name])));
  }
  return (text: string, file: string) => text.replace(/(`+).*?\1|(?<!\\)(!?)\[\[([^\]\r\n]+)\]\]/g, (original, code, embed, inner: string) => {
    if (code) return original;
    const [target, label] = inner.split("|", 2);
    const anchor = target.indexOf("#");
    const key = (anchor < 0 ? target : target.slice(0, anchor)).trim().toLowerCase();
    const direct = files.get(key.replace(/\.md$/, "")) ?? titles.get(key);
    const note = !key && anchor === 0 ? files.get(file.slice(0, -3))
      : direct === undefined ? fragments.get(normalizeWikilinkTarget(key)) : direct;
    const heading = note && anchor >= 0 ? headings.get(note.file)?.get(target.slice(anchor + 1).trim().toLowerCase()) : undefined;
    if (!note || (anchor >= 0 && !heading)) return original.replace(/[\[\]]/g, "\\$&");
    return `${embed}${wikilink({ ...note, title: label ?? heading ?? note.title }, heading)}`;
  });
}

function renderFinding(project: VaultProject, finding: VaultFinding): string {
  const { fid, line, status, text, citation } = finding.source;
  const relations = finding.relations.size ? `\n## Finding links\n\n${[...finding.relations].sort().join("\n")}\n` : "";
  const cite = citation ? Object.entries({
    Repository: citation.remote ?? citation.repo, File: citation.file, Line: citation.line,
    Commit: citation.commit, Symbol: citation.symbol,
  }).filter(([, value]) => value !== undefined).map(([key, value]) => `- ${key} ${codeSpan(String(value))}`) : [];
  return markdown({
    kind: "finding", fid: fid ?? null, project: project.title, type: text.match(FINDING_TAG)?.[1].toLowerCase() ?? null, status,
    created: parseCreatedDate(line) ?? citation?.created_at.slice(0, 10), status_updated: finding.lifecycle.status_updated,
  }, `${text}\n\nProject ${wikilink(project)}\n${noteList("Fragments", finding.fragments)}${relations}${cite.length ? `\n## Citation\n\n${cite.join("\n")}\n` : ""}`);
}

function regularFile(file: string): Buffer | undefined {
  if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) return undefined;
  try { return fs.readFileSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function generated(content: Buffer): boolean {
  const yaml = FRONTMATTER.exec(content.toString("utf8"))?.[1];
  if (!yaml) return false;
  try {
    const fields = load(yaml, { schema: CORE_SCHEMA });
    return isRecord(fields) && fields.phren === "generated";
  } catch { return false; }
}

function previousNotes(dir: string, manifest: string, names: string[]): Map<string, string> {
  const stat = fs.lstatSync(manifest, { throwIfNoEntry: false });
  const recovery = "Restore .phren-vault.json from a backup or choose an empty vault directory.";
  if (!stat) {
    for (const name of names) {
      if (!NOTE_FILE.test(name.toLowerCase())) continue;
      const content = regularFile(path.join(dir, name));
      if (content && generated(content)) throw new Error(`Vault manifest is missing but generated notes are present. ${recovery}`);
    }
    return new Map();
  }
  const invalid = () => new Error(`Invalid vault manifest ${manifest}. ${recovery}`);
  if (!stat.isFile()) throw invalid();
  let data: unknown;
  try { data = JSON.parse(fs.readFileSync(manifest, "utf8")); }
  catch { throw invalid(); }
  const hashMap = (value: unknown): value is Record<string, string> => isRecord(value)
    && Object.entries(value).every(([file, hash]) => NOTE_FILE.test(file) && typeof hash === "string" && SHA256.test(hash));
  if (!isRecord(data) || data.version !== 1 || !hashMap(data.files)
    || (data.pending !== undefined && !hashMap(data.pending))) throw invalid();
  const owned = new Map<string, string>();
  for (const file of new Set([...Object.keys(data.files), ...Object.keys(data.pending ?? {})])) {
    const content = regularFile(path.join(dir, file));
    if (!content) continue;
    const hash = digest(content);
    if ((hash === data.files[file] || hash === data.pending?.[file]) && generated(content)) owned.set(file, hash);
  }
  return owned;
}

function publishExclusive(file: string, content: string): void {
  const temp = path.join(path.dirname(file), `.phren-vault-${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    try { fs.writeFileSync(fd, content); }
    finally { fs.closeSync(fd); }
    fs.linkSync(temp, file);
  } finally { tryUnlink(temp); }
}

function readVaultLock(file: string) {
  const conflict = () => new Error(`Vault lock filename conflict at ${file}. Move the conflicting entry to use this vault.`);
  let raw: string | undefined;
  let record: unknown;
  try {
    raw = regularFile(file)?.toString("utf8");
    record = JSON.parse(raw ?? "");
  } catch { throw conflict(); }
  if (!raw || !isRecord(record) || record.kind !== LOCK_KIND || record.version !== 1 || typeof record.pid !== "number"
    || !Number.isInteger(record.pid) || record.pid < 1 || typeof record.nonce !== "string"
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(record.nonce)
    || typeof record.host !== "string" || !record.host || typeof record.createdAt !== "string"
    || !Number.isFinite(Date.parse(record.createdAt))) throw conflict();
  return { raw, pid: record.pid, host: record.host, createdAt: record.createdAt };
}

function lockVault(file: string): () => void {
  const owner = JSON.stringify({ kind: LOCK_KIND, version: 1, pid: process.pid, host: hostname(), createdAt: new Date().toISOString(), nonce: randomUUID() });
  try { publishExclusive(file, owner); }
  catch (error) {
    if (!fs.lstatSync(file, { throwIfNoEntry: false })) throw error;
    const { pid, host, createdAt } = readVaultLock(file);
    throw new Error(`Vault export is locked by PID ${pid} on ${host} since ${createdAt}. After confirming it has stopped, rerun with --force-unlock.`);
  }
  return () => { if (regularFile(file)?.toString("utf8") === owner) tryUnlink(file); };
}

function exportStores(phrenPath: string) {
  return resolveAllStores(phrenPath, { migrateAttachments: false, requireComplete: true });
}

function destinationGuard(phrenPath: string, target: string) {
  const destination = path.resolve(target);
  const checkouts = new Set([sourceCheckout(process.cwd()), sourceCheckout(path.dirname(fileURLToPath(import.meta.url)))].flatMap(root =>
    root ? [root, resolveRepoRootForPath(root)] : []));
  return (registered: ReturnType<typeof exportStores>): string => {
    const resolved = realDestination(destination);
    for (const storePath of new Set([phrenPath, ...registered.map(store => store.path)])) {
      const root = path.resolve(storePath);
      const canonical = realDestination(root);
      if ([destination, resolved].some(dir => [root, canonical].some(store => inside(store, dir) || inside(dir, store)))) {
        throw new Error(`Choose a vault directory outside the Phren store at ${storePath} that does not contain the store.`);
      }
    }
    for (const root of checkouts) {
      if (inside(root, destination) || inside(realDestination(root), resolved)) {
        throw new Error(`Choose a vault directory outside the source checkout at ${root}.`);
      }
    }
    return resolved;
  };
}

export function forceUnlockVault(phrenPath: string, target: string): boolean {
  const dir = destinationGuard(phrenPath, target)(exportStores(phrenPath));
  const lock = path.join(dir, `${MANIFEST}.lock`);
  if (!fs.lstatSync(lock, { throwIfNoEntry: false })) return false;
  const { raw } = readVaultLock(lock);
  if (regularFile(lock)?.toString("utf8") !== raw) throw new Error(`Vault lock changed at ${lock}. Check the current owner before retrying.`);
  tryUnlink(lock);
  return true;
}

export async function exportVault(phrenPath: string, target: string, names: string[], dryRun: boolean) {
  phrenPath = path.resolve(phrenPath);
  const stores = exportStores(phrenPath);
  const checkDestination = destinationGuard(phrenPath, target);
  checkDestination(stores);

  const allProjects: VaultProject[] = stores.flatMap(entry => {
    const primary = entry.role === "primary";
    const store = primary ? { ...entry, path: phrenPath } : entry;
    const dirs = primary ? getProjectDirs(phrenPath) : entry.available ? getStoreProjectDirs(entry) : [];
    return dirs.map(dir => {
      const name = path.basename(dir);
      return { title: primary ? name : `${store.name}/${name}`, name, dir, store, file: "", findings: [], fragments: new Set<VaultFragment>() };
    });
  });
  const selected = new Set<VaultProject>();
  for (const input of names) {
    const { storeName, projectName } = parseStoreQualified(input);
    const matches = allProjects.filter(project => project.name === projectName && (!storeName || project.store.name === storeName));
    if (matches.length !== 1) throw new Error(matches.length
      ? `Project "${input}" is ambiguous. Use ${matches.map(p => `${p.store.name}/${p.name}`).sort().join(" or ")}.`
      : `Project "${input}" was not found in the available stores.`);
    selected.add(matches[0]);
  }
  const projects = (names.length ? [...selected] : allProjects.slice()).sort((a, b) => a.title < b.title ? -1 : Number(a.title > b.title));
  for (const project of projects) {
    for (const source of iterateProjectFindings(project.store.path, project.name, {
      projectDir: project.dir,
      onSkipped: (file, reason) => console.warn(`Skipping finding path ${file} (${reason}).`),
    })) {
      project.findings.push({
        file: "", title: source.text.slice(0, 90), source, lifecycle: parseFindingLifecycle(source.line),
        normalized: normalizeReference(source.line), relations: new Set(), fragments: new Set(),
      });
    }
  }

  const fragments = await linkFragments(phrenPath, projects);
  const counts = { projects: projects.length, findings: projects.reduce((n, p) => n + p.findings.length, 0), fragments: fragments.size };
  if (dryRun) return counts;

  const dir = checkDestination(exportStores(phrenPath));
  const manifest = path.join(dir, MANIFEST);
  const used = new Set<string>();
  const allocate = (base: string): string => {
    let file = `${base}.md`;
    for (let suffix = 2; used.has(file); suffix++) file = `${base}-${suffix}.md`;
    used.add(file);
    return file;
  };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = lockVault(`${manifest}.lock`);
  try {
    const names = fs.readdirSync(dir);
    const owned = previousNotes(dir, manifest, names);
    for (const name of names) if (!owned.has(name)) used.add(name.toLowerCase());
    for (const fragment of fragments.values()) fragment.file = allocate(`fragment-${slug(fragment.title)}`);
    for (const project of projects) {
      const projectSlug = slug(project.title);
      project.file = allocate(`project-${projectSlug}`);
      for (const finding of project.findings) {
        const key = finding.source.fid?.toLowerCase() ?? `legacy-${digest(finding.source.text).slice(0, 12)}`;
        finding.file = allocate(`finding-${key}--${projectSlug}`);
      }
    }
    linkRelations(projects);
    const notes = new Map<string, string>();
    for (const project of projects) {
      notes.set(project.file, markdown({ kind: "project", project: project.title },
        `# ${project.title}\n${noteList("Findings", project.findings)}${noteList("Fragments", project.fragments)}`));
      for (const finding of project.findings) notes.set(finding.file, renderFinding(project, finding));
    }
    for (const fragment of fragments.values()) {
      notes.set(fragment.file, markdown({ kind: "fragment", fragment: fragment.title, types: [...fragment.types].sort() },
        `# ${fragment.title}\n${noteList("Projects", fragment.projects)}${noteList("Findings", fragment.findings)}`));
    }
    const rewriteLinks = sourceWikilinks([...projects, ...projects.flatMap(project => project.findings), ...fragments.values()], notes, fragments);
    for (const [file, content] of notes) {
      const start = FRONTMATTER.exec(content)![0].length;
      notes.set(file, content.slice(0, start) + rewriteLinks(content.slice(start), file));
    }

    const files = Object.fromEntries([...notes.keys()].sort().map(file => [file, digest(notes.get(file)!)]));
    const saveManifest = (files: Record<string, string>, pending?: Record<string, string>) =>
      atomicWriteText(manifest, `${JSON.stringify({ version: 1, files, pending }, null, 2)}\n`, { mode: 0o600 });
    saveManifest(Object.fromEntries(owned), files);
    for (const [file, content] of notes) {
      const target = path.join(dir, file);
      const previous = owned.get(file);
      if (!previous) publishExclusive(target, content);
      else {
        const current = regularFile(target);
        if (!current || digest(current) !== previous) throw new Error(`Vault note changed during export at ${target}. Try again shortly.`);
        if (previous !== files[file]) atomicWriteText(target, content, { mode: 0o600 });
      }
    }
    for (const [file, hash] of owned) {
      if (notes.has(file)) continue;
      const target = path.join(dir, file);
      const current = regularFile(target);
      if (current && digest(current) === hash) tryUnlink(target);
    }
    saveManifest(files);
    return counts;
  } finally {
    release();
  }
}
