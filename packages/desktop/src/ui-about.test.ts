import { describe, expect, it } from "vitest";
// @ts-expect-error Plain ESM UI module, exercised without a DOM.
import { aboutText } from "../ui/sections/settings/about.js";

describe("aboutText", () => {
  it("copies versions and states without unrelated computer details", () => {
    const computers = [
      { computer: "Mac mini", state: "online", hostname: "private.example", token: "secret",
        overview: { phren: { version: "0.3.45" }, cwd: "/private/work", url: "https://private.example" } },
      { computer: "Laptop", state: "offline" },
      { computer: "Server", state: "connecting", overview: { phren: {} } },
    ];
    expect(aboutText({ version: "0.1.7", platform: "darwin", userAgent: "Electron test", computers })).toBe(
      "Phren desktop 0.1.7\nPlatform: darwin\nUser agent: Electron test\n" +
      "Mac mini · online · Hook 0.3.45\nLaptop · offline · Hook —\nServer · connecting · Hook —",
    );
  });

  it("labels browser mode before any computers are known", () => {
    expect(aboutText({ version: undefined, platform: "MacIntel", userAgent: "Browser test", computers: [] })).toBe(
      "Phren desktop (browser)\nPlatform: MacIntel\nUser agent: Browser test",
    );
  });
});
