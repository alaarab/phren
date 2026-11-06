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
  let closed = false;
  const text = (value: object) => { if (client.readyState === 1) client.send(JSON.stringify(value), { binary: false }); };
  const end = () => { if (closed) return; closed = true; latest.close(); registry.off("change", change); registry.off("frame", frame); };
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
  const frame = (browserId: string, pageId: string, jpeg: Buffer) => { if (browserId === id && pageId === page?.id) latest.offer(jpeg); };
  registry.on("change", change); registry.on("frame", frame);
  client.once("close", end); client.once("error", end);
  client.on("message", (data, binary) => {
    if (binary || data.length > 64) return;
    try { if (JSON.parse(data.toString()).type === "ack") latest.ack(); } catch { /* ignore */ }
  });
  text({ type: "start", format: "jpeg", browser: id, page: page?.id ?? null, url: page?.url ?? "", title: page?.title ?? "", width: page?.width ?? 0, height: page?.height ?? 0, ack });
  if (page) { const last = registry.last(id, page.id); if (last) latest.offer(last); }
}
