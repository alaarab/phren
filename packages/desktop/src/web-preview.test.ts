import { connect, createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Computer } from "./contract.js";
import { closeAllPreviews, closePreview, getPreview, listPreviews, openPreview } from "./web-preview.js";

const LOCAL: Computer = { name: "This computer", local: true, server: "default" };

function echoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((socket) => socket.pipe(socket));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

/** Write `text` and resolve with the first `text.length` bytes echoed back. */
function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let received = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(text));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.length >= text.length) { socket.end(); resolve(received.slice(0, text.length)); }
    });
    socket.on("error", reject);
  });
}

/** Write `text` and resolve with everything received until the relay closes. */
function exchange(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let received = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(text));
    socket.on("data", (chunk: string) => (received += chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => resolve(received));
  });
}

afterEach(() => closeAllPreviews());

describe("openPreview", () => {
  it("relays bytes both ways to a local echo server", async () => {
    const echo = await echoServer();
    try {
      const preview = await openPreview(LOCAL, echo.port);
      expect(preview.computer).toBe("This computer");
      expect(preview.port).toBe(echo.port);
      expect(preview.localPort).toBeGreaterThan(0);
      expect(preview.url).toBe(`http://127.0.0.1:${preview.localPort}/`);

      const head = (body: string) => `GET / HTTP/1.1\r\nHost: 127.0.0.1:${preview.localPort}\r\n\r\n${body}`;
      expect(await roundTrip(preview.localPort, head("hello preview\n"))).toBe(head("hello preview\n"));
      // A second connection is handled independently.
      expect(await roundTrip(preview.localPort, head("again\n"))).toBe(head("again\n"));

      expect(listPreviews()).toHaveLength(1);
      expect(getPreview(preview.id)?.localPort).toBe(preview.localPort);
    } finally {
      await echo.close();
    }
  });

  it("rejects an invalid port", async () => {
    await expect(openPreview(LOCAL, 0)).rejects.toThrow("Invalid port.");
    await expect(openPreview(LOCAL, 70000)).rejects.toThrow("Invalid port.");
  });

  it("refuses any Host but its own 127.0.0.1 port, so the app's localhost cookie is never relayed", async () => {
    let connected = 0;
    const upstream = createServer((socket) => { connected += 1; socket.destroy(); });
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
    const address = upstream.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const preview = await openPreview(LOCAL, port);
      for (const host of [`localhost:${preview.localPort}`, "evil.example", `127.0.0.1:${preview.localPort + 1}`]) {
        const reply = await exchange(preview.localPort, `GET / HTTP/1.1\r\nHost: ${host}\r\nCookie: phren_desktop=secret\r\n\r\n`);
        expect(reply.startsWith("HTTP/1.1 421")).toBe(true);
      }
      const doubled = await exchange(preview.localPort, `GET / HTTP/1.1\r\nHost: 127.0.0.1:${preview.localPort}\r\nHost: localhost:${preview.localPort}\r\n\r\n`);
      expect(doubled.startsWith("HTTP/1.1 421")).toBe(true);
      expect(connected).toBe(0);
    } finally {
      await new Promise<void>((done) => upstream.close(() => done()));
    }
  });

  it("closes a preview and forgets it", async () => {
    const echo = await echoServer();
    try {
      const preview = await openPreview(LOCAL, echo.port);
      expect(closePreview(preview.id)).toBe(true);
      expect(closePreview(preview.id)).toBe(false);
      expect(listPreviews()).toHaveLength(0);
      expect(getPreview(preview.id)).toBeUndefined();
    } finally {
      await echo.close();
    }
  });
});
