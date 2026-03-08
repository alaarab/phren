import { isValidProjectName } from "./utils.js";
import {
  addFindingToFile,
} from "./shared-content.js";
import {
  removeFinding as removeFindingStore,
} from "./data-access.js";
import { MAX_FINDING_LENGTH } from "./content-validate.js";

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
