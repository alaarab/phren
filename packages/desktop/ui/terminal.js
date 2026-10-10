import { Terminal } from "/vendor/xterm/xterm.mjs";
import { FitAddon } from "/vendor/addon-fit/addon-fit.mjs";

let WebglAddon = null;
try {
  ({ WebglAddon } = await import("/vendor/addon-webgl/addon-webgl.mjs"));
} catch {
  // webgl unavailable; the terminal falls back to its canvas renderer
}

export function openTerminal(el, computerName, server) {
  el.innerHTML = "";

  const header = document.createElement("div");
  header.className = "term-header";
  const label = document.createElement("span");
  label.className = "term-label";
  label.textContent = `${computerName} \u00b7 ${server}`;
  const closeBtn = document.createElement("button");
  closeBtn.className = "pill-button";
  closeBtn.textContent = "Close";
  header.append(label, closeBtn);

  const host = document.createElement("div");
  host.className = "term-host";
  el.append(header, host);

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
    `&cols=${term.cols}&rows=${term.rows}`;
  const ws = new WebSocket(url);

  const encoder = new TextEncoder();
  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
  });
  ws.addEventListener("message", (ev) => term.write(ev.data));
  ws.addEventListener("close", () => term.write("\r\n[disconnected]\r\n"));

  function resize() {
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
    el.hidden = true;
  }

  closeBtn.addEventListener("click", close);

  return { close };
}
