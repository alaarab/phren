// Find in files (phase 1c). A VS Code-like search view in Phren Charcoal.
import { hookPost, readRepoFile } from "./api.js";
import { store } from "./shell/store.js";
import { needsNewer } from "./editor.js";

const STYLE_ID = "search-style";

// Inject the stylesheet once; every colour is a Phren variable from theme.css.
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.search { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--bg); color:var(--text); font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
.search-head { display:flex; flex-direction:column; gap:10px; padding:12px; border-bottom:1px solid var(--border); }
.search-titlerow { display:flex; align-items:center; gap:8px; min-height:18px; }
.search-title { font-size:11px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
.search-replace-all { margin-left:auto; background:var(--accent-solid); color:var(--text); border:none; border-radius:8px; padding:4px 10px; font-size:12px; cursor:pointer; }
.search-confirm { display:flex; align-items:center; gap:8px; margin-left:auto; font-size:12px; color:var(--text-2); }
.search-confirm button { background:var(--raised); color:var(--text); border:1px solid var(--border-strong); border-radius:8px; padding:3px 10px; font-size:12px; cursor:pointer; }
.search-fields { display:flex; align-items:flex-start; gap:6px; }
.search-disc { background:transparent; border:none; color:var(--muted); cursor:pointer; font-size:11px; padding:0 2px; margin-top:6px; }
.search-stack { display:flex; flex-direction:column; gap:8px; flex:1; min-width:0; }
.search-field { display:flex; align-items:center; gap:6px; background:var(--sunken); border:1px solid var(--border); border-radius:10px; padding:6px 8px; }
.search-input { flex:1; min-width:0; background:transparent; border:none; outline:none; color:var(--text); font-family:"JetBrains Mono",ui-monospace,Menlo,monospace; font-size:13px; }
.search-input::placeholder { color:var(--dim); }
.search-toggles { display:flex; gap:2px; flex:none; }
.search-toggle { background:transparent; border:none; color:var(--muted); cursor:pointer; border-radius:6px; padding:2px 6px; font-family:"JetBrains Mono",ui-monospace,Menlo,monospace; font-size:12px; }
.search-toggle:hover { color:var(--text-2); }
.search-toggle.on { color:var(--accent); background:var(--raised); }
.search-toggle.word { text-decoration:underline; text-underline-offset:2px; }
.search-replace-row { display:none; }
.search.replace-open .search-replace-row { display:flex; }
.search-summary { padding:8px 12px; font-size:12px; color:var(--muted); font-family:"JetBrains Mono",ui-monospace,Menlo,monospace; }
.search-summary.error { color:var(--danger); }
.search-results { flex:1; min-height:0; overflow:auto; padding-bottom:12px; }
.search-file-head { display:flex; align-items:center; gap:6px; padding:4px 12px; min-height:28px; cursor:pointer; }
.search-file-head:hover { background:var(--surface); }
.search-caret { color:var(--muted); font-size:10px; width:10px; flex:none; }
.search-file-name { font-family:"JetBrains Mono",ui-monospace,Menlo,monospace; font-size:12.5px; color:var(--text); flex:none; }
.search-file-dir { color:var(--muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
.search-count { flex:none; background:var(--raised); color:var(--muted); border-radius:999px; padding:0 7px; font-size:11px; line-height:16px; }
.search-replace-file, .search-replace-all { display:none; }
.search.can-replace .search-replace-file { display:inline-flex; }
.search.can-replace .search-replace-all { display:inline-flex; }
.search-replace-file { flex:none; background:transparent; border:none; color:var(--muted); cursor:pointer; font-size:12px; padding:0 4px; }
.search-replace-file:hover { color:var(--accent); }
.search-row { display:flex; gap:8px; height:24px; align-items:center; padding:0 12px 0 28px; cursor:pointer; font-family:"JetBrains Mono",ui-monospace,Menlo,monospace; font-size:12.5px; white-space:nowrap; outline:none; }
.search-row:hover, .search-row:focus { background:var(--surface); }
.search-line { flex:none; min-width:34px; text-align:right; color:var(--dim); }
.search-text { overflow:hidden; text-overflow:ellipsis; color:var(--text-2); }
.search-hit { background:rgba(185,148,244,0.28); color:var(--text); border-radius:3px; }
.search [hidden] { display:none !important; }
`;
  document.head.append(style);
}

function span(cls, text) {
  const el = document.createElement("span");
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function splitPath(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function openSearch(el, ctx) {
  injectStyle();
  const target = ctx.child.target;
  const toggles = { case: false, word: false, regex: false };
  let seq = 0;         // responses older than the newest request are ignored
  let timer = 0;       // the 250 ms debounce
  let replaceOpen = false;
  let lastResults = null;
  let pendingSummary = "";

  const root = document.createElement("div");
  root.className = "search";
  root.innerHTML = `
    <div class="search-head">
      <div class="search-titlerow">
        <div class="search-title">Search</div>
        <button type="button" class="search-replace-all">Replace all</button>
        <div class="search-confirm-host search-confirm"></div>
      </div>
      <div class="search-fields">
        <button type="button" class="search-disc" title="Toggle replace">▸</button>
        <div class="search-stack">
          <div class="search-field search-query">
            <input class="search-input search-query-input" placeholder="Search" spellcheck="false" autocomplete="off">
            <div class="search-toggles">
              <button type="button" class="search-toggle case" title="Match case">Aa</button>
              <button type="button" class="search-toggle word" title="Match whole word">ab</button>
              <button type="button" class="search-toggle regex" title="Use regular expression">.*</button>
            </div>
          </div>
          <div class="search-field search-replace-row">
            <input class="search-input search-replace-input" placeholder="Replace" spellcheck="false" autocomplete="off">
          </div>
          <div class="search-field">
            <input class="search-input search-include-input" placeholder="e.g. *.ts, src/**" spellcheck="false" autocomplete="off">
          </div>
        </div>
      </div>
    </div>
    <div class="search-summary"></div>
    <div class="search-results"></div>`;

  const queryInput = root.querySelector(".search-query-input");
  const replaceInput = root.querySelector(".search-replace-input");
  const includeInput = root.querySelector(".search-include-input");
  const disc = root.querySelector(".search-disc");
  const replaceAllBtn = root.querySelector(".search-replace-all");
  const confirmHost = root.querySelector(".search-confirm-host");
  const summary = root.querySelector(".search-summary");
  const results = root.querySelector(".search-results");

  const parseInclude = () =>
    includeInput.value.split(",").map((s) => s.trim()).filter(Boolean);

  function canReplace() {
    root.classList.toggle("can-replace", replaceOpen && replaceInput.value.trim() !== "");
  }

  function clearResults() {
    lastResults = null;
    pendingSummary = "";
    results.replaceChildren();
    summary.classList.remove("error");
    summary.textContent = "";
  }

  function errorText(error) {
    if (error.status === 400) return "That regular expression is not valid.";
    if (error.status === 413) return "Too many matches. Narrow the search.";
    return error.message || "Search failed.";
  }

  function showError(error) {
    lastResults = null;
    results.replaceChildren();
    summary.classList.add("error");
    summary.textContent = errorText(error);
  }

  // The match length inside `text`: literal = query length, regex = re-run it here.
  function matchAt(text, at) {
    const query = queryInput.value;
    if (!toggles.regex) return query.length;
    try {
      const m = new RegExp(query, toggles.case ? "" : "i").exec(text.slice(at));
      return m ? m[0].length : query.length;
    } catch {
      return query.length;
    }
  }

  function lineRow(file, entry) {
    const row = document.createElement("div");
    row.className = "search-row";
    row.tabIndex = -1;
    const text = entry.text || "";
    const at = Math.max(0, (entry.column || 1) - 1 - (entry.offset || 0));
    const len = matchAt(text, at);
    const textEl = document.createElement("span");
    textEl.className = "search-text";
    textEl.append(text.slice(0, at));
    const hit = document.createElement("mark");
    hit.className = "search-hit";
    hit.textContent = text.slice(at, at + len);
    textEl.append(hit, text.slice(at + len));
    row.append(span("search-line", String(entry.line)), textEl);
    row.addEventListener("click", () => ctx.openFile(file, { line: entry.line }));
    return row;
  }

  function replaceButton(group) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "search-replace-file";
    btn.title = "Replace in file";
    btn.textContent = "⇄";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      replaceFile(group, btn);
    });
    return btn;
  }

  function renderResults(res) {
    lastResults = res;
    results.replaceChildren();
    for (const group of res.matches || []) {
      const g = document.createElement("div");
      g.className = "search-file";
      const head = document.createElement("div");
      head.className = "search-file-head";
      const caret = span("search-caret", "▾");
      const { name, dir } = splitPath(group.file);
      head.append(caret, span("search-file-name", name), span("search-file-dir", dir));
      head.append(replaceButton(group), span("search-count", String((group.lines || []).length)));
      const body = document.createElement("div");
      body.className = "search-file-body";
      for (const entry of group.lines || []) body.append(lineRow(group.file, entry));
      head.addEventListener("click", () => {
        body.hidden = !body.hidden;
        caret.textContent = body.hidden ? "▸" : "▾";
      });
      g.append(head, body);
      results.append(g);
    }
    canReplace();
    renderSummary(res);
  }

  function countLines(res) {
    return (res.matches || []).reduce((n, g) => n + (g.lines || []).length, 0);
  }

  function renderSummary(res) {
    summary.classList.remove("error");
    if (pendingSummary) {
      summary.textContent = pendingSummary;
      pendingSummary = "";
      return;
    }
    const total = res.total ?? countLines(res);
    if (!total) {
      summary.textContent = "No results";
      return;
    }
    const files = res.files ?? (res.matches || []).length;
    summary.textContent = `${total} results in ${files} files` + (res.truncated ? " · showing the first 500" : "");
  }

  async function runSearch() {
    clearTimeout(timer);
    const query = queryInput.value;
    if (!query.trim()) {
      clearResults();
      return;
    }
    const mine = ++seq;
    const body = {
      target,
      query,
      regex: toggles.regex,
      caseSensitive: toggles.case,
      wholeWord: toggles.word,
      limit: 500,
    };
    const include = parseInclude();
    if (include.length) body.include = include;
    try {
      const res = await hookPost(ctx.computer, "/v1/files/search", body);
      if (mine !== seq) return; // a newer query already answered
      renderResults(res);
    } catch (error) {
      if (mine !== seq) return;
      showError(error);
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(runSearch, 250);
  }

  // Replace on one line. Literal replacements are literal; regex uses JS semantics.
  function replaceOnLine(line, replacement) {
    const query = queryInput.value;
    if (!query) return { line, count: 0 };
    if (toggles.regex) {
      let re;
      try {
        re = new RegExp(query, toggles.case ? "g" : "gi");
      } catch {
        return { line, count: 0 };
      }
      return { line: line.replace(re, replacement), count: (line.match(re) || []).length };
    }
    const base = escapeRegExp(query);
    const re = new RegExp(toggles.word ? `\\b${base}\\b` : base, toggles.case ? "g" : "gi");
    let count = 0;
    const out = line.replace(re, () => {
      count++;
      return replacement;
    });
    return { line: out, count };
  }

  function applyReplacements(text, lineMatches) {
    const replacement = replaceInput.value;
    const lines = text.split("\n");
    const seen = new Set();
    let count = 0;
    for (const m of lineMatches || []) {
      const idx = m.line - 1;
      if (seen.has(idx) || idx < 0 || idx >= lines.length) continue;
      seen.add(idx);
      const applied = replaceOnLine(lines[idx], replacement);
      lines[idx] = applied.line;
      count += applied.count;
    }
    return { content: lines.join("\n"), count };
  }

  async function replaceFile(group, btn) {
    btn.disabled = true;
    try {
      const { text, version } = await readRepoFile(ctx.computer, target, group.file);
      const { content, count } = applyReplacements(text, group.lines);
      await hookPost(ctx.computer, "/v1/files/write", { target, path: group.file, content, version });
      pendingSummary = `Replaced ${count} matches in 1 file.`;
    } catch (error) {
      btn.disabled = false;
      summary.classList.add("error");
      summary.textContent = error.status === 409
        ? `${group.file} changed; search again.`
        : errorText(error);
      return;
    }
    runSearch();
  }

  function askReplaceAll() {
    if (!lastResults || !lastResults.total) return;
    const files = lastResults.files ?? (lastResults.matches || []).length;
    replaceAllBtn.hidden = true;
    const yes = document.createElement("button");
    yes.type = "button";
    yes.textContent = "Replace";
    const no = document.createElement("button");
    no.type = "button";
    no.textContent = "Cancel";
    const close = () => {
      confirmHost.replaceChildren();
      replaceAllBtn.hidden = false;
    };
    yes.addEventListener("click", () => {
      close();
      doReplaceAll();
    });
    no.addEventListener("click", close);
    confirmHost.append(
      span("", `Replace ${lastResults.total} matches in ${files} files?`),
      yes,
      no,
    );
  }

  async function doReplaceAll() {
    const groups = lastResults ? lastResults.matches || [] : [];
    let replaced = 0;
    let files = 0;
    const changed = [];
    for (const group of groups) {
      try {
        const { text, version } = await readRepoFile(ctx.computer, target, group.file);
        const { content, count } = applyReplacements(text, group.lines);
        if (!count) continue;
        await hookPost(ctx.computer, "/v1/files/write", { target, path: group.file, content, version });
        replaced += count;
        files++;
      } catch (error) {
        if (error.status === 409) changed.push(group.file); // skip files that moved under us
      }
    }
    pendingSummary = changed.length
      ? `${changed.join(", ")} changed; search again.`
      : `Replaced ${replaced} matches in ${files} files.`;
    runSearch();
  }

  function focusRow(index) {
    const rows = results.querySelectorAll(".search-row");
    if (rows.length) rows[Math.min(index, rows.length - 1)].focus();
  }

  // --- wiring ---
  queryInput.addEventListener("input", () => {
    pendingSummary = "";
    schedule();
  });
  includeInput.addEventListener("input", schedule);
  replaceInput.addEventListener("input", canReplace);
  queryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runSearch();
    } else if (e.key === "Escape") {
      e.preventDefault();
      queryInput.value = "";
      clearResults();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(0);
    }
  });
  results.addEventListener("keydown", (e) => {
    const rows = [...results.querySelectorAll(".search-row")];
    const i = rows.indexOf(document.activeElement);
    if (e.key === "ArrowDown" && i >= 0 && i < rows.length - 1) {
      e.preventDefault();
      rows[i + 1].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      (i <= 0 ? queryInput : rows[i - 1]).focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      queryInput.focus();
    }
  });

  function wireToggle(sel, key) {
    const btn = root.querySelector(sel);
    btn.addEventListener("click", () => {
      toggles[key] = !toggles[key];
      btn.classList.toggle("on", toggles[key]);
      schedule();
    });
  }
  wireToggle(".case", "case");
  wireToggle(".word", "word");
  wireToggle(".regex", "regex");

  disc.addEventListener("click", () => {
    replaceOpen = !replaceOpen;
    root.classList.toggle("replace-open", replaceOpen);
    disc.textContent = replaceOpen ? "▾" : "▸";
    if (replaceOpen) replaceInput.focus();
    canReplace();
  });
  replaceAllBtn.addEventListener("click", askReplaceAll);

  el.replaceChildren(root);

  // Find in files needs a Hook that declares fileSearch; without it the panel
  // is only the reason, with no input.
  store.capabilities(ctx.computer).then(() => {
    if (!store.can(ctx.computer, "fileSearch")) needsNewer(el, ctx.computer, "fileSearch");
  });

  return {
    focus() {
      queryInput.focus();
    },
    close() {
      clearTimeout(timer);
      seq++; // ignore any in-flight response
      el.replaceChildren();
    },
  };
}
