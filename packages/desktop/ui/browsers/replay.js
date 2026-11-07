import { el } from "../dom.js";
import { hookGet } from "../api.js";
import { duration, frameAtTime } from "./logic.js";

export function mountReplay(root, computer, recording) {
  root.classList.add("br-view");
  const heading = el("div", "br-toolbar", `Recording · ${new Date(recording.startedAt).toLocaleString()} · ${recording.session || "Agent"}`);
  const url = el("div", "br-url");
  const screen = el("div", "br-screen"), image = el("img", "br-image"); image.alt = "Recorded browser screen";
  const status = el("div", "br-screen-status", "Loading recording…"); status.setAttribute("role", "status"); screen.append(image, status);
  const controls = el("div", "br-toolbar"), play = el("button", "br-button", "Play");
  const scrub = el("input", "br-scrub"); scrub.type = "range"; scrub.min = "0"; scrub.max = "0"; scrub.step = "1"; scrub.value = "0";
  scrub.setAttribute("aria-label", "Recording frame"); scrub.disabled = play.disabled = true;
  const time = el("span", "br-note"); controls.append(play, scrub, time);
  const markers = el("ol", "br-navigation"); markers.setAttribute("aria-label", "Recording timeline");
  root.append(heading, url, screen, controls, markers);
  const abort = new AbortController();
  let frames = [], meta = recording, current = -1, timer = null, active = false, closed = false;
  function pause() { clearTimeout(timer); timer = null; play.textContent = "Play"; }
  function show(index) {
    if (!frames.length || closed) return;
    current = Math.max(0, Math.min(frames.length - 1, index));
    const frame = frames[current]; scrub.value = String(current);
    time.textContent = `${duration(frame.t - meta.startedAt)} / ${duration((meta.endedAt ?? frames.at(-1).t) - meta.startedAt)}`;
    scrub.setAttribute("aria-valuetext", time.textContent);
    const nav = (meta.navigations ?? meta.pages ?? []).filter(n => n.pageId === frame.pageId && n.t <= frame.t).at(-1);
    url.textContent = nav ? `${nav.title || "Browser"} · ${nav.url}` : "Browser recording";
    status.textContent = "Loading frame…"; status.hidden = false;
    image.src = `/hosts/${encodeURIComponent(computer)}/v1/browsers/recordings/frame?${new URLSearchParams({ id: recording.id, n: String(frame.n) })}`;
  }
  image.onload = () => { status.hidden = true; };
  image.onerror = () => { status.hidden = false; status.textContent = "Frame unavailable. The recording may have expired."; pause(); };
  function step() {
    if (!active || current >= frames.length - 1) { pause(); return; }
    timer = setTimeout(() => { show(current + 1); step(); }, Math.max(34, frames[current + 1].t - frames[current].t));
  }
  play.onclick = () => {
    if (timer !== null) { pause(); return; }
    if (current >= frames.length - 1) show(0);
    play.textContent = "Pause"; step();
  };
  scrub.oninput = () => { pause(); show(Number(scrub.value)); };
  void hookGet(computer, "/v1/browsers/recordings/index", { id: recording.id }, { signal: abort.signal }).then(data => {
    if (closed) return;
    meta = data.meta; frames = data.frames ?? [];
    if (!frames.length) { status.textContent = "No frames recorded."; return; }
    scrub.max = String(frames.length - 1); scrub.disabled = play.disabled = false;
    const events = [
      ...(meta.navigations ?? meta.pages ?? []).map(n => ({ ...n, label: `${n.title || "Navigation"} · ${n.url}` })),
      ...(meta.handoffs ?? []).map(h => ({ ...h, label: h.kind === "help" ? `Needs you: ${h.reason || "Help requested"}` : h.kind === "take" ? "Took control" : "Released control" })),
    ].sort((a, b) => a.t - b.t);
    for (const event of events) {
      const li = el("li"), button = el("button", "br-marker", `${duration(event.t - meta.startedAt)} · ${event.label}`);
      button.onclick = () => { pause(); show(frameAtTime(frames, event.t)); }; li.append(button); markers.append(li);
    }
    show(0);
  }).catch(error => { if (!closed) status.textContent = error.message; });
  return { show() { active = true; }, hide() { active = false; pause(); }, close() { closed = true; active = false; pause(); abort.abort(); image.removeAttribute("src"); } };
}
