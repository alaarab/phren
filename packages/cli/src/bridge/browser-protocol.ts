import { z } from "zod";

export const BROWSER_ID = /^[A-Za-z0-9_-]{8,64}$/;
const id = z.string().regex(BROWSER_ID);
const text = z.string().max(16_384);
const size = z.number().int().min(0).max(32_768);
const base = { browserId: id };
const schemas = {
  1: z.object({ ...base, v: z.literal(1), pid: z.number().int().positive(), session: text, cwd: text, engine: z.literal("chromium"), headless: z.boolean(), playwright: text }),
  2: z.object({ ...base, pageId: id, url: text, title: text, width: size, height: size }),
  3: z.object({ ...base, pageId: id, t: z.number().finite().nonnegative(), width: size, height: size }),
  4: z.object({ ...base, pageId: id.optional() }),
};
export type Hello = z.infer<typeof schemas[1]>;
export type PageInfo = z.infer<typeof schemas[2]>;
export type FrameInfo = z.infer<typeof schemas[3]>;
export type BrowserMessage = { type: 1; data: Hello } | { type: 2; data: PageInfo } | { type: 3; data: FrameInfo; jpeg: Buffer } | { type: 4; data: z.infer<typeof schemas[4]> };
export const MAX_BROWSER_MESSAGE = 4 * 1024 * 1024;

/** Incremental framing; reject lengths before allocating the claimed body. */
export class BrowserMessageReader {
  private buffer: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): BrowserMessage[] {
    const messages: BrowserMessage[] = [];
    // Consume in bounded slices even if a sender coalesces many messages.
    while (chunk.length) {
      const needed = this.buffer.length < 4 ? 4 : 4 + this.buffer.readUInt32BE(0);
      const take = Math.min(chunk.length, needed - this.buffer.length);
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(0, take)]);
      chunk = chunk.subarray(take);
      if (this.buffer.length < 4) continue;
      const length = this.buffer.readUInt32BE(0);
      if (length < 2 || length > MAX_BROWSER_MESSAGE) throw new Error("Invalid browser message length");
      if (this.buffer.length < length + 4) continue;
      const body = this.buffer.subarray(4), type = body[0];
      if (type === 3) {
        if (body.length < 6) throw new Error("Invalid browser frame");
        const j = body.readUInt32BE(1);
        if (!j || j > body.length - 6) throw new Error("Invalid browser frame header");
        const data = schemas[3].parse(JSON.parse(body.subarray(5, 5 + j).toString("utf8")));
        const jpeg = body.subarray(5 + j);
        if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) throw new Error("Invalid JPEG");
        messages.push({ type, data, jpeg });
      } else if (type === 1 || type === 2 || type === 4) {
        messages.push({ type, data: schemas[type].parse(JSON.parse(body.subarray(1).toString("utf8"))) } as BrowserMessage);
      } else throw new Error("Unknown browser message");
      this.buffer = Buffer.alloc(0);
    }
    return messages;
  }
}
