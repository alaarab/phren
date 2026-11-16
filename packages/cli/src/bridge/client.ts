import { request, type RequestOptions } from "node:http";
import { BridgeError, object, socketPath, type Json } from "./protocol.js";

export async function hookRequest(route: string, data?: Json, options: RequestOptions = { socketPath: socketPath() }, timeout = 75_000): Promise<Json> {
  return new Promise((resolve, reject) => {
    const payload = data === undefined ? undefined : JSON.stringify(data);
    const method = options.method ?? (payload === undefined ? "GET" : "POST");
    const req = request({ ...options, path: route, method,
      headers: { Host: "phren.local", Connection: "close", ...options.headers, ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) } }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 1_048_576) req.destroy(new BridgeError(502, "Hook response is too large."));
        else chunks.push(Buffer.from(chunk));
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const value = object(JSON.parse(Buffer.concat(chunks).toString()));
          // A remote Hook's `code` (why its Herdr is offline, say) travels on with its text.
          if (response.statusCode !== 200) throw new BridgeError(response.statusCode ?? 502,
            typeof value.error === "string" ? value.error.slice(0, 500) : "Hook rejected the request.",
            typeof value.code === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(value.code) ? { code: value.code } : undefined);
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new BridgeError(504, "Hook did not confirm the request. Do not retry a dispatch automatically.")), timeout);
    req.on("close", () => clearTimeout(timer)); req.on("error", reject); req.end(payload);
  });
}

/**
 * An owner-only action from the terminal. Once the phone signs owner actions,
 * the Hook holds this request and asks the phone to confirm it (owner-confirm.ts);
 * the command waits for that answer. Before then it goes straight through.
 */
export async function ownerHookRequest(route: string, data?: Json, method?: "POST" | "DELETE", notice: (line: string) => void = line => process.stderr.write(`${line}\n`)): Promise<Json> {
  const note = setTimeout(() => notice("Waiting for you to confirm this in Phren on your phone (2 minutes)…"), 1_500);
  try {
    return await hookRequest(route, data, { socketPath: socketPath(), ...(method ? { method } : {}), headers: { "X-Phren-Owner-Confirm": "wait" } }, 200_000);
  } finally { clearTimeout(note); }
}
