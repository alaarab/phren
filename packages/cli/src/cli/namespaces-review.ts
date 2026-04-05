import { isValidProjectName } from "../utils.js";
import { getPhrenPath } from "../shared.js";

export async function handleReviewNamespace(args: string[]) {
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log("Usage:");
    console.log("  phren review [project]                       Show review queue items");
    console.log("  phren review approve <project> <text>        Approve and remove item");
    console.log("  phren review reject <project> <text>         Reject and remove item");
    console.log("");
    console.log("Examples:");
    console.log('  phren review myproject');
    console.log('  phren review approve myproject "Always validate input"');
    console.log('  phren review reject myproject "Avoid async in loops"');
    return;
  }

  // Handle "approve" and "reject" subcommands
  if (subcommand === "approve" || subcommand === "reject") {
    const action = subcommand;
    const project = args[1];
    const lineText = args.slice(2).join(" ");

    if (!project || !lineText) {
      console.error(`Usage: phren review ${action} <project> <text>`);
      process.exit(1);
    }

    if (!isValidProjectName(project)) {
      console.error(`Invalid project name: "${project}".`);
      process.exit(1);
    }

    const phrenPath = getPhrenPath();
    const { approveQueueItem, rejectQueueItem } = await import("../data/access.js");

    const result = action === "approve"
      ? approveQueueItem(phrenPath, project, lineText)
      : rejectQueueItem(phrenPath, project, lineText);

    if (!result.ok) {
      console.error(`Failed to ${action} item: ${result.error ?? "Unknown error"}`);
      process.exit(1);
    }

    console.log(`${action === "approve" ? "✓ Approved" : "✗ Rejected"}: ${lineText.slice(0, 100)}${lineText.length > 100 ? "..." : ""}`);
    return;
  }

  // Default: show review queue (first arg is project name if not a subcommand)
  const { handleReview } = await import("./actions.js");
  return handleReview(args);
}
