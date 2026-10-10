// Every answer the owner can give an agent, through the desktop daemon's Hook
// proxy. One function per channel; the cards call these and nothing else.

import { hookPost } from "../api.js";

/** The Hook's decision for an approval: the phone's two-axis answer becomes
 * its one string. Deny always wins; otherwise the scope names the grant. */
export function approvalDecision(decision, scope = "once") {
  if (String(decision).toLowerCase() === "deny") return "deny";
  if (scope === "project") return "allow-project";
  if (scope === "everywhere") return "allow-everywhere";
  return "approve";
}

/** Answer a held approval. `updatedInput` carries a Claude AskUserQuestion's
 * answers: the request's own input plus an `answers` object. */
export async function answerApproval(computer, target, { actionId, decision, scope = "once", updatedInput } = {}) {
  return hookPost(computer, "/v1/approvals/answer", {
    target,
    actionId,
    decision: approvalDecision(decision, scope),
    ...(updatedInput === undefined ? {} : { updatedInput }),
  });
}

/** Answer a question: Codex's asynchronous prompt by toolUseId, or a released
 * Claude/opencode dialog by its own question set. `answers` is the Hook's own
 * `[{ optionIndexes, text? }]` array (see questions.ts). */
export async function answerQuestion(computer, target, { id, answers, questions } = {}) {
  return hookPost(computer, "/v1/questions/answer", {
    target,
    ...(questions === undefined ? {} : { questions }),
    ...(questions === undefined && id !== undefined ? { toolUseId: id } : {}),
    answers,
  });
}

/** Type a secret the agent's terminal is reading (a password, a login). The
 * value is sent once and never echoed or stored. */
export async function sendSecret(computer, target, { id, value } = {}) {
  return hookPost(computer, "/v1/secret", {
    target,
    text: value,
    ...(id === undefined ? {} : { id }),
  });
}

/** Answer a `sudo -A` request on a computer: a password (optionally asking the
 * Hook whether sudo took it, so the desktop can remember it) or a deny. */
export async function answerSudo(computer, { id, password, remember } = {}) {
  const body = password ? { id, password, ...(remember ? { outcome: true } : {}) } : { id, deny: true };
  return hookPost(computer, "/v1/sudo/answer", body);
}

/** Dismiss a Claude `/btw` side answer card (cancel a pending one). */
export async function dismissSideAnswer(computer, target, id) {
  return hookPost(computer, "/v1/side-question/dismiss", { target, id });
}

/** One question's answer value as Claude reads it: a label, the labels of a
 * multiSelect, or any typed string as an "Other". Throws when unanswered. */
export function questionValue(question, answer = {}) {
  const selections = [...(answer.selections ?? [])].sort((a, b) => a - b);
  const typed = (answer.text ?? "").trim();
  const options = question.options ?? [];
  const labels = selections.map((index) => {
    const option = options[index];
    if (!option) throw new Error("Choose an available answer for every question.");
    return option.label;
  });
  if (question.isFreeText || question.kind === "text" || question.kind === "number") {
    if (!typed) throw new Error("Type an answer.");
    return typed;
  }
  if (question.multiSelect) {
    const all = [...labels, ...(typed ? [typed] : [])];
    if (!all.length) throw new Error("Choose at least one answer.");
    return all;
  }
  if (labels.length === 1 && !typed) return labels[0];
  if (!labels.length && typed) return typed;
  throw new Error("Choose one answer.");
}

/** Build Claude's `updatedInput`: the request's own input with `answers` keyed
 * by question text. `input` is the AskUserQuestion tool input. */
export function buildClaudeUpdatedInput(input, questions, answers) {
  const values = {};
  (questions ?? []).forEach((question, index) => {
    values[question.question] = questionValue(question, answers?.[index] ?? {});
  });
  return { ...(input ?? {}), answers: values };
}

/** Build Codex's answer array from the same per-question selections. */
export function buildQuestionAnswers(questions, answers) {
  return (questions ?? []).map((question, index) => {
    const answer = answers?.[index] ?? {};
    const selections = [...(answer.selections ?? [])].sort((a, b) => a - b);
    const text = (answer.text ?? "").trim();
    return { optionIndexes: selections, ...(text ? { text } : {}) };
  });
}
