import type { BrowserInput } from "./browser-protocol.js";
import { browserId } from "./browser-recordings.js";
import type { BrowserRegistry } from "./browser-registry.js";
import { ACK_WINDOW, LatestFrame, type StreamClient } from "./simulator-stream.js";

export function streamBrowser(client: StreamClient, query: URLSearchParams, registry: BrowserRegistry): void {
  let id: string, explicit: string | null;
  const ack = query.get("ack") === "1";
  try {
    id = browserId(query.get("browser")); explicit = query.get("page");
    if (explicit !== null) browserId(explicit);
    if (query.has("ack") && !["0", "1"].includes(query.get("ack")!)) throw new Error("Invalid ack");
  } catch { client.close(1008, "Invalid browser stream request"); return; }
  const browser = registry.get(id);
  let page = explicit ? browser?.pages.find(p => p.id === explicit && p.live) : browser?.pages.filter(p => p.live).at(-1);
  if (!browser?.live || (explicit && !page)) { client.close(1008, "Browser or page unavailable"); return; }
  const latest = new LatestFrame((frame, done) => {
    if (client.readyState !== 1) { done(new Error("closed")); return; }
    client.send(frame, { binary: true }, done);
  }, { window: ack ? ACK_WINDOW : 1, acked: ack });
  const connection = {};
  let inputWindow = 0, inputCount = 0;
  let closed = false;
  const text = (value: object) => { if (client.readyState === 1) client.send(JSON.stringify(value), { binary: false }); };
  const end = () => { if (closed) return; closed = true; latest.close(); registry.off("change", change); registry.off("frame", frame); registry.off("control", control); registry.release(id, connection, "disconnected"); };
  const change = (changed: string) => {
    if (changed !== id || closed) return;
    if (!browser.live) { end(); client.close(1000, "Browser closed"); return; }
    const next = explicit ? browser.pages.find(p => p.id === explicit && p.live) : browser.pages.filter(p => p.live).at(-1);
    if (!next) { page = undefined; latest.discardWaiting(); return; }
    if (next.id !== page?.id) {
      // Keep the acknowledgement window across page switches; an ack may be for the old page.
      latest.discardWaiting(); page = next;
      text({ type: "page", page: next.id, url: next.url, title: next.title });
      const last = registry.last(id, next.id); if (last) latest.offer(last);
    } else text({ type: "page", page: next.id, url: next.url, title: next.title });
  };
  const control = (changed: string) => { if (changed === id && !closed) text(registry.controlState(id, connection)); };
  const frame = (browserId: string, pageId: string, jpeg: Buffer) => { if (browserId === id && pageId === page?.id) latest.offer(jpeg); };
  registry.on("change", change); registry.on("frame", frame); registry.on("control", control);
  client.once("close", end); client.once("error", end);
  client.on("message", (data, binary) => {
    if (closed || binary || data.length > 16_384) return;
    try {
      const message = JSON.parse(data.toString());
      if (message.type === "ack") { latest.ack(); return; }
      if (message.type === "control") {
        if (message.action === "take") registry.take(id, connection);
        else if (message.action === "release") registry.release(id, connection);
        return;
      }
      if (message.type !== "input") return;
      if (registry.controlState(id, connection).holder !== "you") { text({ type: "error", message: "Take control first" }); return; }
      const now = Date.now(); if (now - inputWindow >= 1000) { inputWindow = now; inputCount = 0; }
      if (++inputCount > 60 || !page) return;
      const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
      const clamp = (n: number) => Math.max(0, Math.min(1, n));
      let event: Record<string, unknown>;
      if (message.event === "click" || message.event === "wheel") {
        if (!finite(message.x) || !finite(message.y)) return;
        if (message.event === "wheel" && (!finite(message.dx) || !finite(message.dy))) return;
        event = { event: message.event, x: clamp(message.x), y: clamp(message.y), ...(message.event === "wheel" ? { dx: Math.max(-5, Math.min(5, message.dx)), dy: Math.max(-5, Math.min(5, message.dy)) } : {}) };
      } else if (message.event === "text" && typeof message.text === "string" && message.text.length <= 1000) event = { event: "text", text: message.text };
      else if (message.event === "key" && ["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(message.key)) event = { event: "key", key: message.key };
      else return;
      registry.input(id, connection, { ...event, browserId: id, pageId: page.id } as BrowserInput);
    } catch { /* Ignore malformed phone messages. */ }
  });
  text({ type: "start", format: "jpeg", browser: id, page: page?.id ?? null, url: page?.url ?? "", title: page?.title ?? "", width: page?.width ?? 0, height: page?.height ?? 0, ack });
  control(id);
  if (page) { const last = registry.last(id, page.id); if (last) latest.offer(last); }
}
