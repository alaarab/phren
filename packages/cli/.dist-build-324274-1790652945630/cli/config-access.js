import { getPhrenPath } from "../shared.js";
import { buildConfigView } from "../config/resolve.js";
import { isValidProjectName } from "../utils.js";
import { ACCESS_ROLE_KEYS, ACL_LOCKOUT_HINT, permissionDeniedError, setAccessRoles } from "../governance/rbac.js";
import { parseProjectArg, warnIfUnregistered } from "./config-shared.js";
// ── Access control ───────────────────────────────────────────────────────────
function parseRoleList(raw) {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function printAccessSnapshot(phrenPath, projectArg) {
    const view = buildConfigView(phrenPath, projectArg);
    console.log(JSON.stringify({
        _project: projectArg ?? null,
        _note: "Effective lists are the union of global and per-project roles. All lists empty everywhere = open mode.",
        admins: view.fields["access.admins"].value,
        contributors: view.fields["access.contributors"].value,
        readers: view.fields["access.readers"].value,
    }, null, 2));
}
export function handleConfigAccess(args) {
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
        const patch = {};
        let touched = false;
        for (const arg of rest.slice(1)) {
            if (!arg.startsWith("--"))
                continue;
            const [k, v] = arg.slice(2).split("=");
            if (!k || v === undefined)
                continue;
            if (ACCESS_ROLE_KEYS.includes(k)) {
                patch[k] = parseRoleList(v);
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
        // Rewriting the ACL is admin-only. Open mode (no ACL configured anywhere)
        // is still permitted, so the first `phren config access set` bootstraps.
        const denied = permissionDeniedError(phrenPath, "manage_config", projectArg);
        if (denied) {
            console.error(`${denied} ${ACL_LOCKOUT_HINT}`);
            process.exit(1);
        }
        setAccessRoles(phrenPath, patch, projectArg);
        printAccessSnapshot(phrenPath, projectArg);
        return;
    }
    console.error("Usage: phren config access [--project <name>] [get|set --admins=a,b --contributors=c --readers=d]");
    process.exit(1);
}
