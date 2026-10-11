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

      expect(await roundTrip(preview.localPort, "hello preview\n")).toBe("hello preview\n");
      // A second connection is handled independently.
      expect(await roundTrip(preview.localPort, "again\n")).toBe("again\n");

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
