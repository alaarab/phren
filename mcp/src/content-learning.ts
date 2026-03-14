import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { debugLog, appendAuditLog, phrenOk, phrenErr, PhrenError, type PhrenResult } from "./shared.js";
import { normalizeMemoryScope } from "./shared.js";
import { withFileLock } from "./shared-governance.js";
import { isValidProjectName, safeProjectPath, errorMessage } from "./utils.js";
import { getMachineName } from "./machine-identity.js";
import {
  type FindingCitation,
  type FindingProvenanceSource,
  type FindingProvenance,
  buildCitationComment,
  buildSourceComment,
  getHeadCommit,
  getRepoRoot,
  inferCitationLocation,
  isFindingProvenanceSource,
} from "./content-citation.js";
import { isDuplicateFinding, scanForSecrets, normalizeObservationTags, resolveCoref, detectConflicts, extractDynamicEntities } from "./content-dedup.js";
import { validateFindingsFormat, validateFinding } from "./content-validate.js";
import { countActiveFindings, autoArchiveToReference } from "./content-archive.js";
import {
  resolveAutoFindingTaskItem,
  resolveFindingTaskReference,
  resolveFindingSessionId,
} from "./finding-context.js";
import {
  buildLifecycleComments,
  parseFindingLifecycle,
  stripLifecycleComments,
  type FindingLifecycleMetadata,
} from "./finding-lifecycle.js";
import {
  METADATA_REGEX,
} from "./content-metadata.js";

/** Default cap for active findings before auto-archiving is triggered. */
const DEFAULT_FINDINGS_CAP = 20;

interface PreparedFinding {
  original: string;
  normalized: string;
  bullet: string;
  citationComment: string;
  tagWarning?: string;
}

const LIFECYCLE_ANNOTATION_RE = METADATA_REGEX.lifecycleAnnotation;

interface AddFindingOptions {
  extraAnnotations?: string[];
  sessionId?: string;
  source?: FindingProvenanceSource;
  scope?: string;
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

function buildFindingCitation(
  citationInput?: Partial<FindingCitation>,
  nowIso?: string,
  inferredRepo?: string,
  headCommit?: string,
): FindingCitation {
  const citation: FindingCitation = {
    created_at: nowIso ?? new Date().toISOString(),
    repo: citationInput?.repo || inferredRepo,
    file: citationInput?.file,
    line: citationInput?.line,
    commit: citationInput?.commit || (citationInput?.repo || inferredRepo ? headCommit ?? getHeadCommit(citationInput?.repo || inferredRepo || "") : undefined),
    supersedes: citationInput?.supersedes,
    task_item: citationInput?.task_item,
  };
  if (citation.repo && citation.commit && (!citation.file || !citation.line)) {
    const inferred = inferCitationLocation(citation.repo, citation.commit);
    citation.file = citation.file || inferred.file;
    citation.line = citation.line || inferred.line;
  }
  return citation;
}

function resolveInferredCitationRepo(citationInput?: Partial<FindingCitation>): string | undefined {
  if (citationInput?.repo) return citationInput.repo;
  if (citationInput?.file) {
    const fileDir = path.dirname(citationInput.file);
    return getRepoRoot(fileDir);
  }
  return undefined;
}

function detectFindingModel(): string | undefined {
  const candidates = [
    (process.env.PHREN_MODEL),
    process.env.OPENAI_MODEL,
    process.env.CLAUDE_MODEL,
    (process.env.PHREN_LLM_MODEL),
    process.env.MODEL,
  ];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim();
}

function detectFindingTool(): string | undefined {
  const candidates = [
    (process.env.PHREN_TOOL),
    (process.env.PHREN_HOOK_TOOL),
  ];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim();
}

function detectFindingProvenanceSource(explicitSource?: FindingProvenanceSource): FindingProvenanceSource {
  if (explicitSource) return explicitSource;
  const envSource = (process.env.PHREN_FINDING_SOURCE)?.trim().toLowerCase();
  if (isFindingProvenanceSource(envSource)) return envSource;
  if ((process.env.PHREN_CONSOLIDATION) === "1") return "consolidation";
  if ((process.env.PHREN_AUTO_EXTRACT) === "1") return "extract";
  if ((process.env.PHREN_HOOK_TOOL)) return "hook";
  if ((process.env.PHREN_ACTOR || process.env.PHREN_ACTOR)?.trim()) return "agent";
  return "human";
}

function buildFindingSource(sessionId?: string, explicitSource?: FindingProvenanceSource, scope?: string): FindingProvenance {
  const actor = (process.env.PHREN_ACTOR || process.env.PHREN_ACTOR)?.trim() || undefined;
  const source: FindingProvenance = {
    source: detectFindingProvenanceSource(explicitSource),
    machine: getMachineName(),
    actor,
    tool: detectFindingTool(),
    model: detectFindingModel(),
    session_id: sessionId,
    scope: normalizeMemoryScope(scope),
  };
  return source;
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

function prepareFinding(
  learning: string,
  project: string,
  fullHistory: string,
  extraAnnotations?: string[],
  citationInput?: Partial<FindingCitation>,
  source?: FindingProvenance,
  nowIso?: string,
  inferredRepo?: string,
  headCommit?: string,
  phrenPath?: string,
): { status: "added"; finding: PreparedFinding } | { status: "duplicate" } | { status: "rejected"; reason: string } {
  const secretType = scanForSecrets(learning);
  if (secretType) {
    return { status: "rejected", reason: `Contains ${secretType}` };
  }

  const today = (nowIso ?? new Date().toISOString()).slice(0, 10);
  const { text: tagNormalized, warning: tagWarning } = normalizeObservationTags(learning);
  const normalizedLearning = resolveCoref(tagNormalized, {
    project,
    file: citationInput?.file,
  });
  const fid = crypto.randomBytes(4).toString("hex");
  const fidComment = `<!-- fid:${fid} -->`;
  const createdComment = `<!-- created: ${today} -->`;
  const sourceComment = source ? buildSourceComment(source) : "";
  let lifecycle: FindingLifecycleMetadata = { status: "active", status_updated: today };
  let bullet = `${normalizedLearning.startsWith("- ") ? normalizedLearning : `- ${normalizedLearning}`} ${fidComment} ${createdComment}`;
  if (sourceComment) bullet += ` ${sourceComment}`;

  if (isDuplicateFinding(fullHistory, bullet)) {
    return { status: "duplicate" };
  }

  const existingBullets = fullHistory.split("\n").filter((l) => l.startsWith("- "));
  const dynamicEntities = phrenPath ? extractDynamicEntities(phrenPath, project) : undefined;
  const conflicts = detectConflicts(normalizedLearning, existingBullets, dynamicEntities);
  if (conflicts.length > 0) {
    const snippet = conflicts[0].replace(/^-\s+/, "").replace(/<!--.*?-->/g, "").trim().slice(0, 80);
    lifecycle = {
      status: "contradicted",
      status_updated: today,
      status_reason: "conflicts_with",
      status_ref: snippet,
    };
    bullet += ` <!-- conflicts_with: "${snippet}" --> <!-- phren:contradicts "${snippet}" -->`;
    debugLog(`add_finding: conflict detected for "${project}": ${snippet}`);
  }
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

  const citation = buildFindingCitation(citationInput, nowIso, inferredRepo, headCommit);
  return {
    status: "added",
    finding: {
      original: learning,
      normalized: normalizedLearning,
      bullet,
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
  const idx = content.indexOf(todayHeader);
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
  const resolvedDir = safeProjectPath(phrenPath, project);
  if (!resolvedDir || !fs.existsSync(resolvedDir)) return phrenErr(`Project "${project}" not found in phren.`, PhrenError.PROJECT_NOT_FOUND);
  const canonicalPath = path.join(resolvedDir, "truths.md");
  const today = new Date().toISOString().slice(0, 10);
  const bullet = memory.startsWith("- ") ? memory : `- ${memory}`;
  withFileLock(canonicalPath, () => {
    if (!fs.existsSync(canonicalPath)) {
      fs.writeFileSync(canonicalPath, `# ${project} Pinned Findings\n\n## Pinned\n\n${bullet} _(added ${today})_\n`);
    } else {
      const existing = fs.readFileSync(canonicalPath, "utf8");
      const line = `${bullet} _(added ${today})_`;
      if (!existing.includes(bullet)) {
        const updated = existing.includes("## Truths")
          ? existing.replace("## Pinned", `## Pinned\n\n${line}`)
          : `${existing.trimEnd()}\n\n## Pinned\n\n${line}\n`;
        const content = updated.endsWith("\n") ? updated : updated + "\n";
        const tmpPath = canonicalPath + `.tmp-${crypto.randomUUID()}`;
        fs.writeFileSync(tmpPath, content);
        fs.renameSync(tmpPath, canonicalPath);
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
): PhrenResult<string> {
  const findingError = validateFinding(learning);
  if (findingError) return phrenErr(findingError, PhrenError.EMPTY_INPUT);
  if (!isValidProjectName(project)) return phrenErr(`Invalid project name: "${project}".`, PhrenError.INVALID_PROJECT_NAME);
  const resolvedDir = safeProjectPath(phrenPath, project);
  if (!resolvedDir) return phrenErr(`Invalid project name: "${project}".`, PhrenError.INVALID_PROJECT_NAME);
  const learningsPath = path.join(resolvedDir, "FINDINGS.md");

  // Secret/PII scan — reject before anything else (before existence check, before lock)
  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  const resolvedCitationInputResult = resolveFindingCitationInput(phrenPath, project, citationInput);
  if (!resolvedCitationInputResult.ok) return resolvedCitationInputResult;
  const resolvedCitationInput = resolvedCitationInputResult.data;
  const effectiveSessionId = resolveFindingSessionId(phrenPath, project, opts?.sessionId);
  const source = buildFindingSource(effectiveSessionId, opts?.source, opts?.scope);
  const inferredRepo = resolveInferredCitationRepo(resolvedCitationInput);
  const headCommit = inferredRepo ? getHeadCommit(inferredRepo) : undefined;
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
    const preparedForNewFile = prepareFinding(learning, project, "", opts?.extraAnnotations, resolvedCitationInput, source, nowIso, inferredRepo, headCommit, phrenPath);
    if (!fs.existsSync(learningsPath)) {
      if (preparedForNewFile.status === "rejected") {
        return phrenErr(`Rejected: finding appears to contain a secret (${preparedForNewFile.reason.replace(/^Contains /, "")}). Strip credentials before saving.`, PhrenError.VALIDATION_ERROR);
      }
      if (preparedForNewFile.status === "duplicate") {
        return phrenOk(`Skipped duplicate finding for "${project}": already exists with similar wording.`);
      }
      const newContent = `# ${project} Findings\n\n## ${today}\n\n${preparedForNewFile.finding.bullet}\n${preparedForNewFile.finding.citationComment}\n`;
      fs.writeFileSync(learningsPath, newContent);
      return phrenOk({
        content: newContent,
        citation: buildFindingCitation(resolvedCitationInput, nowIso, inferredRepo, headCommit),
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
    const prepared = prepareFinding(learning, project, historyForDedup, opts?.extraAnnotations, resolvedCitationInput, source, nowIso, inferredRepo, headCommit, phrenPath);
    if (prepared.status === "rejected") {
      return phrenErr(`Rejected: finding appears to contain a secret (${prepared.reason.replace(/^Contains /, "")}). Strip credentials before saving.`, PhrenError.VALIDATION_ERROR);
    }
    if (prepared.status === "duplicate") {
      debugLog(`add_finding: skipped duplicate for "${project}": ${learning.slice(0, 80)}`);
      return phrenOk(`Skipped duplicate finding for "${project}": already exists with similar wording.`);
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
          if (!newLines[i].includes("phren:supersedes") && !newLines[i].includes("phren:supersedes")) {
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
    fs.renameSync(tmpPath, learningsPath);
    return phrenOk({
      content: updated,
      citation: buildFindingCitation(resolvedCitationInput, nowIso, inferredRepo, headCommit),
      tagWarning: prepared.finding.tagWarning,
      created: false,
      bullet: prepared.finding.bullet,
    });
  });

  if (!result.ok) return result;
  if (typeof result.data === "string") return phrenOk(result.data);

  appendAuditLog(
    phrenPath,
    "add_finding",
    `project=${project}${result.data.created ? " created=true" : ""} citation_commit=${result.data.citation.commit ?? "none"} citation_file=${result.data.citation.file ?? "none"}`
  );

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
    return phrenOk(result.data.tagWarning ? `${createdMsg} Warning: ${result.data.tagWarning}` : createdMsg);
  }

  const addedMsg = `Added finding to ${project}: ${result.data.bullet} (with citation metadata)`;
  return phrenOk(result.data.tagWarning ? `${addedMsg} Warning: ${result.data.tagWarning}` : addedMsg);
}

export function addFindingsToFile(
  phrenPath: string,
  project: string,
  learnings: string[],
  opts?: { extraAnnotationsByFinding?: string[][]; sessionId?: string; source?: FindingProvenanceSource; scope?: string }
): PhrenResult<{ added: string[]; skipped: string[]; rejected: { text: string; reason: string }[] }> {
  if (!isValidProjectName(project)) return phrenErr(`Invalid project name: "${project}".`, PhrenError.INVALID_PROJECT_NAME);
  const resolvedDir = safeProjectPath(phrenPath, project);
  if (!resolvedDir) return phrenErr(`Invalid project name: "${project}".`, PhrenError.INVALID_PROJECT_NAME);
  const learningsPath = path.join(resolvedDir, "FINDINGS.md");

  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  const resolvedCitationInputResult = resolveFindingCitationInput(phrenPath, project);
  if (!resolvedCitationInputResult.ok) return resolvedCitationInputResult;
  const resolvedCitationInput = resolvedCitationInputResult.data;
  const effectiveSessionId = resolveFindingSessionId(phrenPath, project, opts?.sessionId);
  const source = buildFindingSource(effectiveSessionId, opts?.source, opts?.scope);
  const inferredRepo = resolveInferredCitationRepo(resolvedCitationInput);
  const headCommit = inferredRepo ? getHeadCommit(inferredRepo) : undefined;

  const added: string[] = [];
  const skipped: string[] = [];
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
        const prepared = prepareFinding(learning, project, content, extraAnnotations, resolvedCitationInput, source, nowIso, inferredRepo, headCommit, phrenPath);
        if (prepared.status === "rejected") {
          rejected.push({ text: learning, reason: prepared.reason });
          continue;
        }
        if (prepared.status === "duplicate") {
          skipped.push(learning);
          continue;
        }
        content = insertFindingIntoContent(content, today, prepared.finding.bullet, prepared.finding.citationComment);
        if (prepared.finding.tagWarning) debugLog(`add_findings: ${prepared.finding.tagWarning}`);
        added.push(learning);
      }
      if (added.length > 0) {
        fs.writeFileSync(learningsPath, content.endsWith("\n") ? content : `${content}\n`);
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
      const prepared = prepareFinding(
        learning,
        project,
        content,
        extraAnnotations,
        resolvedCitationInput,
        source,
        nowIso,
        inferredRepo,
        headCommit,
        phrenPath,
      );
      if (prepared.status === "rejected") {
        rejected.push({ text: learning, reason: prepared.reason });
        continue;
      }
      if (prepared.status === "duplicate") {
        skipped.push(learning);
        continue;
      }
      content = insertFindingIntoContent(content, today, prepared.finding.bullet, prepared.finding.citationComment);
      if (prepared.finding.tagWarning) debugLog(`add_findings: ${prepared.finding.tagWarning}`);
      added.push(learning);
    }

    if (added.length > 0) {
      const tmpPath = learningsPath + `.tmp-${crypto.randomUUID()}`;
      fs.writeFileSync(tmpPath, content);
      fs.renameSync(tmpPath, learningsPath);
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

  return phrenOk({ added, skipped, rejected });
}
