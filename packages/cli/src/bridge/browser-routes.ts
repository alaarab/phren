import type { ServerResponse } from "node:http";
import { BridgeError } from "./protocol.js";
import { browserId } from "./browser-recordings.js";
import type { BrowserRegistry } from "./browser-registry.js";

/** Called only after the existing Hook route authorization. */
export function browserRoute(registry: BrowserRegistry | undefined, method: string, url: URL, response: ServerResponse): void {
  if (!registry) throw new BridgeError(503, "Browser watching unavailable.");
  let result: unknown;
  const route = url.pathname;
  if (method === "GET" && route === "/v1/browsers") result = { browsers: registry.list() };
  else if (method === "GET" && route === "/v1/browsers/recordings") result = { recordings: registry.recordings.list() };
  else {
    const id = browserId(url.searchParams.get("id"));
    if (method === "DELETE" && route === "/v1/browsers/recordings") {
      registry.recordings.remove(id); response.statusCode = 204; response.end(); return;
    }
    if (method === "GET" && route === "/v1/browsers/recordings/index") {
      const { meta, frames } = registry.recordings.index(id);
      result = { meta, frames: frames.map(({ t, pageId, width, height }, n) => ({ n, t, pageId, width, height })) };
    } else if (method === "GET" && route === "/v1/browsers/recordings/frame") {
      const n = url.searchParams.get("n");
      if (n === null || !/^(0|[1-9][0-9]{0,9})$/.test(n)) throw new BridgeError(400, "Invalid frame number.");
      const bytes = registry.recordings.frameAt(id, Number(n));
      response.setHeader("Content-Type", "image/jpeg"); response.end(bytes); return;
    } else throw new BridgeError(404, "Browser route not found.");
  }
  response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
}
