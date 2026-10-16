import { el } from "../dom.js";
import { harnessLabel } from "../harness.js";
import { resetLabel } from "./usage-windows.js";
import { movePlan } from "./handoff.js";
import { openHandoffChat } from "./handoff-view.js";
import { store } from "./store.js";
// "Continue in…": move a live session to another harness or Claude account in
// a pane or a new chat (Hook `POST /v1/sessions/move`, session-move.ts). The agent
// writes a hand-off; the chosen one starts in the same folder with
// the hand-off as its first prompt. Uncommitted work stays in the checkout.
// The sheet follows the move (`GET /v1/sessions/move?id=`) until it lands.
import { hookGet, hookPost } from "../api.js";
import { registerCommand } from "./palette.js";
import { sectionHandle, showSection } from "./sections.js";

const HARNESSES = ["claude", "codex", "opencode", "copilot"].map((source) => [source, harnessLabel(source)]);
const STATE_WORDS = { "handing-off": "Writing a hand-off…", exiting: "Ending the old agent…", launching: "Starting the new agent…", moved: "Moved", failed: "The move failed" };
const POLL_MS = 2000;
const GIVE_UP_MS = 15 * 60_000;

/** Which harnesses can take the session: installed and usable on that
 * computer (when the Hook says), including Claude on another account. */
export function moveChoices(inventory, current, currentAccount) {
  const known = Array.isArray(inventory) ? new Map(inventory.map((h) => [h.source, h])) : null;
  return HARNESSES.filter(([source]) => (source !== current || source === "claude" && currentAccount && moveAccounts(inventory, { includeDefault: true }).some((a) => a.id !== currentAccount))).map(([source, label]) => {
    const entry = known?.get(source);
    const usable = !known || (entry?.installed && entry?.usable);
    return { source, label, usable: Boolean(usable), reason: usable ? "" : entry?.reason || "Not installed" };
  });
}

/** Usable Claude accounts; includeDefault enables returning to the default home. */
export function moveAccounts(inventory, { includeDefault = false } = {}) {
  const claude = Array.isArray(inventory) ? inventory.find((h) => h.source === "claude") : null;
  return (claude?.accounts ?? []).filter((a) => a.usable && (includeDefault || a.id !== "default"));
}

/** What the sheet says for a move record. */
export function moveStatus(move) {
  if (!move) return "";
  if (move.state === "failed") return move.error ? `The move failed: ${move.error}` : STATE_WORDS.failed;
  if (move.state === "moved" && move.handoff?.source === "fallback") return "Moved (Phren wrote the hand-off from the transcript)";
  return STATE_WORDS[move.state] ?? move.state;
}

let openSheet = null;

/** The sheet borrows the launch sheet's styles (launch.css, added once by either). */
function installStyles() {
  if (document.getElementById("launch-styles")) return;
  const link = document.createElement("link");
  link.id = "launch-styles";
  link.rel = "stylesheet";
  link.href = new URL("launch.css", import.meta.url).href;
  document.head.append(link);
}

export async function openMoveSheet({ computer, child, to = {}, notice = "", selectDefault = true, returnFocus }) {
  openSheet?.close();
  if (openSheet) return;
  returnFocus ??= document.activeElement;
  installStyles();
  const current = child.target?.source ?? child.agent;
  const state = { harness: to.harness ?? "", account: to.account ?? "", inventory: null, computer: "", peers: [], destinations: null, buttons: [], addButtons: [], moveNewChat: false, mode: undefined, loadingAccounts: false, busy: false, adding: false, movedAt: null, landedMove: null, timer: null };

  const backdrop = el("div", "launch-backdrop");
  const sheet = el("div", "launch-sheet move-sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.tabIndex = -1;
  sheet.setAttribute("aria-label", "Continue in another agent");
  const head = el("div", "launch-head");
  const closeBtn = el("button", "launch-close", "×");
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.style.marginLeft = "auto";
  head.append(el("h2", "launch-title", "Continue in another agent"), closeBtn);
  const body = el("div", "launch-body");
  body.append(el("div", "launch-note", `${child.title || child.label || "This session"} on ${computer}. The agent writes a hand-off; work continues in the same folder. Uncommitted changes stay where they are.`));
  const outcome = el("div", "launch-hint");
  body.append(outcome);
  if (notice) body.append(el("div", "launch-note", notice));
  const harnessRow = el("div", "launch-segments");
  const harnessField = el("div", "launch-field");
  harnessField.append(el("span", "launch-label", "Continue in"), harnessRow);
  const accountSelect = el("select", "launch-select");
  accountSelect.setAttribute("aria-label", "Claude account");
  const accountField = el("div", "launch-field");
  accountField.append(el("span", "launch-label", "Account"), accountSelect);
  accountField.hidden = true;
  const status = el("div", "launch-status");
  status.setAttribute("role", "status");
  const go = el("button", "launch-btn accent", "Continue");
  go.type = "button";
  const remoteField = el("div", "launch-field");
  remoteField.hidden = true;
  const remoteRows = el("div", "launch-computers");
  remoteField.append(el("span", "launch-label", "Claude accounts"), remoteRows);
  const otherField = el("div", "launch-field");
  const otherRows = el("div", "launch-computers");
  otherField.append(el("span", "launch-label", "Other harnesses"), otherRows);
  otherField.hidden = true;
  const addActions = el("div", "launch-field");
  const addForm = el("form", "launch-field");
  addForm.hidden = true;
  const slugInput = el("input", "launch-input");
  slugInput.setAttribute("aria-label", "Claude account short name");
  slugInput.placeholder = "work";
  slugInput.maxLength = 32;
  const addTitle = el("span", "launch-label");
  const addError = el("div", "launch-error");
  addError.setAttribute("role", "alert");
  const addSubmit = el("button", "launch-btn", "Add account");
  addSubmit.type = "submit";
  const addCancel = el("button", "launch-btn", "Cancel");
  addCancel.type = "button";
  addForm.append(addTitle, slugInput, addError, addSubmit, addCancel);
  let addComputer = "";
  let addInvoker;
  function showAdd(name, invoker) {
    addComputer = name; addInvoker = invoker;
    addTitle.textContent = `Add a Claude account on ${name}…`;
    slugInput.value = ""; addError.textContent = ""; addForm.hidden = false; slugInput.focus();
  }
  function addButton(parent, name, reason = "") {
    const button = el("button", "launch-btn move-add-account", `Add a Claude account on ${name}…`);
    button.type = "button";
    button.disabled = state.busy || !!reason;
    button.title = reason;
    button.addEventListener("click", () => { if (!state.busy && !reason) showAdd(name, button); });
    state.addButtons.push({ button, reason }); parent.append(button);
    return button;
  }
  addCancel.addEventListener("click", () => { if (!state.busy) { addForm.hidden = true; addInvoker?.focus(); } });
  addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.busy) return;
    const slug = slugInput.value.trim();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(slug) || slug === "default") {
      addError.textContent = "Use 1–32 lowercase letters or digits with hyphens between them; choose a name other than default.";
      slugInput.focus(); return;
    }
    state.busy = state.adding = true; render();
    try {
      if (!(await store.capabilities(addComputer)).claudeAccountAdd) throw new Error(`Update ${addComputer}'s Hook to add a Claude account.`);
      const result = await hookPost(addComputer, "/v1/accounts/claude/add", { slug });
      if (openSheet?.backdrop !== backdrop) return;
      if (!result.target?.server || !result.target?.pane) throw new Error("The Hook did not return a login pane. Try again.");
      state.adding = false;
      close(); showSection("agents");
      sectionHandle("agents")?.openPane(addComputer, result.target);
    } catch (error) {
      if (openSheet?.backdrop === backdrop) addError.textContent = error?.message || "Could not start the login.";
    } finally {
      state.busy = state.adding = false;
      if (openSheet?.backdrop === backdrop) { render(); if (addError.textContent) slugInput.focus(); }
    }
  });
  const loginHint = el("div", "launch-note move-login-hint");
  loginHint.hidden = true;
  body.append(remoteField, harnessField, accountField, otherField, addActions, loginHint, addForm, status);
  const foot = el("div", "launch-foot");
  foot.append(go);
  sheet.append(head, body, foot);
  backdrop.append(sheet);
  document.body.append(backdrop);

  const controls = () => [...sheet.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    .filter((control) => !control.closest("[hidden], [inert]"));
  const focusFirst = () => (controls()[0] ?? sheet).focus();
  const keepFocus = () => { if (!sheet.contains(document.activeElement)) focusFirst(); };
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (["ArrowDown", "ArrowUp"].includes(event.key) && document.activeElement?.tagName !== "SELECT") {
      const list = controls();
      const index = list.indexOf(document.activeElement);
      event.preventDefault();
      list[(index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
    } else if (event.key === "Tab") {
      const list = controls();
      const index = list.indexOf(document.activeElement);
      if (index < 0 || event.shiftKey && index === 0 || !event.shiftKey && index === list.length - 1) {
        event.preventDefault();
        (event.shiftKey ? list.at(-1) ?? sheet : list[0] ?? sheet).focus();
      }
    }
  };
  const close = () => {
    if (openSheet?.backdrop !== backdrop || state.adding) return;
    clearTimeout(state.timer);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("focusin", keepFocus);
    backdrop.remove();
    openSheet = null;
    if (typeof returnFocus === "function") returnFocus();
    else if (returnFocus?.isConnected) returnFocus.focus();
  };
  openSheet = { close, backdrop };
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop && !state.busy) close(); });
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("focusin", keepFocus);

  function render() {
    const hadFocus = sheet.contains(document.activeElement);
    const peer = state.peers.find((p) => p.name === state.computer);
    const choices = moveChoices(state.inventory, current, child.account?.id);
    if (!state.destinations && !peer && !choices.some((c) => c.source === state.harness && c.usable)) state.harness = selectDefault ? choices.find((c) => c.usable)?.source ?? "" : "";
    harnessRow.replaceChildren(...choices.map((c) => {
      const b = el("button", `launch-seg${!peer && c.source === state.harness ? " selected" : ""}`, c.label);
      b.type = "button";
      b.disabled = !c.usable || state.busy;
      if (c.reason) b.title = c.reason;
      b.addEventListener("click", () => { state.computer = ""; state.harness = c.source; render(); });
      return b;
    }));
    const accounts = !peer && state.harness === "claude" ? moveAccounts(state.inventory, { includeDefault: true }).filter((a) => current !== "claude" || a.id !== child.account?.id) : [];
    accountField.hidden = !!state.destinations || accounts.length === 0;
    const accountOptions = accounts.length ? accounts.map((a) => [a.id, a.label || a.id]) : [["", "Default"]];
    accountSelect.replaceChildren(...accountOptions.map(([v, l]) => { const o = el("option", null, l); o.value = v; return o; }));
    if (!state.destinations && !peer && state.harness === "claude" && !accounts.some((a) => a.id === state.account)) state.account = accounts.find((a) => a.id === "default")?.id ?? accounts[0]?.id ?? "";
    accountSelect.value = accounts.some((a) => a.id === state.account) ? state.account : "";
    accountSelect.disabled = state.busy;
    const accountLabel = accounts.find((a) => a.id === state.account)?.label;
    outcome.textContent = peer ? `Opens a new ${harnessLabel(state.harness)} chat on ${peer.name} with a hand-off` : movePlan(current, { harness: state.harness, account: state.account, accountLabel }, state.moveNewChat).label;
    for (const { button, destination } of state.buttons) {
      button.disabled = state.busy || !!destination.reason;
      button.setAttribute("aria-pressed", String(destination.harness === state.harness && (destination.account ?? "") === state.account && destination.computer === state.computer));
      button.classList.toggle("selected", destination.harness === state.harness && (destination.account ?? "") === state.account && destination.computer === state.computer);
    }
    for (const { button, reason } of state.addButtons) button.disabled = state.busy || !!reason;
    closeBtn.disabled = state.adding;
    slugInput.disabled = addSubmit.disabled = addCancel.disabled = state.busy;
    go.disabled = !state.harness || state.busy || state.loadingAccounts;
    if (hadFocus && (!sheet.contains(document.activeElement) || document.activeElement.disabled || document.activeElement.closest("[hidden], [inert]"))) focusFirst();
  }
  accountSelect.addEventListener("change", () => { state.account = accountSelect.value; render(); });

  async function follow(id, started) {
    if (openSheet?.backdrop !== backdrop) return;
    let move = state.landedMove;
    if (!move) {
      try { move = (await hookGet(computer, "/v1/sessions/move", { id })).move; } catch { /* keep asking */ }
    }
    if (openSheet?.backdrop !== backdrop) return;
    if (move) status.textContent = moveStatus(move);
    if (move?.state === "moved") {
      state.landedMove = move;
      state.movedAt ??= Date.now();
      const peerName = move.handedOffTo?.computer ?? state.computer;
      const destination = peerName ? state.peers.find((peer) => peer.name === peerName)?.desktopName : computer;
      if (state.mode !== "new-chat" || destination && (move.handedOffTo?.target ?? move.target) && openHandoffChat(destination, move.handedOffTo?.target ?? move.target)) {
        state.busy = false; render(); setTimeout(close, 1500); return;
      }
      if (Date.now() - state.movedAt >= 30_000) {
        status.textContent = `Moved to ${peerName || computer} — open it from there`;
        state.busy = false; render(); return;
      }
      status.textContent = "Hand-off ready; waiting for the new chat to appear…";
    }
    if (move?.state === "failed") { status.classList.add("launch-error"); state.busy = false; render(); return; }
    if (Date.now() - started > GIVE_UP_MS) { status.textContent = "Still moving; check the session in a moment."; state.busy = false; render(); return; }
    state.timer = setTimeout(() => void follow(id, started), POLL_MS);
  }

  go.addEventListener("click", async () => {
    if (!state.harness || state.busy || state.loadingAccounts) return;
    state.busy = true;
    state.movedAt = null;
    state.landedMove = null;
    status.className = "launch-status";
    status.textContent = "Asking the agent for a hand-off…";
    render();
    const id = crypto.randomUUID();
    const to = { harness: state.harness, ...(state.computer ? { computer: state.computer } : {}), ...(state.harness === "claude" && state.account ? { account: state.account } : {}) };
    try {
      const caps = await store.capabilities(computer);
      if (state.computer && !caps.moveToComputer) throw new Error("This computer's Hook cannot continue on another computer; update it first.");
      if (state.computer && child.role === "conductor" && !caps.moveConductorToComputer) throw new Error(`Update ${computer}'s Hook to move the conductor`);
      state.mode = state.computer ? "new-chat" : movePlan(current, to, caps.moveNewChat).mode;
      const res = await hookPost(computer, "/v1/sessions/move", { target: child.target, to, id, ...(state.mode ? { mode: state.mode } : {}) });
      status.textContent = moveStatus(res.move) || "Moving…";
      void follow(res.move?.id ?? id, Date.now());
    } catch (err) {
      state.busy = false;
      status.classList.add("launch-error");
      status.textContent = !state.computer && (err?.status === 404 || err?.status === 503) ? "This computer's Hook cannot move sessions; update it first." : err?.message || "The move did not start.";
      render();
    }
  });

  go.disabled = true;
  focusFirst();
  const [inventory, caps] = await Promise.all([
    hookGet(computer, "/v1/harnesses").catch(() => null),
    store.capabilities(computer),
  ]);
  state.inventory = inventory?.harnesses ?? null;
  state.moveNewChat = caps.moveNewChat === true;
  if (openSheet?.backdrop !== backdrop) return;
  state.loadingAccounts = caps.moveToComputer === true;
  render();
  const localAddButton = caps.claudeAccountAdd ? addButton(addActions, computer) : null;
  if (!caps.moveToComputer) return;
  remoteField.hidden = false;
  remoteRows.append(el("div", "launch-note", "Loading accounts…"));
  try {
    let project = typeof child.project === "string" ? child.project.trim() : "";
    if (!project) {
      const { repos = [] } = await hookGet(computer, "/v1/projects/repos");
      const cwd = (child.cwd ?? "").replace(/\/+$/, "");
      const checkout = repos.filter((repo) => {
        const root = repo.directory?.replace(/\/+$/, "");
        return repo.registered && root && (cwd === root || cwd.startsWith(root + "/"));
      }).sort((a, b) => b.directory.length - a.directory.length)[0];
      // `name` is the checkout basename, not the registered store project.
      project = checkout?.project;
      if (checkout && !project) {
        const { stores = [] } = await hookGet(computer, "/v1/tasks/stores");
        const names = [...new Set(stores.flatMap((store) => store.projects ?? []))];
        for (let offset = 0; offset < names.length && !project; offset += 4) {
          const located = await Promise.all(names.slice(offset, offset + 4).map(async (name) => {
            try {
              const { candidates = [] } = await hookGet(computer, "/v1/projects/locate", { project: name });
              return candidates.some((candidate) => candidate.directory?.replace(/\/+$/, "") === checkout.directory.replace(/\/+$/, "")) ? name : null;
            } catch { return null; }
          }));
          project = located.find(Boolean);
          if (openSheet?.backdrop !== backdrop) return;
        }
      }
    }
    if (openSheet?.backdrop !== backdrop) return;
    if (!project) throw new Error("This session has no registered project. Open a chat in a registered checkout to continue on another computer.");
    const result = await hookGet(computer, "/v1/sessions/move/computers", { project });
    if (openSheet?.backdrop !== backdrop) return;
    // The Hook's verified-peer names belong to its SSH directory, not to the
    // desktop. Resolve desktop aliases by stable health IDs before any reads,
    // account additions or opening of a chat on the receiving computer.
    const desktopComputers = [];
    const configured = store.merged?.computers ?? [];
    for (let offset = 0; offset < configured.length; offset += 4) {
      desktopComputers.push(...await Promise.all(configured.slice(offset, offset + 4).map(async (entry) => {
        let id = entry.overview?.phren?.computer?.id;
        if (!id) {
          try { id = (await hookGet(entry.computer, "/v1/health")).computer?.id; } catch { /* legacy or offline */ }
        }
        return { name: entry.computer, id };
      })));
      if (openSheet?.backdrop !== backdrop) return;
    }
    state.peers = (result.computers ?? []).map((peer) => {
      const byId = peer.computerId ? desktopComputers.filter((entry) => entry.id === peer.computerId) : [];
      const matches = peer.self ? [{ name: computer }] : byId.length ? byId : desktopComputers.filter((entry) =>
        (!peer.computerId || !entry.id) && peer.name === entry.name);
      return { ...peer, desktopName: matches.length === 1 ? matches[0].name : null };
    });
    // A partial peer inventory must not remove working local destinations.
    const inventoryHarnesses = (state.inventory ?? []).map((h) => ({ ...h, usable: h.installed !== false && h.usable }));
    let self = state.peers.find((peer) => peer.self);
    if (!self) { self = { name: computer, self: true, desktopName: computer }; state.peers.unshift(self); }
    const selfHarnesses = self.online === false || self.hasCheckout === false ? [] : self.harnesses ?? [];
    self.harnesses = selfHarnesses.map((h) => ({ ...h, accounts: h.accounts?.map((a) => ({ ...a })) }));
    for (const harness of inventoryHarnesses) {
      const existing = self.harnesses.find((h) => h.source === harness.source);
      if (!existing) self.harnesses.push(harness);
      else if (harness.source === "claude" && (!existing.usable || !existing.accounts?.some((a) => a.usable && !a.current && a.id !== child.account?.id))) {
        existing.accounts = [...(existing.accounts ?? []).map((account) => {
          const local = harness.accounts?.find((a) => a.id === account.id);
          return !account.usable && local?.usable ? { ...local, ...account, usable: true } : account;
        }), ...(harness.accounts ?? []).filter((a) => !existing.accounts?.some((known) => known.id === a.id))];
        existing.usable ||= harness.usable;
      } else if (!existing.usable) existing.usable = harness.usable;
    }
    self.online = self.hasCheckout = true;
    state.loadingAccounts = false;
    state.destinations = [];
    remoteRows.replaceChildren();
    harnessField.hidden = accountField.hidden = true;
    otherField.hidden = false;
    const rowFor = (parent, label, destination, detail) => {
      state.destinations.push(destination);
      const button = el("button", "launch-computer move-destination", detail ? null : label);
      if (detail) {
        button.append(el("span", "move-account-title", label), el("span", "move-account-usage", detail));
        button.setAttribute("aria-label", `${label} · ${detail}`);
        button.title = `${label} · ${detail}`;
      }
      button.type = "button";
      button.disabled = !!destination.reason;
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => {
        if (destination.reason || state.busy) return;
        state.computer = destination.computer;
        state.harness = destination.harness;
        state.account = destination.account ?? "";
        render();
      });
      state.buttons.push({ button, destination });
      parent.append(button);
    };
    for (const peer of state.peers) {
      const remote = !peer.self;
      const destinationComputer = remote ? peer.name : "";
      const reason = !peer.online ? "Offline" : remote && child.role === "conductor" && !caps.moveConductorToComputer ? `Update ${computer}'s Hook to move the conductor` : !peer.hasCheckout ? "No checkout of this project" : "";
      for (const harness of peer.harnesses ?? []) {
        if (harness.source === "claude") {
          for (const account of harness.accounts ?? []) {
            const isCurrent = peer.self && (account.current || account.current === undefined && current === "claude" && account.id === (child.account?.id ?? "default"));
            const unavailable = isCurrent ? "Current account" : reason || (!harness.usable || !account.usable ? "Account unavailable" : "");
            const percent = (value) => Number.isFinite(value) ? `${value}%` : "unknown";
            const now = Date.now();
            const windows = [
              { left: account.fiveHourLeft, resetsAt: account.fiveHourResetsAt },
              { left: account.weekLeft, resetsAt: account.weekResetsAt },
            ].filter((window) => Date.parse(window.resetsAt) > now)
              .sort((a, b) => (a.left ?? Infinity) - (b.left ?? Infinity));
            const reset = windows.length ? resetLabel(windows[0], now, { clock: true }) : "";
            const label = [account.email || account.label || account.id, account.plan, peer.self ? computer : peer.name].filter(Boolean).join(" · ");
            const detail = [`5h ${percent(account.fiveHourLeft)}`, `week ${percent(account.weekLeft)}`, reset, unavailable].filter(Boolean).join(" · ");
            rowFor(remoteRows, label, { computer: destinationComputer, harness: "claude", account: account.id, reason: unavailable }, detail);
          }
        } else if (remote || harness.source !== current) {
          rowFor(otherRows, [harnessLabel(harness.source), peer.self ? computer : peer.name, reason || (!harness.usable ? "Not available" : "")].filter(Boolean).join(" · "),
            { computer: destinationComputer, harness: harness.source, reason: reason || (!harness.usable ? "Not available" : "") });
        }
      }
      if (!(peer.harnesses ?? []).length) rowFor(otherRows, `${peer.name} · ${reason || "No usable harness or account"}`, { computer: destinationComputer, harness: "", reason: reason || "No usable harness or account" });
    }
    if (!remoteRows.children.length) remoteRows.append(el("div", "launch-note", "No Claude accounts found."));
    const selected = state.destinations.find((d) => !d.reason && d.computer === state.computer && d.harness === state.harness && (d.account ?? "") === state.account);
    if (!selected) {
      const next = selectDefault ? state.destinations.find((d) => !d.reason) : null;
      state.harness = next?.harness ?? ""; state.account = next?.account ?? ""; state.computer = next?.computer ?? "";
    }
    if (typeof result.localClaudeLogins === "number" && result.localClaudeLogins <= 1) {
      loginHint.hidden = false;
      const command = "phren bridge accounts add <name>";
      const copy = el("button", "move-copy-command", command);
      copy.type = "button"; copy.title = "Copy command";
      copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(command); copy.title = "Copied"; }
        catch { copy.title = "Select the command to copy it"; }
      });
      loginHint.append(document.createTextNode(`Only one Claude login on ${computer}. Add another with `), copy, document.createTextNode(", or continue on another computer."));
      if (localAddButton) loginHint.append(localAddButton);
    }
    render();
    await Promise.all(state.peers.filter((peer) => peer.online).map(async (peer) => {
      const name = peer.desktopName;
      if (!name) {
        const reason = `Link ${peer.name} in desktop to add accounts or open chats here.`;
        addButton(addActions, peer.name, reason);
        addActions.append(el("div", "launch-note", reason));
        return;
      }
      let peerCaps;
      try { peerCaps = peer.self ? caps : await store.capabilities(name); } catch { return; }
      if (openSheet?.backdrop !== backdrop || !peerCaps.claudeAccountAdd) return;
      if (!peer.self) addButton(addActions, name);
    }));
  } catch (error) {
    if (openSheet?.backdrop === backdrop) {
      state.loadingAccounts = false;
      remoteRows.replaceChildren(el("div", "launch-error", error?.message || "Could not load accounts."));
      render();
    }
  }
}

// ⌘K: the same sheet for the session open in Agents.
const openSession = () => {
  const session = sectionHandle("agents")?.currentSession?.();
  return session?.child?.target ? session : null;
};
registerCommand({
  id: "continue-in",
  title: "Continue this session in\u2026",
  meta: () => openSession()?.child.title || "Another harness or account",
  when: () => !!openSession(),
  run: () => { const session = openSession(); if (session) void openMoveSheet({ computer: session.computer, child: session.child }); },
});
