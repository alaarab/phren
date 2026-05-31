import { getPhrenPath } from "../shared.js";
import { buildConfigView } from "../config/resolve.js";
import { isValidProjectName } from "../utils.js";
import { ACCESS_ROLE_KEYS, setAccessRoles, type AccessRolePatch } from "../governance/rbac.js";
import { parseProjectArg, warnIfUnregistered } from "./config-shared.js";

// ── Access control ───────────────────────────────────────────────────────────

function parseRoleList(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function printAccessSnapshot(phrenPath: string, projectArg: string | undefined): void {
  const view = buildConfigView(phrenPath, projectArg);
  console.log(JSON.stringify({
    _project: projectArg ?? null,
    _note: "Effective lists are the union of global and per-project roles. All lists empty everywhere = open mode.",
    admins: view.fields["access.admins"].value,
    contributors: view.fields["access.contributors"].value,
    readers: view.fields["access.readers"].value,
  }, null, 2));
}

export function handleConfigAccess(args: string[]) {
  const phrenPath = getPhrenPath();
  const { project: projectArg, rest } = parseProjectArg(args);
  const action = rest[0];

  if (projectArg && !isValidProjectName(projectArg)) {
    console.error(`Invalid project name: "${projectArg}"`);
    process.exit(1);
  }

  if (!action || action === "get") {
    printAccessSnapshot(phrenPath, projectArg);
    return;
  }

  if (action === "set") {
    const patch: AccessRolePatch = {};
    let touched = false;
    for (const arg of rest.slice(1)) {
      if (!arg.startsWith("--")) continue;
      const [k, v] = arg.slice(2).split("=");
      if (!k || v === undefined) continue;
      if ((ACCESS_ROLE_KEYS as readonly string[]).includes(k)) {
        patch[k as keyof AccessRolePatch] = parseRoleList(v);
        touched = true;
      }
    }
    if (!touched) {
      console.error("Usage: phren config access [--project <name>] set --admins=a,b --contributors=c --readers=d");
      process.exit(1);
    }
    if (projectArg) {
      warnIfUnregistered(phrenPath, projectArg);
    }
    setAccessRoles(phrenPath, patch, projectArg);
    printAccessSnapshot(phrenPath, projectArg);
    return;
  }

  console.error("Usage: phren config access [--project <name>] [get|set --admins=a,b --contributors=c --readers=d]");
  process.exit(1);
}
