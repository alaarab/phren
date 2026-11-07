import { el } from "../dom.js";
import { controlState, fittedFrame, normalizedPoint, wheelCoalescer } from "./logic.js";

const KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

export function mountLive(root, computer, browser) {
  root.classList.add("br-view");
  const help = el("div", "br-help"), helpText = el("span");
  const helpTake = el("button", "br-button", "Take control"); help.append(helpText, helpTake);
  const bar = el("div", "br-toolbar"), title = el("strong"), url = el("span", "br-url");
  const driving = el("span", "br-driving"), take = el("button", "br-button", "Take control"), done = el("button", "br-button", "Done");
  bar.append(title, url, driving, take, done);
  const error = el("div", "br-error"); error.setAttribute("role", "status");
  const screen = el("div", "br-screen");
  screen.setAttribute("role", "group"); screen.setAttribute("aria-label", "Live browser. Take control to type, click or scroll. Escape twice releases control.");
  const image = el("img", "br-image"); image.alt = "Live browser screen"; image.draggable = false;
  const keyboard = el("textarea", "br-keyboard");
  keyboard.setAttribute("aria-label", "Browser keyboard input");
  keyboard.autocapitalize = "off"; keyboard.autocomplete = "off"; keyboard.spellcheck = false;
  const status = el("span", "br-screen-status", "Connecting…"); screen.append(image, keyboard, status);
  const hint = el("p", "br-note", "Focus the screen to type. Escape twice or Done returns control to the agent.");
  const nav = el("ol", "br-navigation"); nav.setAttribute("aria-label", "Navigations");
  root.append(help, bar, error, screen, hint, nav);
  let state = { connected: false, holder: null, help: browser.help ?? null, error: "" };
  let socket = null, visible = false, online = true, disposed = false, frameUrl = null, escAt = -Infinity, decoding = false;
  let lastPage = "", pending = false, hasFrame = false;
  const send = (message) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
  const wheel = wheelCoalescer(event => { if (state.holder === "you") send({ type: "input", event: "wheel", ...event }); });
  function update(message) {
    const wasDriving = state.holder === "you";
    state = controlState(state, message);
    if (message.type === "control" || message.type === "closed" || message.type === "error") pending = false;
    if (state.holder !== "you") { wheel.cancel(); escAt = -Infinity; keyboard.value = ""; }
    help.hidden = !state.help;
    helpText.textContent = `${browser.session || "Agent"} needs you: ${state.help?.reason ?? ""}`;
    helpTake.hidden = state.holder === "you";
    helpTake.disabled = take.disabled = !state.connected || pending;
    take.hidden = state.holder === "you"; done.hidden = state.holder !== "you";
    take.textContent = state.holder === "other" ? "Take over" : "Take control";
    driving.textContent = state.holder === "you" ? "You're driving" : state.holder === "other" ? "Driving on another device" : "Watching";
    error.textContent = state.error; error.hidden = !state.error;
    screen.classList.toggle("br-controlling", state.holder === "you");
    keyboard.readOnly = state.holder !== "you";
    if (!wasDriving && state.holder === "you") keyboard.focus();
  }
  function release() {
    // Also cancels a take whose confirmation is still in flight on this socket.
    send({ type: "control", action: "release" }); pending = false; wheel.cancel();
    update({ type: "released" });
  }
  function takeControl() {
    if (!state.connected || pending) return;
    pending = true; send({ type: "control", action: "take" }); update({ type: "taking" });
  }
  take.onclick = helpTake.onclick = takeControl; done.onclick = release;
  function page(message) {
    title.textContent = message.title || "Browser"; url.textContent = message.url || ""; url.title = message.url || "";
    const key = `${message.page}|${message.url}`;
    if (key !== lastPage && message.url) {
      lastPage = key; nav.append(el("li", "", `${message.title || message.url} · ${message.url}`));
      if (nav.children.length > 200) nav.firstChild.remove();
    } else if (nav.lastChild && message.url) nav.lastChild.textContent = `${message.title || message.url} · ${message.url}`;
  }
  function connect() {
    if (disposed || !visible || !online || socket) return;
    retry.hidden = true;
    status.textContent = hasFrame ? "Reconnecting…" : "Connecting…"; status.hidden = false;
    const query = new URLSearchParams({ browser: browser.id, ack: "1" });
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/hosts/${encodeURIComponent(computer)}/v1/browsers/stream?${query}`);
    socket = ws; ws.binaryType = "blob";
    ws.onopen = () => { if (socket === ws) update({ type: "connected" }); };
    ws.onmessage = (event) => {
      if (socket !== ws) return;
      if (typeof event.data === "string") {
        let message; try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === "start" || message.type === "page") page(message);
        else update(message);
        return;
      }
      // Decode one image at a time; every received frame gets an ack, even a skipped one.
      if (decoding) { send({ type: "ack" }); return; }
      decoding = true;
      if (frameUrl) URL.revokeObjectURL(frameUrl);
      frameUrl = URL.createObjectURL(event.data);
      image.onload = image.onerror = () => {
        decoding = false;
        if (socket !== ws) return;
        hasFrame = image.naturalWidth > 0;
        status.hidden = hasFrame;
        if (!hasFrame) status.textContent = "Couldn't decode browser frame";
        send({ type: "ack" });
      };
      image.src = frameUrl;
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null; update({ type: "closed" }); status.hidden = false; status.textContent = "Browser disconnected";
      retry.hidden = false;
    };
    ws.onerror = () => { if (socket === ws) update({ type: "error", message: "Couldn't connect to the browser." }); };
  }
  function disconnect() {
    release(); const ws = socket; socket = null;
    if (ws) { ws.onmessage = null; ws.close(); }
    decoding = false; image.onload = image.onerror = null;
    if (frameUrl) { URL.revokeObjectURL(frameUrl); frameUrl = null; }
    update({ type: "closed" });
  }
  const retry = el("button", "br-button", "Reconnect"); retry.hidden = true;
  retry.onclick = () => { retry.hidden = true; connect(); }; bar.append(retry);
  const point = (event) => hasFrame ? normalizedPoint(screen.getBoundingClientRect(), image.naturalWidth, image.naturalHeight, event.clientX, event.clientY) : null;
  screen.onclick = (event) => {
    if (event.target !== keyboard) keyboard.focus();
    const p = point(event);
    if (state.holder === "you" && p) send({ type: "input", event: "click", ...p });
  };
  screen.addEventListener("wheel", (event) => {
    if (state.holder !== "you") return;
    const p = point(event); if (!p) return;
    event.preventDefault();
    const fit = fittedFrame(screen.getBoundingClientRect(), image.naturalWidth, image.naturalHeight);
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? fit.height : 1;
    wheel.add({ ...p, dx: event.deltaX * unit / fit.width, dy: event.deltaY * unit / fit.height });
  }, { passive: false });
  screen.addEventListener("keydown", (event) => {
    if (state.holder !== "you" || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    // Shift+Tab reaches Done locally; Tab by itself belongs to the browser.
    if (event.key === "Tab" && event.shiftKey) return;
    if (KEYS.has(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape") {
        const now = performance.now();
        if (now - escAt < 700) { release(); return; }
        escAt = now;
      } else escAt = -Infinity;
      send({ type: "input", event: "key", key: event.key });
    } else if (event.key.length === 1) {
      event.preventDefault(); event.stopPropagation(); escAt = -Infinity;
      send({ type: "input", event: "text", text: event.key });
    }
  });
  function composedText() {
    const text = keyboard.value; keyboard.value = "";
    if (state.holder !== "you") return;
    for (let at = 0; at < text.length; at += 1000) send({ type: "input", event: "text", text: text.slice(at, at + 1000) });
  }
  keyboard.addEventListener("input", event => { if (!event.isComposing) composedText(); });
  keyboard.addEventListener("compositionend", composedText);
  screen.addEventListener("paste", (event) => {
    if (state.holder !== "you") return;
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    for (let at = 0; at < text.length; at += 1000) send({ type: "input", event: "text", text: text.slice(at, at + 1000) });
  });
  const blur = () => disconnect();
  const focus = () => { if (visible) connect(); };
  const visibility = () => { if (document.hidden) disconnect(); else if (visible) connect(); };
  window.addEventListener("blur", blur); window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visibility);
  page({ ...browser.pages?.filter(p => p.live).at(-1), page: browser.pages?.at(-1)?.id }); update({ type: "initial" });
  return {
    show() { visible = true; connect(); }, hide() { visible = false; disconnect(); }, focus() { keyboard.focus(); },
    setOnline(value) {
      online = value;
      if (online) connect();
      else { disconnect(); status.hidden = false; status.textContent = `${computer} is offline`; retry.hidden = true; }
    },
    close() {
      disposed = true; visible = false; disconnect();
      window.removeEventListener("blur", blur); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visibility);
    },
  };
}
