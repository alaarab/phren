import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import { debugLog, appendAuditLog, cortexOk, cortexErr, CortexError, type CortexResult } from "./shared.js";
import { checkPermission, loadCanonicalLocks, saveCanonicalLocksUnlocked, hashContent, withFileLock } from "./shared-governance.js";
import { isValidProjectName, safeProjectPath, errorMessage } from "./utils.js";
import { type FindingCitation, buildCitationComment, getHeadCommit, getRepoRoot, inferCitationLocation } from "./content-citation.js";
import { isDuplicateFinding, scanForSecrets, normalizeObservationTags, resolveCoref, detectConflicts } from "./content-dedup.js";
import { validateFindingsFormat, validateFinding } from "./content-validate.js";
import { countActiveFindings, autoArchiveToReference } from "./content-archive.js";

/** Default cap for active findings before auto-archiving is triggered. */
const DEFAULT_FINDINGS_CAP = 20;

// Read legacy history files (LEARNINGS.md, etc.) as supplementary dedup/conflict context.
// Never written to — used only as a read-only baseline when FINDINGS.md is being created or updated.
function readLegacyHistoryContent(resolvedDir: string): string {
  const available = new Set(fs.readdirSync(resolvedDir).map(f => f.toLowerCase()));
  const parts: string[] = [];
  for (const name of LEGACY_FINDINGS_CANDIDATES) {
    if (available.has(name.toLowerCase())) {
      try { parts.push(fs.readFileSync(path.join(resolvedDir, name), "utf8")); } catch (err: unknown) {
        if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] readLegacyHistoryContent fileRead: ${errorMessage(err)}\n`);
      }
    }
  }
  return parts.join("\n");
}

const LEGACY_FINDINGS_CANDIDATES = [
  "LEARNINGS.md",
  "learnings.md",
  "LESSONS.md",
  "lessons.md",
  "POSTMORTEM.md",
  "postmortem.md",
  "RETRO.md",
  "retro.md",
];

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
  skipLegacyDedup?: boolean;
  extraAnnotations?: string[];
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
  };
  if (citation.repo && citation.commit && (!citation.file || !citation.line)) {
    const inferred = inferCitationLocation(citation.repo, citation.commit);
    citation.file = citation.file || inferred.file;
    citation.line = citation.line || inferred.line;
  }
  return citation;
}

function prepareFinding(
  learning: string,
  project: string,
  fullHistory: string,
  extraAnnotations?: string[],
  citationInput?: Partial<FindingCitation>,
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
  const hostname = os.hostname();
  const model = process.env.CLAUDE_MODEL || "unknown";
  let bullet = `${normalizedLearning.startsWith("- ") ? normalizedLearning : `- ${normalizedLearning}`} <!-- created: ${today} --> <!-- source: machine:${hostname} model:${model} -->`;

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

export function migrateLegacyFindings(
  cortexPath: string,
  project: string,
  opts: { pinCanonical?: boolean; dryRun?: boolean } = {}
): CortexResult<string> {
  const denial = checkPermission(cortexPath, "write");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  if (!isValidProjectName(project)) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir || !fs.existsSync(resolvedDir)) return cortexErr(`Project "${project}" not found in cortex.`, CortexError.PROJECT_NOT_FOUND);

  const available = new Map(
    fs.readdirSync(resolvedDir).map((name) => [name.toLowerCase(), name] as const)
  );
  const files = LEGACY_FINDINGS_CANDIDATES
    .map((name) => available.get(name.toLowerCase()))
    .filter((name): name is string => Boolean(name));
  if (!files.length) return cortexErr(`No legacy findings docs found for "${project}".`, CortexError.FILE_NOT_FOUND);

  const seen = new Set<string>();
  const extracted: Array<{ text: string; file: string; line: number }> = [];

  for (const file of files) {
    const fullPath = path.join(resolvedDir, file);
    const lines = fs.readFileSync(fullPath, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.match(/^\s*(?:[-*]\s+|\d+\.\s+)/)) continue;
      const bullet = normalizeMigratedBullet(line);
      if (!bullet) continue;
      const key = bullet.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      extracted.push({ text: bullet, file, line: i + 1 });
    }
  }

  if (!extracted.length) {
    return cortexOk(`Legacy findings docs found for "${project}", but no actionable bullet entries were detected.`);
  }

  if (opts.dryRun) {
    return cortexOk(`Found ${extracted.length} migratable findings in ${files.length} file(s) for "${project}".`);
  }

  let migrated = 0;
  let skipped = 0;
  const errors: string[] = [];
  let pinned = 0;
  for (const entry of extracted) {
    const learning = `${entry.text} (migrated from ${entry.file})`;
    try {
      const result = addFindingToFile(cortexPath, project, learning, {
        repo: resolvedDir,
        file: path.join(resolvedDir, entry.file),
        line: entry.line,
      }, { skipLegacyDedup: true });
      if (!result.ok) {
        errors.push(result.error ?? `Failed to migrate "${entry.text}"`);
        continue;
      }
      if (result.data.startsWith("Skipped duplicate")) {
        skipped++;
        continue;
      }
      migrated++;
    } catch (err) {
      errors.push(errorMessage(err));
      continue;
    }

    if (opts.pinCanonical && shouldPinCanonical(entry.text)) {
      upsertCanonical(cortexPath, project, entry.text);
      pinned++;
    }
  }

  appendAuditLog(
    cortexPath,
    "migrate_findings",
    `project=${project} files=${files.length} migrated=${migrated} skipped=${skipped} pinned=${pinned} errors=${errors.length}`
  );
  const skippedMsg = skipped > 0 ? `; skipped ${skipped} duplicate findings` : "";
  const errorsMsg = errors.length > 0 ? `; ${errors.length} migration error(s)` : "";
  return cortexOk(`Migrated ${migrated} findings for "${project}" from ${files.length} legacy file(s)${skippedMsg}${opts.pinCanonical ? `; pinned ${pinned} canonical memories` : ""}${errorsMsg}.`);
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
    const canonicalLocksPath = path.join(cortexPath, ".governance", "canonical-locks.json");
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
  const inferredRepo = citationInput?.repo || getRepoRoot(resolvedDir);
  const headCommit = inferredRepo ? getHeadCommit(inferredRepo) : undefined;
  const supersedesText = citationInput?.supersedes;
  const normalizedForSupersedes = supersedesText
    ? resolveCoref(normalizeObservationTags(learning).text, {
        project,
        file: citationInput?.file,
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
    const preparedForNewFile = prepareFinding(learning, project, "", opts?.extraAnnotations, citationInput, nowIso, inferredRepo, headCommit);
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
        citation: buildFindingCitation(citationInput, nowIso, inferredRepo, headCommit),
        tagWarning: preparedForNewFile.finding.tagWarning,
        created: true,
        bullet: preparedForNewFile.finding.bullet,
      });
    }

    const content = fs.readFileSync(learningsPath, "utf8");
    const legacyHistory = opts?.skipLegacyDedup ? "" : readLegacyHistoryContent(resolvedDir);
    // When superseding, strip the old finding from history so dedup doesn't block the intentionally similar replacement.
    // Skip the strip if new finding is identical to the superseded one (self-supersession should still be blocked by dedup).
    const isSelfSupersession = supersedesText &&
      learning.trim().toLowerCase().slice(0, 60) === supersedesText.trim().toLowerCase().slice(0, 60);
    const historyForDedup = (supersedesText && !isSelfSupersession)
      ? (legacyHistory ? `${content}\n${legacyHistory}` : content)
          .split("\n")
          .filter(line => !line.startsWith("- ") || !line.toLowerCase().includes(supersedesText.slice(0, 40).toLowerCase()))
          .join("\n")
      : (legacyHistory ? `${content}\n${legacyHistory}` : content);
    const fullHistory = legacyHistory ? `${content}\n${legacyHistory}` : content;

    const prepared = prepareFinding(learning, project, historyForDedup, opts?.extraAnnotations, citationInput, nowIso, inferredRepo, headCommit);
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
      citation: buildFindingCitation(citationInput, nowIso, inferredRepo, headCommit),
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

  const CONSOLIDATION_CAP = Number.parseInt(process.env.CORTEX_CONSOLIDATION_CAP || "", 10) || 150;
  let consolidationNotice = "";
  if (activeCount > CONSOLIDATION_CAP) {
    debugLog(`Consolidation cap exceeded for "${project}": ${activeCount} active findings (cap=${CONSOLIDATION_CAP})`);
    try {
      const runtimeDir = path.join(cortexPath, ".runtime");
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(path.join(runtimeDir, "consolidation-needed.txt"), `${project}\n`);
    } catch (err: unknown) {
      if (process.env.CORTEX_DEBUG) process.stderr.write(`[cortex] addFinding consolidationMarker: ${errorMessage(err)}\n`);
    }
    consolidationNotice = ` Note: ${activeCount} active findings exceeds consolidation cap (${CONSOLIDATION_CAP}). Consider running consolidation.`;
  }

  if (result.data.created) {
    const createdMsg = `Created FINDINGS.md for "${project}" and added insight.`;
    return cortexOk(result.data.tagWarning ? `${createdMsg} Warning: ${result.data.tagWarning}` : createdMsg);
  }

  const addedMsg = `Added finding to ${project}: ${result.data.bullet} (with citation metadata)`;
  const fullMsg = result.data.tagWarning ? `${addedMsg} Warning: ${result.data.tagWarning}` : addedMsg;
  return cortexOk(consolidationNotice ? `${fullMsg}${consolidationNotice}` : fullMsg);
}

export function addFindingsToFile(
  cortexPath: string,
  project: string,
  learnings: string[],
  opts?: { extraAnnotationsByFinding?: string[][] }
): CortexResult<{ added: string[]; skipped: string[]; rejected: { text: string; reason: string }[] }> {
  const denial = checkPermission(cortexPath, "write");
  if (denial) return cortexErr(denial, CortexError.PERMISSION_DENIED);
  if (!isValidProjectName(project)) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const resolvedDir = safeProjectPath(cortexPath, project);
  if (!resolvedDir) return cortexErr(`Invalid project name: "${project}".`, CortexError.INVALID_PROJECT_NAME);
  const learningsPath = path.join(resolvedDir, "FINDINGS.md");

  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  const inferredRepo = getRepoRoot(resolvedDir);
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
        const prepared = prepareFinding(learning, project, content, extraAnnotations, undefined, nowIso, inferredRepo, headCommit);
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
    const legacyHistory = readLegacyHistoryContent(resolvedDir);
    const issues = validateFindingsFormat(content);
    if (issues.length > 0) debugLog(`FINDINGS.md format warnings for "${project}": ${issues.join("; ")}`);

    for (const [index, learning] of learnings.entries()) {
      const extraAnnotations = opts?.extraAnnotationsByFinding?.[index];
      const lengthError = validateFinding(learning);
      if (lengthError) {
        rejected.push({ text: learning, reason: lengthError });
        continue;
      }
      const fullHistory = legacyHistory ? `${content}\n${legacyHistory}` : content;
      const prepared = prepareFinding(learning, project, fullHistory, extraAnnotations, undefined, nowIso, inferredRepo, headCommit);
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
