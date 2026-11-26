import * as fs from "fs";
import { assertFindingVersions } from "../finding/versions.js";
import * as path from "path";
import { renameOverSync } from "../phren-paths.js";
import * as crypto from "crypto";
import { debugLog, appendAuditLog, phrenOk, phrenErr, PhrenError, type PhrenResult, type FindingTag } from "../shared.js";
import { normalizeMemoryScope } from "../shared.js";
import { withFileLock, recordLookupEvents } from "../shared/governance.js";
import { findingNodeIdForLine } from "../finding-graph-id.js";
import { isValidProjectName } from "../utils.js";
import { storeAwareProjectPath } from "../store-routing.js";
import {
  type FindingCitation,
  type FindingProvenance,
  buildCitationComment,
  buildScopeComment,
  buildSourceComment,
  getHeadCommit,
  getRepoRoot,
} from "./citation.js";
import { originRemote, projectCheckout } from "./citation-checkouts.js";
import { EXEC_TIMEOUT_QUICK_MS } from "../phren-core.js";
import { runGitOrThrow } from "../utils.js";
import { iterateProjectFindings } from "../finding/locate.js";
import { isDuplicateFinding, scanForSecrets, normalizeObservationTags, resolveCoref } from "./dedup.js";
import { validateFindingsFormat, validateFinding } from "./validate.js";
import { countActiveFindings, autoArchiveToReference } from "./archive.js";
import {
  resolveAutoFindingTaskItem,
  resolveFindingTaskReference,
} from "../finding/context.js";
import {
  buildLifecycleComments,
  extractFindingType,
  parseFindingLifecycle,
  stripLifecycleComments,
  type FindingLifecycleMetadata,
} from "../finding/lifecycle.js";
import {
  METADATA_REGEX,
  normalizeFindingText,
  withoutTypeTag,
} from "./metadata.js";
import { FINDINGS_FILENAME } from "../data/access.js";

/** Default cap for active findings before auto-archiving is triggered. */
const DEFAULT_FINDINGS_CAP = 20;

interface ArchivedDuplicate {
  fid?: string;
  file: string;
}

interface PreparedFinding {
  original: string;
  normalized: string;
  bullet: string;
  citation: FindingCitation;
  citationComment: string;
  tagWarning?: string;
}

const LIFECYCLE_ANNOTATION_RE = METADATA_REGEX.lifecycleAnnotation;

/** Default finding-id source: 8 lowercase hex chars from a CSPRNG. Overridable
 *  via `AddFindingOptions.idSource` for deterministic fixture generation
 *  (the phren apps' generate-fixtures.mjs) — production callers never set it,
 *  so this is the only thing that ever runs outside tests. */
function defaultFindingIdSource(): string {
  return crypto.randomBytes(4).toString("hex");
}

interface AddFindingOptions {
  expectedFindings?: Record<string, string>;
  extraAnnotations?: string[];
  sessionId?: string;
  scope?: string;
  provenance?: FindingProvenance;
  /**
   * Clock and id-source overrides. Both default to the real clock/CSPRNG, so
   * omitting them is byte-identical to today's behaviour; they exist solely so
   * `generate-fixtures.mjs` can make its output reproducible the same way
   * `notes.addNote`'s `now` option and `tasks.addTask`'s `createdAt` option
   * already let the fixture generator fix the clock for notes and tasks.
   */
  now?: Date;
  idSource?: () => string;
}

export interface AddFindingResult {
  message: string;
  status: "added" | "created" | "skipped";
}

interface AddFindingWriteResult {
  content: string;
  citation: FindingCitation;
  tagWarning?: string;
  created: boolean;
  bullet: string;
}

interface AddFindingsWriteResult {
  content: string;
  wrote: boolean;
}

/** The repo a new finding's citation names, read once per write. */
interface CitationRepo {
  /** The checkout: the caller's repo, the repo of the caller's absolute file, else this computer's checkout of the project. */
  root?: string;
  /** The checkout's `origin` remote; when set the citation names the repo by it and its file relative to `root`. */
  remote?: string;
  head?: string;
  /** The caller named a repo or a file, so the repo is cited even when it has no remote. */
  given: boolean;
}

function resolveCitationRepo(phrenPath: string, project: string, input?: Partial<FindingCitation>): CitationRepo {
  const given = Boolean(input?.repo || input?.file);
  let root: string | undefined;
  if (input?.repo) root = getRepoRoot(input.repo);
  else if (input?.file && path.isAbsolute(input.file)) root = getRepoRoot(path.dirname(input.file));
  else root = projectCheckout(phrenPath, project);
  if (!root) return { root: input?.repo, head: input?.repo ? getHeadCommit(input.repo) : undefined, given };
  return { root, remote: originRemote(root), head: getHeadCommit(root), given };
}

// A path inside `root` as a repo-relative path with forward slashes, or undefined when it is outside.
function repoRelative(root: string, file: string): string | undefined {
  const inside = (base: string, target: string) => {
    const rel = path.relative(base, target);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : undefined;
  };
  const direct = inside(root, file);
  if (direct) return direct;
  // git reports the real path (macOS /private/var, Windows long names for 8.3 ones like RUNNER~1), so compare native real paths too.
  const real = fs.realpathSync.native ?? fs.realpathSync;
  try { return inside(real(root), real(file)); } catch { return undefined; }
}

// File paths a finding names, like `content/citation.ts` or `README.md`.
const NAMED_PATH = /(?:^|[\s`'"(\[])((?:[\w.@-]+\/)*[\w@-][\w.@-]*\.[A-Za-z]\w{0,7})(?::\d+)?(?=$|[\s`'"),.;:\]])/g;

/**
 * The one file a finding names that the checkout tracks, as a repo-relative path. Each named
 * path must match exactly one tracked file (whole path or a trailing part of one), and all of
 * them the same file; anything less certain cites no file.
 */
function fileNamedInFinding(root: string, text: string): string | undefined {
  const named = [...new Set([...text.replace(/<!--.*?-->/g, " ").matchAll(NAMED_PATH)].map(match => match[1]))]
    .filter(name => !name.split("/").some(part => part === "." || part === ".."))
    .slice(0, 20);
  if (named.length === 0) return undefined;
  let tracked: string[];
  try {
    const out = runGitOrThrow(root, ["ls-files", "-z", "--", ...named.map(name => `:(glob)**/${name}`)], EXEC_TIMEOUT_QUICK_MS);
    tracked = out.split("\0").filter(Boolean);
  } catch (err: unknown) {
    debugLog(`fileNamedInFinding: git ls-files failed in ${root}: ${String(err)}`);
    return undefined;
  }
  const files = new Set<string>();
  for (const name of named) {
    const matches = tracked.filter(file => file === name || file.endsWith(`/${name}`));
    if (matches.length > 1) return undefined;
    if (matches.length === 1) files.add(matches[0]);
  }
  return files.size === 1 ? [...files][0] : undefined;
}

/**
 * The citation for a new finding. With a remote it names the repo by that remote, the commit (the
 * caller's, else the checkout's HEAD) and a repo-relative file: the caller's, else the one file the
 * finding names. Without one it keeps the caller's repo path, as before. A file or line is never guessed.
 */
function buildFindingCitation(
  input: Partial<FindingCitation> | undefined,
  nowIso: string | undefined,
  repo: CitationRepo,
  findingText: string,
): FindingCitation {
  const created_at = nowIso ?? new Date().toISOString();
  const rest = {
    symbol: input?.symbol,
    symbol_unresolved: input?.symbol_unresolved ? true : undefined,
    supersedes: input?.supersedes,
    task_item: input?.task_item,
  };
  if (repo.remote && repo.root) {
    let file: string | undefined;
    if (input?.file) {
      const absolute = path.isAbsolute(input.file) ? input.file : input.repo ? path.resolve(input.repo, input.file) : undefined;
      file = absolute ? repoRelative(repo.root, absolute) : path.posix.normalize(input.file.split(path.sep).join("/"));
    }
    const portableFile = file && !file.startsWith("../") && file !== ".." ? file : undefined;
    if (!input?.file || portableFile) {
      const named = portableFile ? undefined : fileNamedInFinding(repo.root, findingText);
      return {
        created_at,
        remote: repo.remote,
        file: portableFile ?? named,
        line: portableFile ? input?.line : undefined,
        commit: input?.commit || repo.head,
        ...rest,
      };
    }
  }
  const repoPath = input?.repo || (repo.given ? repo.root : undefined);
  return {
    created_at,
    repo: repoPath,
    file: input?.file,
    line: input?.line,
    commit: input?.commit || (repoPath ? repo.head : undefined),
    ...rest,
  };
}

function buildFindingScope(scope?: string): string | undefined {
  return normalizeMemoryScope(scope) || undefined;
}

function resolveFindingCitationInput(
  phrenPath: string,
  project: string,
  citationInput?: Partial<FindingCitation>,
): PhrenResult<Partial<FindingCitation> | undefined> {
  const resolved = citationInput ? { ...citationInput } : {};
  if (citationInput?.task_item) {
    const taskResolution = resolveFindingTaskReference(phrenPath, project, citationInput.task_item);
    if (taskResolution.error) {
      return phrenErr(taskResolution.error, PhrenError.VALIDATION_ERROR);
    }
    if (taskResolution.stableId) {
      resolved.task_item = taskResolution.stableId;
    }
  } else {
    const taskItem = resolveAutoFindingTaskItem(phrenPath, project);
    if (taskItem) {
      resolved.task_item = taskItem;
    }
  }

  return phrenOk(Object.keys(resolved).length > 0 ? resolved : undefined);
}

/**
 * Heuristically infer a finding's type tag from its own wording when the
 * caller didn't supply one. Return type is FindingTag (not FindingType)
 * because "workaround" and "context" are valid outputs here even though
 * they aren't part of the smaller offered/pickable FINDING_TYPES set —
 * both still have a FINDING_TYPE_DECAY row and are searchable via
 * search_knowledge's `tag` filter (FINDING_TAGS), so this function agrees
 * with both.
 */
export function autoDetectFindingType(text: string): FindingTag | null {
  const lower = text.toLowerCase();
  if (/\b(we decided|decision:|chose .+ over|went with)\b/.test(lower)) return 'decision';
  if (/\b(bug:|bug in|found a bug|broken|crashes|fails when)\b/.test(lower)) return 'bug';
  if (/\b(workaround:|work around|temporary fix|hack:)\b/.test(lower)) return 'workaround';
  if (/\b(pattern:|always .+ before|never .+ without|best practice)\b/.test(lower)) return 'pattern';
  if (/\b(pitfall:|gotcha:|watch out|careful with|trap:)\b/.test(lower)) return 'pitfall';
  if (/\b(currently|as of|right now|at the moment|observation:)\b/.test(lower)) return 'context';
  return null;
}

interface PrepareFindingOpts {
  finding: string;
  project: string;
  fullHistory: string;
  extraAnnotations?: string[];
  citationInput?: Partial<FindingCitation>;
  scope?: string;
  provenance?: FindingProvenance;
  nowIso?: string;
  citationRepo: CitationRepo;
  phrenPath?: string;
  idSource?: () => string;
}

function prepareFinding(
  opts: PrepareFindingOpts,
): { status: "added"; finding: PreparedFinding } | { status: "duplicate"; duplicate?: ArchivedDuplicate } | { status: "rejected"; reason: string } {
  const { finding: learning, project, fullHistory, extraAnnotations, citationInput, scope, provenance, nowIso, citationRepo, idSource } = opts;
  const secretType = scanForSecrets(learning);
  if (secretType) {
    return { status: "rejected", reason: `Contains ${secretType}` };
  }

  const today = (nowIso ?? new Date().toISOString()).slice(0, 10);
  const { text: tagNormalized, warning: tagWarning } = normalizeObservationTags(learning);
  let normalizedLearning = resolveCoref(tagNormalized, {
    project,
    file: citationInput?.file,
  });
  const existingType = extractFindingType('- ' + normalizedLearning);
  if (!existingType) {
    const detected = autoDetectFindingType(normalizedLearning);
    if (detected) {
      normalizedLearning = `[${detected}] ${normalizedLearning}`;
    }
  }
  const fid = (idSource ?? defaultFindingIdSource)();
  const fidComment = `<!-- fid:${fid} -->`;
  const createdComment = `<!-- created: ${today} -->`;
  const scopeComment = buildScopeComment(scope);
  let lifecycle: FindingLifecycleMetadata = { status: "active", status_updated: today };
  let bullet = `${normalizedLearning.startsWith("- ") ? normalizedLearning : `- ${normalizedLearning}`} ${fidComment} ${createdComment}`;
  if (scopeComment) bullet += ` ${scopeComment}`;
  const sourceComment = provenance ? buildSourceComment(provenance) : "";
  if (sourceComment) bullet += ` ${sourceComment}`;

  if (isDuplicateFinding(fullHistory, bullet)) {
    return { status: "duplicate" };
  }

  if (opts.phrenPath) {
    const needle = withoutTypeTag(normalizeFindingText(bullet));
    for (const existing of iterateProjectFindings(opts.phrenPath, project)) {
      if (existing.tier === "active" || existing.status !== "active") continue;
      if (needle && withoutTypeTag(normalizeFindingText(existing.line)) === needle) {
        return { status: "duplicate", duplicate: { fid: existing.fid, file: existing.file } };
      }
    }
  }

  // NOTE: heuristic contradiction detection is intentionally NOT done here. The lexical
  // heuristic (shared entity + opposing polarity) produces false positives, so it must
  // never silently mutate the stored finding's status. Instead the MCP add_finding tool
  // surfaces heuristic conflict *candidates* (via findConflictCandidates) in its response
  // so the calling agent — an LLM already in the loop with full context — can judge them,
  // exactly as it already does for potential duplicates. A hard "contradicted" status is
  // reserved for the LLM-confirmed path (checkSemanticConflicts) and explicit user
  // resolution via resolve_contradiction.
  if (extraAnnotations && extraAnnotations.length > 0) {
    const lifecycleFromExtra = parseFindingLifecycle(`- lifecycle ${extraAnnotations.join(" ")}`);
    if (
      lifecycleFromExtra.status !== "active" ||
      lifecycleFromExtra.status_reason ||
      lifecycleFromExtra.status_ref ||
      lifecycleFromExtra.status_updated
    ) {
      lifecycle = {
        ...lifecycle,
        ...lifecycleFromExtra,
        status_updated: lifecycleFromExtra.status_updated ?? lifecycle.status_updated ?? today,
      };
    }
    const existing = new Set(
      [...bullet.matchAll(METADATA_REGEX.conflictsWithAll)].map((m) => m[0])
    );
    for (const annotation of extraAnnotations) {
      if (!annotation.startsWith("<!--")) continue;
      if (LIFECYCLE_ANNOTATION_RE.test(annotation)) continue;
      if (existing.has(annotation)) continue;
      bullet += ` ${annotation}`;
      existing.add(annotation);
    }
  }
  bullet += ` ${buildLifecycleComments(lifecycle, today)}`;

  const citation = buildFindingCitation(citationInput, nowIso, citationRepo, normalizedLearning);
  return {
    status: "added",
    finding: {
      original: learning,
      normalized: normalizedLearning,
      bullet,
      citation,
      citationComment: `  ${buildCitationComment(citation)}`,
      tagWarning,
    },
  };
}

function insertFindingIntoContent(content: string, today: string, bullet: string, citationComment: string): string {
  const todayHeader = `## ${today}`;
  // Use positional insertion (not String.replace) to avoid: (1) special $& replacement patterns
  // if bullet contains $ chars, and (2) inserting inside an archived <details> block when a
  // duplicate date header exists from a prior consolidation run.
  // Search for todayHeader only after the last </details> close tag so we never
  // insert into an archived block whose date happens to match today.
  const lastDetailsClose = content.lastIndexOf("</details>");
  const searchFrom = lastDetailsClose >= 0 ? lastDetailsClose : 0;
  const idx = content.indexOf(todayHeader, searchFrom);
  if (idx !== -1) {
    const insertAt = idx + todayHeader.length;
    return content.slice(0, insertAt) + `\n\n${bullet}\n${citationComment}` + content.slice(insertAt);
  }
  const firstHeadingMatch = content.match(/^## \d{4}-\d{2}-\d{2}/m);
  if (firstHeadingMatch?.index != null) {
    return (
      content.slice(0, firstHeadingMatch.index) +
      `${todayHeader}\n\n${bullet}\n${citationComment}\n\n` +
      content.slice(firstHeadingMatch.index)
    );
  }
  return content.trimEnd() + `\n\n## ${today}\n\n${bullet}\n${citationComment}\n`;
}

export function upsertCanonical(phrenPath: string, project: string, memory: string): PhrenResult<string> {
  if (!isValidProjectName(project)) return phrenErr(`Invalid project name: "${project}".`, PhrenError.INVALID_PROJECT_NAME);
  const resolvedDir = storeAwareProjectPath(phrenPath, project);
  if (!resolvedDir || !fs.existsSync(resolvedDir)) return phrenErr(`Project "${project}" not found in phren.`, PhrenError.PROJECT_NOT_FOUND);
  const canonicalPath = path.join(resolvedDir, "truths.md");
  const today = new Date().toISOString().slice(0, 10);
  const bullet = memory.startsWith("- ") ? memory : `- ${memory}`;
  withFileLock(canonicalPath, () => {
    if (!fs.existsSync(canonicalPath)) {
      fs.writeFileSync(canonicalPath, `# ${project} Truths\n\n## Truths\n\n${bullet} _(added ${today})_\n`);
    } else {
      const existing = fs.readFileSync(canonicalPath, "utf8");
      const line = `${bullet} _(added ${today})_`;
      if (!existing.includes(bullet)) {
        const updated = existing.includes("## Truths")
          ? existing.replace("## Truths", `## Truths\n\n${line}`)
          : `${existing.trimEnd()}\n\n## Truths\n\n${line}\n`;
        const content = updated.endsWith("\n") ? updated : updated + "\n";
        const tmpPath = canonicalPath + `.tmp-${crypto.randomUUID()}`;
        fs.writeFileSync(tmpPath, content);
        renameOverSync(tmpPath, canonicalPath);
      }
    }
  });

  appendAuditLog(phrenPath, "pin_memory", `project=${project} memory=${JSON.stringify(memory)}`);
  return phrenOk(`Truth saved in ${project}.`);
}

export function addFindingToFile(
  phrenPath: string,
  project: string,
  learning: string,
  citationInput?: Partial<FindingCitation>,
  opts?: AddFindingOptions
): PhrenResult<AddFindingResult> {
  const findingError = validateFinding(learning);
  if (findingError) return phrenErr(findingError, PhrenError.EMPTY_INPUT);
  if (!isValidProjectName(project)) return phrenErr(`Invalid project name: "${project}".`, PhrenError.INVALID_PROJECT_NAME);
  const resolvedDir = storeAwareProjectPath(phrenPath, project);
  if (!resolvedDir) return phrenErr(`Invalid project name: "${project}".`, PhrenError.INVALID_PROJECT_NAME);
  const learningsPath = path.join(resolvedDir, FINDINGS_FILENAME);

  // Secret/PII scan — reject before anything else (before existence check, before lock)
  const nowIso = (opts?.now ?? new Date()).toISOString();
  const today = nowIso.slice(0, 10);
  const resolvedCitationInputResult = resolveFindingCitationInput(phrenPath, project, citationInput);
  if (!resolvedCitationInputResult.ok) return resolvedCitationInputResult;
  const resolvedCitationInput = resolvedCitationInputResult.data;
  const scope = buildFindingScope(opts?.scope);
  const citationRepo = resolveCitationRepo(phrenPath, project, resolvedCitationInput);
  const supersedesText = resolvedCitationInput?.supersedes;
  const normalizedForSupersedes = supersedesText
    ? resolveCoref(normalizeObservationTags(learning).text, {
        project,
        file: resolvedCitationInput?.file,
      })
    : undefined;

  // Reject secrets before anything else — even if project doesn't exist yet
  const earlySecretType = scanForSecrets(learning);
  if (earlySecretType) {
    return phrenErr(`Rejected: finding appears to contain a secret (${earlySecretType}). Strip credentials before saving.`, PhrenError.VALIDATION_ERROR);
  }
  // Check project dir existence before withFileLock (which would create the dir via mkdirSync)
  if (!fs.existsSync(resolvedDir)) return phrenErr(`Project "${project}" does not exist.`, PhrenError.INVALID_PROJECT_NAME);

  const result: PhrenResult<AddFindingWriteResult | string> = withFileLock(learningsPath, () => {
    assertFindingVersions(learningsPath, opts?.expectedFindings);
    if (!fs.existsSync(learningsPath)) {
      const preparedForNewFile = prepareFinding({
        finding: learning, project, fullHistory: "", extraAnnotations: opts?.extraAnnotations,
        citationInput: resolvedCitationInput, scope, provenance: opts?.provenance, nowIso, citationRepo, phrenPath,
        idSource: opts?.idSource,
      });
      if (preparedForNewFile.status === "rejected") {
        return phrenErr(`Rejected: finding appears to contain a secret (${preparedForNewFile.reason.replace(/^Contains /, "")}). Strip credentials before saving.`, PhrenError.VALIDATION_ERROR);
      }
      if (preparedForNewFile.status === "duplicate") {
        return phrenOk(duplicateMessage(project, preparedForNewFile.duplicate));
      }
      const newContent = `# ${project} Findings\n\n## ${today}\n\n${preparedForNewFile.finding.bullet}\n${preparedForNewFile.finding.citationComment}\n`;
      const tmpPath = learningsPath + `.tmp-${crypto.randomUUID()}`;
      fs.writeFileSync(tmpPath, newContent);
      renameOverSync(tmpPath, learningsPath);
      return phrenOk({
        content: newContent,
        citation: preparedForNewFile.finding.citation,
        tagWarning: preparedForNewFile.finding.tagWarning,
        created: true,
        bullet: preparedForNewFile.finding.bullet,
      });
    }

    const content = fs.readFileSync(learningsPath, "utf8");
    // When superseding, strip the old finding from history so dedup doesn't block the intentionally similar replacement.
    // Skip the strip if new finding is identical to the superseded one (self-supersession should still be blocked by dedup).
    const isSelfSupersession = supersedesText &&
      learning.trim().toLowerCase().slice(0, 60) === supersedesText.trim().toLowerCase().slice(0, 60);
    const historyForDedup = (supersedesText && !isSelfSupersession)
      ? content.split("\n")
          .filter(line => !line.startsWith("- ") || !line.toLowerCase().includes(supersedesText.slice(0, 40).toLowerCase()))
          .join("\n")
      : content;
    const prepared = prepareFinding({
      finding: learning, project, fullHistory: historyForDedup, extraAnnotations: opts?.extraAnnotations,
      citationInput: resolvedCitationInput, scope, provenance: opts?.provenance, nowIso, citationRepo, phrenPath,
      idSource: opts?.idSource,
    });
    if (prepared.status === "rejected") {
      return phrenErr(`Rejected: finding appears to contain a secret (${prepared.reason.replace(/^Contains /, "")}). Strip credentials before saving.`, PhrenError.VALIDATION_ERROR);
    }
    if (prepared.status === "duplicate") {
      debugLog(`add_finding: skipped duplicate for "${project}": ${learning.slice(0, 80)}`);
      return phrenOk(duplicateMessage(project, prepared.duplicate));
    }

    const issues = validateFindingsFormat(content);
    if (issues.length > 0) {
      debugLog(`FINDINGS.md format warnings for "${project}": ${issues.join("; ")}`);
    }

    let updated = insertFindingIntoContent(content, today, prepared.finding.bullet, prepared.finding.citationComment);
    if (supersedesText && normalizedForSupersedes) {
      const lines = updated.split("\n");
      const needle = supersedesText.slice(0, 60).toLowerCase().replace(/\s+/g, " ").trim();
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith("- ")) continue;
        const lineText = lines[i].replace(/<!--.*?-->/g, "").replace(/^-\s+/, "").replace(/^\[[^\]]+\]\s+/, "").slice(0, 60).toLowerCase().replace(/\s+/g, " ").trim();
        if (lineText === needle) {
          // Remove any legacy and normalized lifecycle supersession metadata before re-appending.
          lines[i] = lines[i].replace(METADATA_REGEX.stripSupersededByLegacy, "");
          lines[i] = lines[i].replace(METADATA_REGEX.stripSupersededBy, "");
          lines[i] = stripLifecycleComments(lines[i]);
          const newFirst60 = normalizedForSupersedes.replace(/^-\s+/, "").slice(0, 60);
          lines[i] =
            `${lines[i]} <!-- phren:superseded_by "${newFirst60}" ${today} --> ` +
            `${buildLifecycleComments({ status: "superseded", status_updated: today, status_reason: "superseded_by", status_ref: newFirst60 }, today)}`;
          updated = lines.join("\n");
          break;
        }
      }
      // Also annotate the new finding bullet with phren:supersedes
      const newLines = updated.split("\n");
      for (let i = 0; i < newLines.length; i++) {
        if (!newLines[i].startsWith("- ")) continue;
        if (newLines[i].includes(prepared.finding.bullet.slice(0, 40))) {
          if (!newLines[i].includes("phren:supersedes")) {
            const supersedesFirst60 = supersedesText.slice(0, 60);
            newLines[i] = `${newLines[i]} <!-- phren:supersedes "${supersedesFirst60}" -->`;
          }
          updated = newLines.join("\n");
          break;
        }
      }
    }

    const tmpPath = learningsPath + `.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmpPath, updated);
    renameOverSync(tmpPath, learningsPath);
    return phrenOk({
      content: updated,
      citation: prepared.finding.citation,
      tagWarning: prepared.finding.tagWarning,
      created: false,
      bullet: prepared.finding.bullet,
    });
  });

  if (!result.ok) return result;
  if (typeof result.data === "string") return phrenOk({ message: result.data, status: "skipped" as const });

  appendAuditLog(
    phrenPath,
    "add_finding",
    `project=${project}${result.data.created ? " created=true" : ""} citation_commit=${result.data.citation.commit ?? "none"} citation_file=${result.data.citation.file ?? "none"}`
  );

  // Live activity: a write lights up the same graph node a lookup would, so a
  // watching shell shows findings being saved as well as read. Best-effort.
  try {
    const bullet = result.data.bullet;
    if (bullet) {
      // Derive the node id the same way buildGraph does, so a watching graph
      // lights the node that was just written rather than a phantom id.
      const nodeId = findingNodeIdForLine(project, bullet.startsWith("-") ? bullet : `- ${bullet}`);
      recordLookupEvents(phrenPath, [{
        query: "",
        project,
        filename: FINDINGS_FILENAME,
        type: "findings",
        snippet: bullet.replace(/^-\s+/, "").replace(/\s*<!--.*?-->/g, "").trim(),
        source: "write",
        ...(nodeId ? { nodeId } : {}),
      }]);
    }
  } catch (err: unknown) {
    debugLog(`addFindingToFile lookup-event: ${String(err)}`);
  }

  const cap = Number.parseInt((process.env.PHREN_FINDINGS_CAP) || "", 10) || DEFAULT_FINDINGS_CAP;
  const activeCount = countActiveFindings(result.data.content);
  if (activeCount > cap) {
    const archiveResult = autoArchiveToReference(phrenPath, project, cap);
    if (archiveResult.ok && archiveResult.data > 0) {
      debugLog(`Size cap: archived ${archiveResult.data} oldest entries for "${project}" (cap=${cap})`);
    }
  }

  if (result.data.created) {
    const createdMsg = `Created FINDINGS.md for "${project}" and added insight.`;
    const message = result.data.tagWarning ? `${createdMsg} Warning: ${result.data.tagWarning}` : createdMsg;
    return phrenOk({ message, status: "created" as const });
  }

  const addedMsg = `Added finding to ${project}: ${result.data.bullet} (with citation metadata)`;
  const message = result.data.tagWarning ? `${addedMsg} Warning: ${result.data.tagWarning}` : addedMsg;
  return phrenOk({ message, status: "added" as const });
}

function duplicateMessage(project: string, duplicate?: ArchivedDuplicate): string {
  return duplicate
    ? `Skipped duplicate finding for "${project}": already exists as ${duplicate.fid ? `fid:${duplicate.fid}` : duplicate.file}.`
    : `Skipped duplicate finding for "${project}": already exists with similar wording.`;
}

export function addFindingsToFile(
  phrenPath: string,
  project: string,
  learnings: string[],
  opts?: { extraAnnotationsByFinding?: string[][]; sessionId?: string; scope?: string; provenance?: FindingProvenance }
): PhrenResult<{ added: string[]; skipped: string[]; rejected: { text: string; reason: string }[]; duplicates?: (ArchivedDuplicate & { text: string })[] }> {
  if (!isValidProjectName(project)) return phrenErr(`Invalid project name: "${project}".`, PhrenError.INVALID_PROJECT_NAME);
  const resolvedDir = storeAwareProjectPath(phrenPath, project);
  if (!resolvedDir) return phrenErr(`Invalid project name: "${project}".`, PhrenError.INVALID_PROJECT_NAME);
  const learningsPath = path.join(resolvedDir, FINDINGS_FILENAME);

  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  const resolvedCitationInputResult = resolveFindingCitationInput(phrenPath, project);
  if (!resolvedCitationInputResult.ok) return resolvedCitationInputResult;
  const resolvedCitationInput = resolvedCitationInputResult.data;
  const scope = buildFindingScope(opts?.scope);
  const citationRepo = resolveCitationRepo(phrenPath, project, resolvedCitationInput);

  const added: string[] = [];
  const skipped: string[] = [];
  const duplicates: (ArchivedDuplicate & { text: string })[] = [];
  const rejected: { text: string; reason: string }[] = [];

  // Check project dir existence before withFileLock (which would create the dir via mkdirSync)
  if (!fs.existsSync(resolvedDir)) return phrenErr(`Project "${project}" not found in phren.`, PhrenError.PROJECT_NOT_FOUND);

  const contentResult: PhrenResult<AddFindingsWriteResult> = withFileLock(learningsPath, () => {
    if (!fs.existsSync(learningsPath)) {
      let content = `# ${project} Findings\n\n## ${today}\n`;
      for (const [index, learning] of learnings.entries()) {
        const extraAnnotations = opts?.extraAnnotationsByFinding?.[index];
        const lengthError = validateFinding(learning);
        if (lengthError) {
          rejected.push({ text: learning, reason: lengthError });
          continue;
        }
        const prepared = prepareFinding({
          finding: learning, project, fullHistory: content, extraAnnotations,
          citationInput: resolvedCitationInput, scope, provenance: opts?.provenance, nowIso, citationRepo, phrenPath,
        });
        if (prepared.status === "rejected") {
          rejected.push({ text: learning, reason: prepared.reason });
          continue;
        }
        if (prepared.status === "duplicate") {
          skipped.push(learning);
          if (prepared.duplicate) duplicates.push({ text: learning, ...prepared.duplicate });
          continue;
        }
        content = insertFindingIntoContent(content, today, prepared.finding.bullet, prepared.finding.citationComment);
        if (prepared.finding.tagWarning) debugLog(`add_findings: ${prepared.finding.tagWarning}`);
        added.push(learning);
      }
      if (added.length > 0) {
        const tmpPath = learningsPath + `.tmp-${crypto.randomUUID()}`;
        fs.writeFileSync(tmpPath, content.endsWith("\n") ? content : `${content}\n`);
        renameOverSync(tmpPath, learningsPath);
      }
      return phrenOk({ content, wrote: added.length > 0 });
    }

    let content = fs.readFileSync(learningsPath, "utf8");
    const issues = validateFindingsFormat(content);
    if (issues.length > 0) debugLog(`FINDINGS.md format warnings for "${project}": ${issues.join("; ")}`);

    for (const [index, learning] of learnings.entries()) {
      const extraAnnotations = opts?.extraAnnotationsByFinding?.[index];
      const lengthError = validateFinding(learning);
      if (lengthError) {
        rejected.push({ text: learning, reason: lengthError });
        continue;
      }
      const prepared = prepareFinding({
        finding: learning, project, fullHistory: content, extraAnnotations,
        citationInput: resolvedCitationInput, scope, nowIso, citationRepo, phrenPath,
      });
      if (prepared.status === "rejected") {
        rejected.push({ text: learning, reason: prepared.reason });
        continue;
      }
      if (prepared.status === "duplicate") {
        skipped.push(learning);
        if (prepared.duplicate) duplicates.push({ text: learning, ...prepared.duplicate });
        continue;
      }
      content = insertFindingIntoContent(content, today, prepared.finding.bullet, prepared.finding.citationComment);
      if (prepared.finding.tagWarning) debugLog(`add_findings: ${prepared.finding.tagWarning}`);
      added.push(learning);
    }

    if (added.length > 0) {
      const tmpPath = learningsPath + `.tmp-${crypto.randomUUID()}`;
      fs.writeFileSync(tmpPath, content);
      renameOverSync(tmpPath, learningsPath);
    }

    return phrenOk({ content, wrote: added.length > 0 });
  });

  if (!contentResult.ok) return contentResult;

  if (contentResult.data.wrote) {
    appendAuditLog(phrenPath, "add_finding", `project=${project} count=${added.length} batch=true`);

    const cap = Number.parseInt((process.env.PHREN_FINDINGS_CAP) || "", 10) || DEFAULT_FINDINGS_CAP;
    if (countActiveFindings(contentResult.data.content) > cap) {
      const archiveResult = autoArchiveToReference(phrenPath, project, cap);
      if (archiveResult.ok && archiveResult.data > 0) {
        debugLog(`Size cap: archived ${archiveResult.data} oldest entries for "${project}" (cap=${cap})`);
      }
    }
  }

  return phrenOk({ added, skipped, rejected, ...(duplicates.length > 0 ? { duplicates } : {}) });
}
