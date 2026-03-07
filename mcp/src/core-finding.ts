import { isValidProjectName } from "./utils.js";
import {
  addFindingToFile,
  addFindingsToFile,
} from "./shared-content.js";
import {
  removeFinding as removeFindingStore,
} from "./data-access.js";

const MAX_FINDING_LENGTH = 5000;
const MAX_BULK_COUNT = 100;

export interface FindingResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

/**
 * Validate and add a single finding. Shared validation logic used by
 * both CLI `cortex add-finding` and MCP `add_finding` tool.
 */
export function addFinding(
  cortexPath: string,
  project: string,
  finding: string,
  citation?: { file?: string; line?: number; repo?: string; commit?: string; supersedes?: string },
  findingType?: string
): FindingResult {
  if (!isValidProjectName(project)) {
    return { ok: false, message: `Invalid project name: "${project}"` };
  }
  if (finding.length > MAX_FINDING_LENGTH) {
    return { ok: false, message: `Finding text exceeds ${MAX_FINDING_LENGTH} character limit.` };
  }

  const taggedFinding = findingType ? `[${findingType}] ${finding}` : finding;
  const result = addFindingToFile(cortexPath, project, taggedFinding, citation);
  if (!result.ok) {
    return { ok: false, message: result.error };
  }
  return { ok: true, message: result.data, data: { project, finding: taggedFinding } };
}

/**
 * Validate and add multiple findings in bulk.
 */
export function addFindings(
  cortexPath: string,
  project: string,
  findings: string[]
): FindingResult {
  if (!isValidProjectName(project)) {
    return { ok: false, message: `Invalid project name: "${project}"` };
  }
  if (findings.length > MAX_BULK_COUNT) {
    return { ok: false, message: `Bulk add limited to ${MAX_BULK_COUNT} findings per call.` };
  }
  if (findings.some(f => f.length > MAX_FINDING_LENGTH)) {
    return { ok: false, message: `One or more findings exceed ${MAX_FINDING_LENGTH} character limit.` };
  }

  const result = addFindingsToFile(cortexPath, project, findings);
  if (!result.ok) {
    return { ok: false, message: result.error };
  }
  const { added, skipped, rejected } = result.data;
  const rejectedMsg = rejected.length > 0 ? `, ${rejected.length} rejected` : "";
  return {
    ok: added.length > 0,
    message: `Added ${added.length}/${findings.length} findings (${skipped.length} duplicates skipped${rejectedMsg})`,
    data: { project, added, skipped, rejected },
  };
}

/**
 * Remove a finding by partial text match.
 */
export function removeFinding(
  cortexPath: string,
  project: string,
  finding: string
): FindingResult {
  if (!isValidProjectName(project)) {
    return { ok: false, message: `Invalid project name: "${project}"` };
  }
  const result = removeFindingStore(cortexPath, project, finding);
  if (!result.ok) {
    return { ok: false, message: result.error };
  }
  return { ok: true, message: result.data, data: { project, finding } };
}

/**
 * Remove multiple findings by partial text match.
 */
export function removeFindings(
  cortexPath: string,
  project: string,
  findings: string[]
): FindingResult {
  if (!isValidProjectName(project)) {
    return { ok: false, message: `Invalid project name: "${project}"` };
  }
  const results: { finding: string; ok: boolean; message: string }[] = [];
  for (const finding of findings) {
    const result = removeFindingStore(cortexPath, project, finding);
    results.push({ finding, ok: result.ok, message: result.ok ? result.data : result.error ?? "unknown error" });
  }
  const succeeded = results.filter(r => r.ok).length;
  return {
    ok: succeeded > 0,
    message: `Removed ${succeeded}/${findings.length} findings`,
    data: { project, results },
  };
}
