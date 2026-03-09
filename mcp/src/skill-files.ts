import * as fs from "fs";
import * as path from "path";

function normalizeSkillRemovalTarget(skillPath: string): string {
  if (!skillPath) return skillPath;
  if (path.basename(skillPath).toLowerCase() === "skill.md") {
    return path.dirname(skillPath);
  }
  return skillPath;
}

export function removeSkillPath(skillPath: string): string {
  const target = normalizeSkillRemovalTarget(skillPath);
  if (!target || !fs.existsSync(target)) return target;

  const stat = fs.lstatSync(target);
  if (stat.isDirectory()) {
    fs.rmSync(target, { recursive: true, force: true });
  } else {
    fs.unlinkSync(target);
  }
  return target;
}
