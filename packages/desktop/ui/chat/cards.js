// Interaction cards: ways an agent asks the owner something, drawn as the
// phone's cards and answered through answers.js. Replaces its container's
// content on every render; the caller owns the WebSocket status frame.

import { answerApproval, answerQuestion, sendSecret, answerSudo, dismissSideAnswer, buildClaudeUpdatedInput, buildQuestionAnswers } from "./answers.js";

const PROVIDERS = { claude: "Claude", codex: "Codex", copilot: "Copilot", phren: "Phren", opencode: "OpenCode" };

let styleLinked = false;
function ensureStyle() {
  if (styleLinked) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./cards.css", import.meta.url).href;
  document.head.appendChild(link);
  styleLinked = true;
}

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function providerName(source) {
  return PROVIDERS[String(source || "").toLowerCase()] || "Agent";
}

function parseJson(value) {
  if (typeof value !== "string" || !value) return undefined;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed : undefined; } catch { return undefined; }
}

function isFreeText(question) {
  return question.kind === "text" || question.kind === "number";
}

function normalizeQuestions(raw) {
  return (Array.isArray(raw) ? raw : []).map((question) => {
    const options = (Array.isArray(question.options) ? question.options : []).map((option) =>
      typeof option === "string" ? { label: option } : { label: option?.label ?? "", description: option?.description });
    return {
      id: question.id, header: question.header, question: question.question ?? question.title ?? "",
      multiSelect: question.multiSelect === true, kind: question.kind, options,
    };
  }).filter((question) => question.question);
}

function makeCard(className) {
  ensureStyle();
  const card = h("div", `interaction-card${className ? ` ${className}` : ""}`);
  card.tabIndex = 0;
  return card;
}

function collapse(card, receipt) {
  card.dataset.settled = "1";
  const line = h("div", "card-receipt");
  line.append(h("span", "tick", "\u2713"));
  line.append(h("span", null, receipt));
  card.replaceChildren(line);
}

function showError(card, message, retry) {
  card.querySelector(".card-error")?.remove();
  const line = h("div", "card-error");
  line.append(h("span", null, message));
  const button = h("button", "card-btn", "Retry");
  button.type = "button";
  button.addEventListener("click", () => { line.remove(); retry(); });
  line.append(button);
  card.append(line);
}

// One button press: spinner on it, others disabled, then collapse to a
// receipt or show an amber error line with Retry.
function runAction({ card, button, buttons, receipt, run, onAnswered }) {
  if (card.dataset.settled || button.dataset.busy) return;
  button.dataset.busy = "1";
  button.disabled = true;
  for (const other of buttons) if (other !== button) other.disabled = true;
  const spinner = h("span", "spinner");
  button.prepend(spinner);
  Promise.resolve().then(run).then(() => {
    collapse(card, receipt);
    if (onAnswered) onAnswered();
  }).catch((error) => {
    spinner.remove();
    delete button.dataset.busy;
    for (const other of buttons) other.disabled = false;
    showError(card, (error && error.message) || "The answer did not reach the agent.", () =>
      runAction({ card, button, buttons, receipt, run, onAnswered }));
  });
}

function inlineNodes(text) {
  const fragment = document.createDocumentFragment();
  const pattern = /`([^`]+)`/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) fragment.append(document.createTextNode(text.slice(last, match.index)));
    fragment.append(h("span", "md-code", match[1]));
    last = match.index + match[0].length;
  }
  if (last < text.length) fragment.append(document.createTextNode(text.slice(last)));
  return fragment;
}

function inlineLine(tag, className, text) {
  const node = h(tag, className);
  node.append(inlineNodes(text));
  return node;
}

// Markdown-ish plan: headings, lists, code spans and fenced blocks, built as
// nodes so nothing in the plan is ever parsed as HTML.
function renderMarkdown(text) {
  const body = h("div", "plan-body");
  let code = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      if (code) { body.append(code); code = null; } else { code = h("pre", "md-pre"); }
      continue;
    }
    if (code) { code.textContent += (code.textContent ? "\n" : "") + line; continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { body.append(inlineLine("div", `md-h md-h${Math.min(heading[1].length, 3)}`, heading[2])); continue; }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const item = h("div", "md-li");
      item.append(h("span", "bullet", "\u2022"));
      item.append(inlineNodes((bullet ?? ordered)[1]));
      body.append(item);
      continue;
    }
    if (line.trim()) body.append(inlineLine("div", "md-p", line));
  }
  if (code) body.append(code);
  return body;
}

function commandOf(approval) {
  if (approval.choice && typeof approval.choice.body === "string" && approval.choice.body) return approval.choice.body;
  const input = parseJson(approval.message);
  const command = input && (input.command ?? input.cmd);
  return typeof command === "string" && command ? command : "";
}

function approvalReceipt(decision, scope) {
  if (decision === "deny") return "Denied";
  if (scope === "project") return "Approved \u00b7 Allow for this project";
  if (scope === "everywhere") return "Approved \u00b7 Allow everywhere";
  return "Approved";
}

// The rows an approval offers: the Hook's own option list when it sends one,
// otherwise the four standard actions. Decisions map to the Hook's vocabulary.
function approvalActions(approval) {
  const options = Array.isArray(approval.options) ? approval.options : null;
  if (options && options.length) {
    return options.map((option) => {
      const raw = String(option.decision || "approve");
      const scope = raw === "allow-project" ? "project" : raw === "allow-everywhere" ? "everywhere" : "once";
      const decision = raw === "deny" ? "deny" : "approve";
      return { label: option.label || approvalReceipt(decision, scope), decision, scope, primary: raw === "approve", danger: decision === "deny" };
    });
  }
  return [
    { label: "Approve", decision: "approve", scope: "once", primary: true },
    { label: "Allow for this project", decision: "approve", scope: "project" },
    { label: "Allow everywhere", decision: "approve", scope: "everywhere" },
    { label: "Deny", decision: "deny", scope: "once", danger: true },
  ];
}

function buildApprovalCard(approval, ctx) {
  const card = makeCard("approval");
  card.append(h("div", "card-head", `${ctx.provider} asks`));
  const title = approval.title || (approval.choice && approval.choice.title);
  if (title) card.append(h("div", "card-title", title));
  const summary = approval.request || "";
  if (summary && summary !== title) card.append(h("div", "card-mono", summary));
  const command = commandOf(approval);
  if (command && command !== summary) card.append(h("div", "card-explain", command));
  const details = approval.details;
  if (details && details !== summary && details !== title) {
    const disclosure = h("details", "card-details");
    disclosure.append(h("summary", null, "Action details"));
    disclosure.append(h("div", "card-mono", typeof details === "string" ? details : JSON.stringify(details, null, 2)));
    card.append(disclosure);
  }
  const actions = h("div", "card-actions");
  const buttons = [];
  const definitions = approvalActions(approval);
  for (const definition of definitions) {
    const button = h("button", `card-btn${definition.primary ? " primary" : definition.danger ? " danger" : ""}`, definition.label);
    button.type = "button";
    button.addEventListener("click", () => runAction({
      card, button, buttons, receipt: approvalReceipt(definition.decision, definition.scope),
      run: () => answerApproval(ctx.computer, ctx.target, { actionId: approval.actionId, decision: definition.decision, scope: definition.scope }),
      onAnswered: ctx.onAnswered,
    }));
    buttons.push(button);
    actions.append(button);
  }
  card.append(actions);
  card.addEventListener("keydown", (event) => {
    if (/^(INPUT|TEXTAREA)$/.test(event.target?.tagName ?? "")) return;
    const project = definitions.findIndex((definition) => definition.scope === "project");
    const deny = definitions.findIndex((definition) => definition.decision === "deny");
    if (event.key === "Enter" && buttons[0]) { event.preventDefault(); buttons[0].click(); }
    else if (event.key.toLowerCase() === "p" && project >= 0) { event.preventDefault(); buttons[project].click(); }
    else if (event.key.toLowerCase() === "d" && deny >= 0) { event.preventDefault(); buttons[deny].click(); }
  });
  return card;
}

// Claude Code's plan review is a permission request for ExitPlanMode: the plan
// is the tool input's `plan` string. Approve plan builds it, Keep planning
// sends it back (the permission is denied).
function isPlanApproval(approval) {
  if (String(approval.toolName || "").toLowerCase() === "exitplanmode") return true;
  const input = parseJson(approval.message);
  return !!input && typeof input.plan === "string" && input.plan.trim() !== "";
}

function planText(approval) {
  const input = parseJson(approval.message);
  if (input && typeof input.plan === "string" && input.plan.trim()) return input.plan;
  return approval.details || approval.request || "";
}

function buildPlanCard(approval, ctx) {
  const card = makeCard("plan");
  card.append(h("div", "card-head", "Plan ready for review"));
  card.append(renderMarkdown(planText(approval)));
  const actions = h("div", "card-actions");
  const buttons = [];
  const keep = h("button", "card-btn", "Keep planning");
  const approve = h("button", "card-btn primary", "Approve plan");
  keep.type = approve.type = "button";
  keep.addEventListener("click", () => runAction({
    card, button: keep, buttons, receipt: "Kept planning",
    run: () => answerApproval(ctx.computer, ctx.target, { actionId: approval.actionId, decision: "deny" }),
    onAnswered: ctx.onAnswered,
  }));
  approve.addEventListener("click", () => runAction({
    card, button: approve, buttons, receipt: "Approved plan",
    run: () => answerApproval(ctx.computer, ctx.target, { actionId: approval.actionId, decision: "approve" }),
    onAnswered: ctx.onAnswered,
  }));
  buttons.push(keep, approve);
  actions.append(keep, approve);
  card.append(actions);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); approve.click(); }
  });
  return card;
}

// One card for one question set: a radio/checkbox row per option, an "Other"
// or free-text input, one Send. Codex's normalized questions carry `kind`.
function buildQuestionCard({ title, questions, allowsTyping, receipt, run, ctx }) {
  const card = makeCard("question");
  const head = h("div", "card-head", title);
  const count = questions.length > 1 ? h("span", "card-count") : null;
  if (count) head.append(count);
  card.append(head);

  const answers = questions.map(() => ({ selections: [], text: "" }));
  const optionButtons = [];
  const inputs = [];

  const answered = (question, answer) => {
    if (isFreeText(question)) return !!answer.text.trim();
    if (question.multiSelect) return answer.selections.length > 0 || !!answer.text.trim();
    return answer.selections.length === 1 || !!answer.text.trim();
  };

  const refresh = () => {
    questions.forEach((question, index) => {
      (optionButtons[index] ?? []).forEach((button, optionIndex) => {
        button.classList.toggle("selected", answers[index].selections.includes(optionIndex));
      });
    });
    const done = questions.filter((question, index) => answered(question, answers[index])).length;
    if (count) count.textContent = `${done} of ${questions.length}`;
    send.disabled = done !== questions.length;
  };

  const choose = (index, optionIndex) => {
    const question = questions[index];
    const answer = answers[index];
    if (question.multiSelect) {
      answer.selections = answer.selections.includes(optionIndex)
        ? answer.selections.filter((value) => value !== optionIndex) : [...answer.selections, optionIndex];
    } else {
      answer.selections = [optionIndex];
      answer.text = "";
      if (inputs[index]) inputs[index].value = "";
    }
    refresh();
  };

  questions.forEach((question, index) => {
    const block = h("div", "q-block");
    block.tabIndex = 0;
    block.dataset.question = String(index);
    const line = h("div", "q-question");
    if (question.header) line.append(h("span", "q-header", `${question.header}: `));
    line.append(document.createTextNode(question.question));
    block.append(line);
    optionButtons[index] = [];
    if (!isFreeText(question)) {
      const options = h("div", "q-options");
      (question.options ?? []).forEach((option, optionIndex) => {
        const row = h("button", "q-option");
        row.type = "button";
        row.append(h("span", `q-mark${question.multiSelect ? " check" : ""}`));
        const label = h("span", "q-option-text");
        label.append(h("span", null, option.label));
        if (option.description) label.append(h("span", "card-meta", option.description));
        row.append(label);
        row.addEventListener("click", () => choose(index, optionIndex));
        optionButtons[index].push(row);
        options.append(row);
      });
      block.append(options);
    }
    if (isFreeText(question) || allowsTyping) {
      const input = h("input", "card-input");
      input.type = "text";
      input.placeholder = isFreeText(question) ? (question.kind === "number" ? "Enter a number" : "Type your answer") : "Other\u2026";
      input.addEventListener("input", () => {
        answers[index].text = input.value;
        if (!isFreeText(question) && !question.multiSelect && input.value) answers[index].selections = [];
        refresh();
      });
      inputs[index] = input;
      block.append(input);
    }
    card.append(block);
  });

  const actions = h("div", "card-actions");
  const send = h("button", "card-btn primary", "Send answer");
  send.type = "button";
  send.disabled = true;
  send.addEventListener("click", () => runAction({
    card, button: send, buttons: [send], receipt, run: () => run(answers), onAnswered: ctx.onAnswered,
  }));
  actions.append(send);
  card.append(actions);
  refresh();

  card.addEventListener("keydown", (event) => {
    if (/^(INPUT|TEXTAREA)$/.test(event.target?.tagName ?? "")) {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!send.disabled) send.click(); }
      return;
    }
    if (/^[1-9]$/.test(event.key)) {
      const index = Number(document.activeElement?.closest?.(".q-block")?.dataset?.question ?? 0);
      const question = questions[index];
      const optionIndex = Number(event.key) - 1;
      if (question && !isFreeText(question) && optionIndex < (question.options?.length ?? 0)) {
        event.preventDefault();
        choose(index, optionIndex);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!send.disabled) send.click();
    }
  });

  return card;
}

// A secret the agent's terminal is reading (a login, a password prompt). It is
// never echoed anywhere; the card clears when it collapses.
function buildSecretCard(ctx) {
  const card = makeCard("secret");
  card.append(h("div", "card-head", "Password"));
  card.append(h("div", "card-explain", "Typed into the agent's terminal and sent with Enter. It is not kept on this computer."));
  const input = h("input", "card-input");
  input.type = "password";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "Password";
  card.append(input);
  const actions = h("div", "card-actions");
  const send = h("button", "card-btn primary", "Send");
  send.type = "button";
  send.disabled = true;
  input.addEventListener("input", () => { send.disabled = input.value.length === 0; });
  input.addEventListener("keydown", (event) => { if (event.key === "Enter" && input.value.length) { event.preventDefault(); send.click(); } });
  send.addEventListener("click", () => runAction({
    card, button: send, buttons: [send], receipt: "Sent",
    run: () => { const value = input.value; input.value = ""; return sendSecret(ctx.computer, ctx.target, { value }); },
    onAnswered: ctx.onAnswered,
  }));
  actions.append(send);
  card.append(actions);
  return card;
}

// One `sudo -A` request: the command, who asked, a countdown, a password and
// "Remember for this session", answered once with Approve or Deny.
function buildSudoCard(request, ctx) {
  const card = makeCard("sudo");
  card.append(h("div", "card-head", "sudo"));
  card.append(h("div", "card-title", `Run sudo on ${request.computer || ctx.computer}`));
  card.append(h("div", "card-mono", String(request.command || "")));
  const meta = h("div", "card-meta");
  meta.append(h("div", null, `As ${request.user || "root"}`));
  const session = request.session;
  if (session) {
    const line = session.label && session.source ? `${session.label} (${session.source})` : session.label || session.source;
    if (line) meta.append(h("div", null, `Asked by ${line}`));
  }
  if (request.cwd) meta.append(h("div", null, `In ${request.cwd}`));
  card.append(meta);

  const countdown = h("div", "card-countdown");
  const tick = () => {
    const left = Math.max(0, Math.ceil((Date.parse(request.expiresAt) - Date.now()) / 1000));
    countdown.textContent = left ? `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "This request expired.";
  };
  tick();
  const timer = setInterval(tick, 1000);
  card.dataset.timer = String(timer);
  card.append(countdown);

  const input = h("input", "card-input");
  input.type = "password";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "Password";
  card.append(input);

  const rememberWrap = h("label", "card-check");
  const remember = h("input", null);
  remember.type = "checkbox";
  rememberWrap.append(remember, document.createTextNode("Remember for this session"));
  card.append(rememberWrap);

  const actions = h("div", "card-actions");
  const buttons = [];
  const deny = h("button", "card-btn danger", "Deny");
  const approve = h("button", "card-btn primary", "Approve");
  deny.type = approve.type = "button";
  approve.disabled = true;
  input.addEventListener("input", () => { approve.disabled = input.value.length === 0; });
  const stop = () => clearInterval(timer);
  deny.addEventListener("click", () => runAction({
    card, button: deny, buttons, receipt: "Denied", run: () => { stop(); return answerSudo(ctx.computer, { id: request.id }); }, onAnswered: ctx.onAnswered,
  }));
  approve.addEventListener("click", () => runAction({
    card, button: approve, buttons, receipt: "Approved",
    run: () => { const password = input.value; input.value = ""; stop(); return answerSudo(ctx.computer, { id: request.id, password, remember: remember.checked }); },
    onAnswered: ctx.onAnswered,
  }));
  buttons.push(deny, approve);
  actions.append(deny, approve);
  card.append(actions);
  return card;
}

// Claude's `/btw` answer: never part of the conversation, pinned until
// dismissed. Long answers scroll inside the card.
export function renderSideAnswer(container, frame, { computer, target } = {}) {
  ensureStyle();
  container.classList.add("cards");
  const card = buildSideCard(frame, computer, target);
  container.classList.add("side-cards");
  container.replaceChildren(card);
  return { destroy() { container.replaceChildren(); } };
}

function buildSideCard(frame, computer, target) {
  const state = String(frame.state || "pending");
  const card = makeCard("side-card");
  const head = h("div", "card-head", "Side answer");
  head.append(h("span", "card-count", stateLabel(state)));
  card.append(head);
  card.append(h("div", "side-note", "Not part of the conversation"));
  card.append(h("div", "side-question", String(frame.question || "")));
  const body = h("div", "side-content");
  if (state === "pending") {
    const pending = h("div", "card-receipt");
    pending.append(h("span", "spinner"));
    pending.append(h("span", null, "Claude is answering beside the current turn\u2026"));
    body.append(pending);
  } else if (state === "answer") {
    body.append(h("div", "side-answer-text card-explain", String(frame.answer || "")));
  } else {
    body.append(h("div", "side-note", String(frame.answer || "The side question was closed in the terminal.")));
  }
  card.append(body);
  const actions = h("div", "card-actions");
  if (state === "answer" && frame.answer) {
    const copy = h("button", "card-btn", "Copy");
    copy.type = "button";
    copy.addEventListener("click", () => { navigator.clipboard?.writeText(String(frame.answer)).catch(() => {}); });
    actions.append(copy);
  }
  if (state === "pending") {
    const cancel = h("button", "card-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => { dismissSideAnswer(computer, target, frame.id).then(() => collapse(card, "Closed")).catch((error) => showError(card, error?.message || "Could not close the side question.", () => {})); });
    actions.append(cancel);
  } else {
    const dismiss = h("button", "card-btn", "Dismiss");
    dismiss.type = "button";
    dismiss.addEventListener("click", () => { dismissSideAnswer(computer, target, frame.id).then(() => collapse(card, "Dismissed")).catch((error) => showError(card, error?.message || "Could not dismiss the side answer.", () => {})); });
    actions.append(dismiss);
  }
  card.append(actions);
  return card;
}

function stateLabel(state) {
  return ({ pending: "Answering", answer: "Answered", error: "No answer", cancelled: "Closed" })[state] || state;
}

export function renderSudoRequests(container, requests, { computer, onAnswered } = {}) {
  ensureStyle();
  container.classList.add("cards", "sudo-cards");
  const cards = (Array.isArray(requests) ? requests : []).map((request) => buildSudoCard(request, { computer, onAnswered }));
  container.replaceChildren(...cards);
  return {
    destroy() {
      for (const card of cards) clearInterval(Number(card.dataset.timer));
      container.replaceChildren();
    },
  };
}

/** Render the cards for an agent's pending status. Replaces the container's
 * content; returns { focus, destroy }. `onAnswered` runs after any answer. */
export function renderInteractions(container, agentStatus, { computer, target, onAnswered } = {}) {
  ensureStyle();
  container.classList.add("cards");
  const status = agentStatus || {};
  const ctx = { computer, target, provider: providerName(target?.source), onAnswered };
  const cards = [];

  const approval = status.pendingApproval;
  if (approval && approval.actionId) {
    const input = parseJson(approval.message);
    if (String(approval.toolName || "").toLowerCase() === "askuserquestion" && input && Array.isArray(input.questions)) {
      const questions = normalizeQuestions(input.questions);
      cards.push(buildQuestionCard({
        title: `${ctx.provider} has a question`, questions, allowsTyping: true, receipt: "Answer sent", ctx,
        run: (answers) => answerApproval(computer, target, { actionId: approval.actionId, decision: "approve", updatedInput: buildClaudeUpdatedInput(input, questions, answers) }),
      }));
    } else if (isPlanApproval(approval)) {
      cards.push(buildPlanCard(approval, ctx));
    } else {
      cards.push(buildApprovalCard(approval, ctx));
    }
  }

  for (const prompt of Array.isArray(status.pendingQuestions) ? status.pendingQuestions : []) {
    const questions = normalizeQuestions(prompt.questions);
    if (!questions.length) continue;
    cards.push(buildQuestionCard({
      title: `${ctx.provider} has a question`, questions, allowsTyping: true, receipt: "Answer sent", ctx,
      run: (answers) => answerQuestion(computer, target, { id: prompt.toolUseId ?? prompt.id, answers: buildQuestionAnswers(questions, answers) }),
    }));
  }

  if (status.passwordPrompt) cards.push(buildSecretCard(ctx));

  container.replaceChildren(...cards);
  return {
    focus() { cards[0]?.focus?.(); },
    destroy() { container.replaceChildren(); },
  };
}
