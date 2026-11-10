/** A path part that names a repository's `.git` folder on some volume, not
 * only on this one: any letter case, the NTFS short name, the trailing dots
 * and spaces Windows drops, and the code points HFS+ ignores. Git refuses the
 * same spellings in a tree for the same reason. */
export function isGitDirName(part: string): boolean {
  const name = part.replace(/[‌-‏‪-‮⁪-⁯﻿]/g, "").replace(/[. ]+$/, "").toLowerCase();
  return name === ".git" || name === "git~1";
}
