import { isValidProjectName } from "./utils.js";
import {
  addFindingToFile,
} from "./shared-content.js";
import {
  removeFinding as removeFindingStore,
  removeFindings as removeFindingsStore,
} from "./data-access.js";
import { MAX_FINDING_LENGTH } from "./content-validate.js";

export interface FindingResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

/**
 * Validate and add a single finding. Shared validation logic used by
 * both CLI `phren add-finding` and MCP `add_finding` tool.
 */
export function addFinding(
  phrenPath: string,
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
  const result = addFindingToFile(phrenPath, project, taggedFinding, citation);
  if (!result.ok) {
    return { ok: false, message: result.error };
  }
  return { ok: true, message: result.data.message, data: { project, finding: taggedFinding } };
}


/**
 * Remove a finding by partial text match.
 */
export function removeFinding(
  phrenPath: string,
  project: string,
  finding: string
): FindingResult {
  if (!isValidProjectName(project)) {
    return { ok: false, message: `Invalid project name: "${project}"` };
  }
  const result = removeFindingStore(phrenPath, project, finding);
  if (!result.ok) {
    return { ok: false, message: result.error };
  }
  return { ok: true, message: result.data, data: { project, finding } };
}

/**
 * Remove multiple findings by partial text match.
 * Uses a single file lock for the entire batch (not N separate locks).
 */
export function removeFindings(
  phrenPath: string,
  project: string,
  findings: string[]
): FindingResult {
  if (!isValidProjectName(project)) {
    return { ok: false, message: `Invalid project name: "${project}"` };
  }
  const result = removeFindingsStore(phrenPath, project, findings);
  if (!result.ok) {
    return { ok: false, message: result.error };
  }
  const { removed, errors } = result.data;
  const results = [
    ...removed.map(r => ({ finding: r, ok: true, message: `Removed from ${project}: ${r}` })),
    ...errors.map(e => ({ finding: e, ok: false, message: `No match or error for "${e}"` })),
  ];
  return {
    ok: removed.length > 0,
    message: `Removed ${removed.length}/${findings.length} findings`,
    data: { project, results },
  };
}
