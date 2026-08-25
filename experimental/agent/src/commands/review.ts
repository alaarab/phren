/**
 * /review — triage the phren review queue without leaving the session.
 *
 *   /review           list pending items
 *   /review go        per-item triage: [y]approve [n]reject [e]edit [s]skip [q]uit
 *   /review auto      the model proposes verdicts, you confirm in one keypress
 *   /review expire N  reject items older than N days (default from env/14)
 */
import * as readline from "node:readline";
import type { CommandContext } from "../commands.js";
import {
  listQueueItems,
  proposeTriage,
  expireStaleItems,
  resolveExpireDays,
  type QueueStatusItem,
  type TriageProposal,
} from "../memory/review-triage.js";
import { approveQueueItem, rejectQueueItem, editQueueItem } from "@phren/cli/data/access";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function formatItem(item: QueueStatusItem, index: number): string {
  const age = item.ageDays !== null ? `${item.ageDays}d` : "undated";
  const text = item.text.length > 100 ? `${item.text.slice(0, 100)}…` : item.text;
  return `  ${BOLD}${index + 1}.${RESET} ${DIM}[${age}]${RESET} ${text}`;
}

function listItems(items: QueueStatusItem[]): void {
  process.stderr.write(`${BOLD}Review queue (${items.length} pending):${RESET}\n`);
  items.forEach((item, i) => process.stderr.write(formatItem(item, i) + "\n"));
  process.stderr.write(`${DIM}Use /review go (manual), /review auto (model-assisted), /review expire [days].${RESET}\n`);
}

interface TriageCounts { approved: number; rejected: number; edited: number; skipped: number; }

async function triageLoop(
  ctx: CommandContext,
  items: QueueStatusItem[],
  defaults?: Map<string, TriageProposal>,
): Promise<TriageCounts> {
  const counts: TriageCounts = { approved: 0, rejected: 0, edited: 0, skipped: 0 };
  const phrenCtx = ctx.phrenCtx!;
  const project = phrenCtx.project!;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    process.stderr.write("\n" + formatItem(item, i) + "\n");
    const proposal = defaults?.get(item.line);
    let promptSuffix = "[y]approve [n]reject [e]dit [s]kip [q]uit";
    if (proposal) {
      const color = proposal.verdict === "approve" ? GREEN : RED;
      process.stderr.write(`  ${DIM}model suggests:${RESET} ${color}${proposal.verdict}${RESET}${proposal.reason ? ` ${DIM}— ${proposal.reason}${RESET}` : ""}\n`);
      promptSuffix += ` (enter = ${proposal.verdict})`;
    }
    const answer = (await ask(`  ${promptSuffix}: `)).toLowerCase();
    const effective = answer === "" && proposal ? (proposal.verdict === "approve" ? "y" : "n") : answer;

    if (effective === "q") break;
    if (effective === "y") {
      const result = approveQueueItem(phrenCtx.phrenPath, project, item.line);
      if (result.ok) { counts.approved++; process.stderr.write(`  ${GREEN}✓ approved${RESET}\n`); }
      else process.stderr.write(`  ${RED}${result.error}${RESET}\n`);
    } else if (effective === "n") {
      const result = rejectQueueItem(phrenCtx.phrenPath, project, item.line);
      if (result.ok) { counts.rejected++; process.stderr.write(`  ${RED}✗ rejected${RESET}\n`); }
      else process.stderr.write(`  ${RED}${result.error}${RESET}\n`);
    } else if (effective === "e") {
      const newText = await ask("  new text: ");
      if (newText) {
        const result = editQueueItem(phrenCtx.phrenPath, project, item.line, newText);
        if (result.ok) { counts.edited++; process.stderr.write(`  ${YELLOW}✎ edited (still queued)${RESET}\n`); }
        else process.stderr.write(`  ${RED}${result.error}${RESET}\n`);
      }
    } else {
      counts.skipped++;
    }
  }
  return counts;
}

function summarize(counts: TriageCounts): void {
  process.stderr.write(
    `\n${DIM}Triage done: ${GREEN}${counts.approved} approved${RESET}${DIM}, ${RED}${counts.rejected} rejected${RESET}${DIM}, ${counts.edited} edited, ${counts.skipped} skipped.${RESET}\n`,
  );
}

export async function reviewCommand(parts: string[], ctx: CommandContext): Promise<boolean> {
  const sub = parts[1]?.toLowerCase();

  if (!ctx.phrenCtx?.project) {
    process.stderr.write(`${DIM}No phren project context — nothing to review.${RESET}\n`);
    return true;
  }

  if (sub === "expire") {
    const days = Number.parseInt(parts[2] ?? "", 10) || resolveExpireDays();
    const { expired } = expireStaleItems(ctx.phrenCtx, days);
    process.stderr.write(`${DIM}Expired ${expired} item(s) older than ${days} days.${RESET}\n`);
    return true;
  }

  const items = listQueueItems(ctx.phrenCtx);
  if (items.length === 0) {
    process.stderr.write(`${DIM}Review queue is empty. Nothing to triage.${RESET}\n`);
    return true;
  }

  if (sub === undefined) {
    listItems(items);
    return true;
  }

  if (sub === "go") {
    summarize(await triageLoop(ctx, items));
    return true;
  }

  if (sub === "auto") {
    if (!ctx.provider) {
      process.stderr.write(`${DIM}No provider available for auto-triage. Use /review go.${RESET}\n`);
      return true;
    }
    process.stderr.write(`${DIM}Asking the model to triage ${items.length} item(s)…${RESET}\n`);
    const proposals = await proposeTriage(ctx.provider, items);
    if (proposals.length === 0) {
      process.stderr.write(`${DIM}Could not get usable triage proposals. Use /review go.${RESET}\n`);
      return true;
    }

    const approvals = proposals.filter((p) => p.verdict === "approve");
    const rejections = proposals.filter((p) => p.verdict === "reject");
    for (const p of proposals) {
      const color = p.verdict === "approve" ? GREEN : RED;
      const text = p.text.length > 80 ? `${p.text.slice(0, 80)}…` : p.text;
      process.stderr.write(`  ${color}${p.verdict.padEnd(7)}${RESET} ${text}${p.reason ? ` ${DIM}— ${p.reason}${RESET}` : ""}\n`);
    }

    const answer = (await ask(
      `\nApply ${approvals.length} approval(s) and ${rejections.length} rejection(s)? [y/N/i(nteractive)] `,
    )).toLowerCase();

    if (answer === "y" || answer === "yes") {
      const counts: TriageCounts = { approved: 0, rejected: 0, edited: 0, skipped: 0 };
      for (const p of proposals) {
        const apply = p.verdict === "approve" ? approveQueueItem : rejectQueueItem;
        const result = apply(ctx.phrenCtx.phrenPath, ctx.phrenCtx.project, p.line);
        if (result.ok) {
          if (p.verdict === "approve") counts.approved++;
          else counts.rejected++;
        }
      }
      counts.skipped = items.length - counts.approved - counts.rejected;
      summarize(counts);
    } else if (answer === "i") {
      const defaults = new Map(proposals.map((p) => [p.line, p]));
      summarize(await triageLoop(ctx, items, defaults));
    } else {
      process.stderr.write(`${DIM}Nothing applied.${RESET}\n`);
    }
    return true;
  }

  process.stderr.write(`${DIM}Usage: /review [go|auto|expire [days]]${RESET}\n`);
  return true;
}
