import { request, type RequestOptions } from "node:http";
import { BridgeError, object, socketPath, type Json } from "./protocol.js";

export async function hookRequest(route: string, data?: Json, options: RequestOptions = { socketPath: socketPath() }, timeout = 75_000): Promise<Json> {
  return new Promise((resolve, reject) => {
    const payload = data === undefined ? undefined : JSON.stringify(data);
    const method = options.method ?? (payload === undefined ? "GET" : "POST");
    const req = request({ ...options, path: route, method,
      headers: { Host: "phren.local", Connection: "close", ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) } }, response => {
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
          if (response.statusCode !== 200) throw new BridgeError(response.statusCode ?? 502,
            typeof value.error === "string" ? value.error.slice(0, 500) : "Hook rejected the request.");
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new BridgeError(504, "Hook did not confirm the request. Do not retry a dispatch automatically.")), timeout);
    req.on("close", () => clearTimeout(timer)); req.on("error", reject); req.end(payload);
  });
}
