import { listProfiles } from "../data/access.js";
// ── Shared helpers used across the config sub-modules ──────────────────────────
export function parseProjectArg(args) {
    const project = args.find((a) => a.startsWith("--project="))?.slice("--project=".length)
        ?? (args.indexOf("--project") !== -1 ? args[args.indexOf("--project") + 1] : undefined);
    const rest = args.filter((a, i) => a !== "--project" && !a.startsWith("--project=") && args[i - 1] !== "--project");
    return { project, rest };
}
export function checkProjectInProfile(phrenPath, project) {
    const profiles = listProfiles(phrenPath);
    if (profiles.ok) {
        const registered = profiles.data.some((entry) => entry.projects.includes(project));
        if (!registered) {
            return `Warning: Project '${project}' not found in active profile. Run 'phren add /path/to/${project}' first.\n  Config was written to ${phrenPath}/${project}/phren.project.yaml but won't be used until the project is registered.`;
        }
    }
    return null;
}
export function warnIfUnregistered(phrenPath, project) {
    const warning = checkProjectInProfile(phrenPath, project);
    if (warning)
        console.error(warning);
}
