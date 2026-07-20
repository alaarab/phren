import type { FindingType, PhrenResult } from "../shared.js";
import { forwardErr, phrenErr, phrenOk, PhrenError } from "../shared.js";
import { addFinding, applyFindingTypePrefix } from "./finding.js";
import { getNote, markNotePromoted, type NoteItem } from "../data/notes.js";

export interface PromoteNoteResult {
  note: NoteItem;
  finding: string;
  message: string;
}

/** Copy a note into durable findings while retaining and marking its daily-note source. */
export function promoteNote(
  phrenPath: string,
  project: string,
  selector: string,
  findingType?: FindingType,
): PhrenResult<PromoteNoteResult> {
  const found = getNote(phrenPath, project, selector);
  if (!found.ok) return forwardErr(found);
  if (found.data.promoted) {
    return phrenErr(`Note ${found.data.id} has already been promoted.`, PhrenError.VALIDATION_ERROR);
  }
  const added = addFinding(phrenPath, project, found.data.text, undefined, findingType);
  if (!added.ok) return phrenErr(added.message, PhrenError.VALIDATION_ERROR);
  const marked = markNotePromoted(phrenPath, project, found.data.stableId);
  if (!marked.ok) return forwardErr(marked);
  const finding = applyFindingTypePrefix(found.data.text, findingType);
  return phrenOk({ note: marked.data, finding, message: added.message });
}
