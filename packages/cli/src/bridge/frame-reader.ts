/** A frame larger than this is a broken helper, not a frame. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Splits a helper's stdout into records: a 4-byte big-endian length, then that
 * many bytes. Pipes deliver arbitrary chunks, so a record may span many, and a
 * chunk may hold several. The simulator forwards the payloads as JPEG frames;
 * the Mac window stream reads the same shape, but each record starts with a tag
 * byte and its cap is the 24576-byte wire message plus that tag.
 */
export class FrameReader {
  private buffered: Buffer[] = [];
  private bytes = 0;
  constructor(private readonly maxFrameBytes: number = MAX_FRAME_BYTES) {}

  push(chunk: Buffer): Buffer[] {
    this.buffered.push(chunk); this.bytes += chunk.length;
    const frames: Buffer[] = [];
    while (this.bytes >= 4) {
      const head = this.buffered[0].length >= 4 ? this.buffered[0] : Buffer.concat(this.buffered);
      const length = head.readUInt32BE(0);
      if (length === 0 || length > this.maxFrameBytes) throw new Error(`frame of ${length} bytes`);
      if (this.bytes < 4 + length) break;
      const all = this.buffered.length === 1 ? this.buffered[0] : Buffer.concat(this.buffered);
      frames.push(all.subarray(4, 4 + length));
      const rest = all.subarray(4 + length);
      this.buffered = rest.length ? [rest] : []; this.bytes = rest.length;
    }
    return frames;
  }

  /** Bytes held for a record that has not completed yet. */
  pending(): number { return this.bytes; }

  /** The helper's stdout ended: a partially written record is a broken helper. */
  finish(): void {
    if (this.bytes > 0) throw new Error(`trailing ${this.bytes} bytes`);
  }
}
