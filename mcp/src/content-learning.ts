import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { debugLog, appendAuditLog, cortexOk, cortexErr, CortexError, type CortexResult } from "./shared.js";
import { checkPermission, loadCanonicalLocks, saveCanonicalLocksUnlocked, hashContent, withFileLock } from "./shared-governance.js";
import { isValidProjectName, safeProjectPath, errorMessage } from "./utils.js";
import { getMachineName } from "./machine-identity.js";
import {
  type FindingCitation,
  type FindingSource,
  buildCitationComment,
  buildSourceComment,
  getHeadCommit,
  getRepoRoot,
  inferCitationLocation,
} from "./content-citation.js";
import { isDuplicateFinding, scanForSecrets, normalizeObservationTags, resolveCoref, detectConflicts } from "./content-dedup.js";
import { validateFindingsFormat, validateFinding } from "./content-validate.js";
import { countActiveFindings, autoArchiveToReference } from "./content-archive.js";
import {
  resolveAutoFindingBacklogItem,
  resolveFindingBacklogReference,
  resolveFindingSessionId,
} from "./finding-context.js";

/** Default cap for active findings before auto-archiving is triggered. */
const DEFAULT_FINDINGS_CAP = 20;

function normalizeMigratedBullet(raw: string): string {
  const cleaned = raw
    .replace(/^\s*[-*]\s*/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .replace(/^\d+\.\s*/, "")
    .trim();
  return cleaned;
}

function shouldPinCanonical(text: string): boolean {
  return /(must|always|never|avoid|required|critical|do not|don't)\b/i.test(text);
}

interface PreparedFinding {
  original: string;
  normalized: string;
  bullet: string;
  citationComment: string;
  tagWarning?: string;
}

interface AddFindingOptions {
  extraAnnotations?: string[];
  sessionId?: string;
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
    backlog_item: citationInput?.backlog_item,
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
    process.env.CORTEX_MODEL,
    process.env.OPENAI_MODEL,
    process.env.CLAUDE_MODEL,
    process.env.CORTEX_LLM_MODEL,
    process.env.MODEL,
  ];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim();
}

function detectFindingTool(): string | undefined {
  const candidates = [
    process.env.CORTEX_TOOL,
    process.env.CORTEX_HOOK_TOOL,
  ];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim();
}

function buildFindingSource(sessionId?: string): FindingSource {
  const actor = process.env.CORTEX_ACTOR?.trim() || undefined;
  const source: FindingSource = {
    machine: getMachineName(),
    actor,
    tool: detectFindingTool(),
    model: detectFindingModel(),
    session_id: sessionId,
  };
  return source;
}

function resolveFindingCitationInput(
  cortexPath: string,
  project: string,
  citationInput?: Partial<FindingCitation>,
): CortexResult<Partial<FindingCitation> | undefined> {
  const resolved = citationInput ? { ...citationInput } : {};
  if (citationInput?.backlog_item) {
    const backlogResolution = resolveFindingBacklogReference(cortexPath, project, citationInput.backlog_item);
    if (backlogResolution.error) {
      return cortexErr(backlogResolution.error, CortexError.VALIDATION_ERROR);
    }
    if (backlogResolution.stableId) {
      resolved.backlog_item = backlogResolution.stableId;
    }
  } else {
    const backlogItem = resolveAutoFindingBacklogItem(cortexPath, project);
    if (backlogItem) {
      resolved.backlog_item = backlogItem;
    }
  }

  return cortexOk(Object.keys(resolved).length > 0 ? resolved : undefined);
}

function prepareFinding(
  learning: string,
  project: string,
  fullHistory: string,
  extraAnnotations?: string[],
  citationInput?: Partial<FindingCitation>,
  source?: FindingSource,
  nowIso?: string,
  inferredRepo?: string,
  headCommit?: string,
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
  let bullet = `${normalizedLearning.startsWith("- ") ? normalizedLearning : `- ${normalizedLearning}`} ${fidComment} ${createdComment}`;
  if (sourceComment) bullet += ` ${sourceComment}`;

  if (isDuplicateFinding(fullHistory, bullet)) {
    return { status: "duplicate" };
  }

  const existingBullets = fullHistory.split("\n").filter((l) => l.startsWith("- "));
  const conflicts = detectConflicts(normalizedLearning, existingBullets);
  if (conflicts.length > 0) {
    const snippet = conflicts[0].replace(/^-\s+/, "").replace(/<!--.*?-->/g, "").trim().slice(0, 80);
    bullet += ` <!-- conflicts_with: "${snippet}" -->`;
    debugLog(`add_finding: conflict detected for "${project}": ${snippet}`);
  }
  if (extraAnnotations && extraAnnotations.length > 0) {
    const existing = new Set(
      [...bullet.matchAll(/<!--\s*conflicts_with:\s*"([^"]+)"(?:\s*\(from project: [^)]+\))?\s*-->/g)].map((m) => m[0])
    );
    for (const annotation of extraAnnotations) {
      if (!annotation.startsWith("<!--")) continue;
      if (existing.has(annotation)) continue;
      bullet += ` ${annotation}`;
      existing.add(annotation);
    }
  }

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

export function upsertCanonical(cortexPath: string, project: string, memory: string): CortexResult<string> {
  const denial = checkPermission(cortexPath, "pin");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  if (!isValidProjectName(project)) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir || !fs.existsSync(resolvedDir)) return cortexErr(`Project "${project}" not found in cortex.`, CortexError.PROJECT_NOT_FOUND);
  const canonicalPath = path.join(resolvedDir, "CANONICAL_MEMORIES.md");
  const today = new Date().toISOString().slice(0, 10);
  const bullet = memory.startsWith("- ") ? memory : `- ${memory}`;
  withFileLock(canonicalPath, () => {
    let canonicalContent: string;
    if (!fs.existsSync(canonicalPath)) {
      canonicalContent = `# ${project} Canonical Memories\n\n## Pinned\n\n${bullet} _(pinned ${today})_\n`;
      fs.writeFileSync(canonicalPath, canonicalContent);
    } else {
      const existing = fs.readFileSync(canonicalPath, "utf8");
      const line = `${bullet} _(pinned ${today})_`;
      if (!existing.includes(bullet)) {
        const updated = existing.includes("## Pinned")
          ? existing.replace("## Pinned", `## Pinned\n\n${line}`)
          : `${existing.trimEnd()}\n\n## Pinned\n\n${line}\n`;
        canonicalContent = updated.endsWith("\n") ? updated : updated + "\n";
        const tmpPath = canonicalPath + `.tmp-${crypto.randomUUID()}`;
        fs.writeFileSync(tmpPath, canonicalContent);
        fs.renameSync(tmpPath, canonicalPath);
      } else {
        canonicalContent = existing;
      }
    }

    // Wrap canonical-locks.json read-modify-write in its own file lock to prevent
    // concurrent upserts for different projects from overwriting each other's entries.
    // We call loadCanonicalLocks (unlocked read) + saveCanonicalLocksUnlocked inside
    // withFileLock to avoid deadlocking with saveCanonicalLocks' internal lock.
    const canonicalLocksPath = path.join(cortexPath, ".runtime", "canonical-locks.json");
    withFileLock(canonicalLocksPath, () => {
      const locks = loadCanonicalLocks(cortexPath);
      const lockKey = `${project}/CANONICAL_MEMORIES.md`;
      locks[lockKey] = {
        hash: hashContent(canonicalContent),
        snapshot: canonicalContent,
        updatedAt: new Date().toISOString(),
      };
      saveCanonicalLocksUnlocked(cortexPath, locks);
    });
  });

  appendAuditLog(cortexPath, "pin_memory", `project=${project} memory=${JSON.stringify(memory)}`);
  return cortexOk(`Pinned canonical memory in ${project}.`);
}

export function addFindingToFile(
  cortexPath: string,
  project: string,
  learning: string,
  citationInput?: Partial<FindingCitation>,
  opts?: AddFindingOptions
): CortexResult<string> {
  const denial = checkPermission(cortexPath, "write");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  const findingError = validateFinding(learning);
  if (findingError) return cortexErr(findingError, CortexError.EMPTY_INPUT);
  if (!isValidProjectName(project)) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const learningsPath = path.join(resolvedDir, "FINDINGS.md");

  // Secret/PII scan — reject before anything else (before existence check, before lock)
  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  const resolvedCitationInputResult = resolveFindingCitationInput(cortexPath, project, citationInput);
  if (!resolvedCitationInputResult.ok) return resolvedCitationInputResult;
  const resolvedCitationInput = resolvedCitationInputResult.data;
  const effectiveSessionId = resolveFindingSessionId(cortexPath, project, opts?.sessionId);
  const source = buildFindingSource(effectiveSessionId);
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
    return cortexErr(`Rejected: finding appears to contain a secret (${earlySecretType}). Strip credentials before saving.`, CortexError.VALIDATION_ERROR);
  }
  // Check project dir existence before withFileLock (which would create the dir via mkdirSync)
  if (!fs.existsSync(resolvedDir)) return cortexErr(`Project "${project}" does not exist.`, CortexError.INVALID_PROJECT_NAME);

  const result: CortexResult<AddFindingWriteResult | string> = withFileLock(learningsPath, () => {
    const preparedForNewFile = prepareFinding(learning, project, "", opts?.extraAnnotations, resolvedCitationInput, source, nowIso, inferredRepo, headCommit);
    if (!fs.existsSync(learningsPath)) {
      if (preparedForNewFile.status === "rejected") {
        return cortexErr(`Rejected: finding appears to contain a secret (${preparedForNewFile.reason.replace(/^Contains /, "")}). Strip credentials before saving.`, CortexError.VALIDATION_ERROR);
      }
      if (preparedForNewFile.status === "duplicate") {
        return cortexOk(`Skipped duplicate finding for "${project}": already exists with similar wording.`);
      }
      const newContent = `# ${project} Findings\n\n## ${today}\n\n${preparedForNewFile.finding.bullet}\n${preparedForNewFile.finding.citationComment}\n`;
      fs.writeFileSync(learningsPath, newContent);
      return cortexOk({
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
    const prepared = prepareFinding(learning, project, historyForDedup, opts?.extraAnnotations, resolvedCitationInput, source, nowIso, inferredRepo, headCommit);
    if (prepared.status === "rejected") {
      return cortexErr(`Rejected: finding appears to contain a secret (${prepared.reason.replace(/^Contains /, "")}). Strip credentials before saving.`, CortexError.VALIDATION_ERROR);
    }
    if (prepared.status === "duplicate") {
      debugLog(`add_finding: skipped duplicate for "${project}": ${learning.slice(0, 80)}`);
      return cortexOk(`Skipped duplicate finding for "${project}": already exists with similar wording.`);
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
          const newFirst60 = normalizedForSupersedes.replace(/^-\s+/, "").slice(0, 60);
          lines[i] = `${lines[i]} <!-- superseded_by: ${newFirst60} -->`;
          updated = lines.join("\n");
          break;
        }
      }
    }

    const tmpPath = learningsPath + `.tmp-${crypto.randomUUID()}`;
    fs.writeFileSync(tmpPath, updated);
    fs.renameSync(tmpPath, learningsPath);
    return cortexOk({
      content: updated,
      citation: buildFindingCitation(resolvedCitationInput, nowIso, inferredRepo, headCommit),
      tagWarning: prepared.finding.tagWarning,
      created: false,
      bullet: prepared.finding.bullet,
    });
  });

  if (!result.ok) return result;
  if (typeof result.data === "string") return cortexOk(result.data);

  appendAuditLog(
    cortexPath,
    "add_finding",
    `project=${project}${result.data.created ? " created=true" : ""} citation_commit=${result.data.citation.commit ?? "none"} citation_file=${result.data.citation.file ?? "none"}`
  );

  const cap = Number.parseInt(process.env.CORTEX_FINDINGS_CAP || "", 10) || DEFAULT_FINDINGS_CAP;
  const activeCount = countActiveFindings(result.data.content);
  if (activeCount > cap) {
    const archiveResult = autoArchiveToReference(cortexPath, project, cap);
    if (archiveResult.ok && archiveResult.data > 0) {
      debugLog(`Size cap: archived ${archiveResult.data} oldest entries for "${project}" (cap=${cap})`);
    }
  }

  if (result.data.created) {
    const createdMsg = `Created FINDINGS.md for "${project}" and added insight.`;
    return cortexOk(result.data.tagWarning ? `${createdMsg} Warning: ${result.data.tagWarning}` : createdMsg);
  }

  const addedMsg = `Added finding to ${project}: ${result.data.bullet} (with citation metadata)`;
  return cortexOk(result.data.tagWarning ? `${addedMsg} Warning: ${result.data.tagWarning}` : addedMsg);
}

export function addFindingsToFile(
  cortexPath: string,
  project: string,
  learnings: string[],
  opts?: { extraAnnotationsByFinding?: string[][]; sessionId?: string }
): CortexResult<{ added: string[]; skipped: string[]; rejected: { text: string; reason: string }[] }> {
  const denial = checkPermission(cortexPath, "write");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  if (!isValidProjectName(project)) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const learningsPath = path.join(resolvedDir, "FINDINGS.md");

  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  const resolvedCitationInputResult = resolveFindingCitationInput(cortexPath, project);
  if (!resolvedCitationInputResult.ok) return resolvedCitationInputResult;
  const resolvedCitationInput = resolvedCitationInputResult.data;
  const effectiveSessionId = resolveFindingSessionId(cortexPath, project, opts?.sessionId);
  const source = buildFindingSource(effectiveSessionId);
  const inferredRepo = resolveInferredCitationRepo(resolvedCitationInput);
  const headCommit = inferredRepo ? getHeadCommit(inferredRepo) : undefined;

  const added: string[] = [];
  const skipped: string[] = [];
  const rejected: { text: string; reason: string }[] = [];

  // Check project dir existence before withFileLock (which would create the dir via mkdirSync)
  if (!fs.existsSync(resolvedDir)) return cortexErr(`Project "${project}" not found in cortex.`, CortexError.PROJECT_NOT_FOUND);

  const contentResult: CortexResult<AddFindingsWriteResult> = withFileLock(learningsPath, () => {
    if (!fs.existsSync(learningsPath)) {
      let content = `# ${project} Findings\n\n## ${today}\n`;
      for (const [index, learning] of learnings.entries()) {
        const extraAnnotations = opts?.extraAnnotationsByFinding?.[index];
        const lengthError = validateFinding(learning);
        if (lengthError) {
          rejected.push({ text: learning, reason: lengthError });
          continue;
        }
        const prepared = prepareFinding(learning, project, content, extraAnnotations, resolvedCitationInput, source, nowIso, inferredRepo, headCommit);
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
      return cortexOk({ content, wrote: added.length > 0 });
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

    return cortexOk({ content, wrote: added.length > 0 });
  });

  if (!contentResult.ok) return contentResult;

  if (contentResult.data.wrote) {
    appendAuditLog(cortexPath, "add_finding", `project=${project} count=${added.length} batch=true`);

    const cap = Number.parseInt(process.env.CORTEX_FINDINGS_CAP || "", 10) || DEFAULT_FINDINGS_CAP;
    if (countActiveFindings(contentResult.data.content) > cap) {
      const archiveResult = autoArchiveToReference(cortexPath, project, cap);
      if (archiveResult.ok && archiveResult.data > 0) {
        debugLog(`Size cap: archived ${archiveResult.data} oldest entries for "${project}" (cap=${cap})`);
      }
    }
  }

  return cortexOk({ added, skipped, rejected });
}
