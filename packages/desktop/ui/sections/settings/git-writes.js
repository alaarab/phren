/** Hook-run counts; older Hooks omit the snapshot. Routes are optional because
 * Hook 0.3.47 keeps them internally but does not include them in its response. */
export function formatGitWrites(gitWrites) {
  const label = "Git writes without a repository check: ";
  if (!Array.isArray(gitWrites)) return label + "Hook too old to report";
  if (!gitWrites.length) return label + "none";
  return label + gitWrites.map(({ client, count, routes }) =>
    `${count} from ${client}${Array.isArray(routes) && routes.length ? ` (${routes.join(", ")})` : ""}`
  ).join("; ");
}
