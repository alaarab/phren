export const HARNESS_LABELS = { claude: "Claude", codex: "Codex", copilot: "Copilot", phren: "Phren", opencode: "OpenCode" };

export function harnessLabel(source, fallback = source) {
  return HARNESS_LABELS[source] ?? fallback;
}
