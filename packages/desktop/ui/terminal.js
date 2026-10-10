import { Terminal } from "/vendor/xterm/xterm.mjs";
import { FitAddon } from "/vendor/addon-fit/addon-fit.mjs";

let WebglAddon = null;
try {
  ({ WebglAddon } = await import("/vendor/addon-webgl/addon-webgl.mjs"));
} catch {
  // webgl unavailable; the terminal falls back to its canvas renderer
}

// Renders the xterm host inside `el` (the caller owns the header and the
// bottom panel chrome) and streams it to the session's server over /pty.
/** A whole Herdr/tmux server, or with `options.pane` one agent pane's own terminal (the console view). */
export function openTerminal(el, computerName, server, options = {}) {
  el.innerHTML = "";

  const host = document.createElement("div");
  host.className = "term-host";
  el.append(host);

  const term = new Terminal({
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace",
    fontSize: 13,
    cursorBlink: true,
    theme: {
      background: "#121416",
      foreground: "#ECEDEE",
      cursor: "#B994F4",
      selectionBackground: "rgba(185,148,244,0.3)",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  if (WebglAddon) {
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // keep the canvas renderer
    }
  }
  fit.fit();

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url =
    `${proto}://${location.host}/pty` +
    `?computer=${encodeURIComponent(computerName)}` +
    `&server=${encodeURIComponent(server)}` +
    (options.pane ? `&pane=${encodeURIComponent(options.pane)}` : "") +
    (options.folder ? `&folder=${encodeURIComponent(options.folder)}` : "") +
    `&cols=${term.cols}&rows=${term.rows}`;
  const ws = new WebSocket(url);

  const encoder = new TextEncoder();
  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
  });
  ws.addEventListener("message", (ev) => term.write(ev.data));
  ws.addEventListener("close", () => term.write("\r\n[disconnected]\r\n"));

  // Refit and tell the server the new size whenever the container resizes.
  function resize() {
    if (!el.clientWidth || !el.clientHeight) return; // hidden: fit would be wrong
    fit.fit();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  }

  const observer = new ResizeObserver(resize);
  observer.observe(el);
  window.addEventListener("resize", resize);

  function close() {
    observer.disconnect();
    window.removeEventListener("resize", resize);
    ws.close();
    term.dispose();
    el.innerHTML = "";
  }

  return { close };
}
