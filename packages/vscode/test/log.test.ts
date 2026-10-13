import { describe, expect, it } from "vitest";
import { phrenLog } from "../src/log";

// The vitest stub's createOutputChannel returns a plain OutputChannel without
// the LogOutputChannel level helpers. log.ts fills those in so every
// phrenLog.info/warn/error call in the extension has something to call.
describe("phrenLog", () => {
  it("exposes the log level helpers even when the host channel lacks them", () => {
    expect(typeof phrenLog.info).toBe("function");
    expect(typeof phrenLog.warn).toBe("function");
    expect(typeof phrenLog.error).toBe("function");
    expect(() => phrenLog.info("hello")).not.toThrow();
    expect(() => phrenLog.error("boom")).not.toThrow();
  });
});
