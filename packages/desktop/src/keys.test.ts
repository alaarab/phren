import { describe, expect, it } from "vitest";
import { desktopKeyLine, removePeer, upsertPeer } from "./keys.js";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOk6rp5mZR9NnYyyPgxvdi6cGYXJqjcnO5YtupyDMgcQ";
const peer = (name: string, address = "box") => ({ name, address, username: "me", port: 22, hostKey: KEY, server: "default" });

describe("desktopKeyLine", () => {
  it("is the Hook's restricted forced-command line with the desktop comment", () => {
    expect(desktopKeyLine(`${KEY} someone@laptop`, "phren-desktop:Mac"))
      .toBe(`restrict,pty,command="sh ~/.local/share/phren/bridge/dispatch" ${KEY} phren-desktop:Mac`);
  });

  it("refuses anything but one ed25519 key", () => {
    expect(() => desktopKeyLine("ssh-rsa AAAAB3NzaC1yc2E", "phren-desktop:Mac")).toThrow();
    expect(() => desktopKeyLine(`${KEY}\nssh-ed25519 AAAA`, "phren-desktop:Mac")).toThrow();
    expect(() => desktopKeyLine("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5", "phren-desktop:Mac")).toThrow();
  });
});

describe("desktop.yaml edits", () => {
  it("adds, replaces by name and removes", () => {
    const one = upsertPeer(undefined, peer("Desk"));
    expect(one).toEqual({ version: 1, computers: [peer("Desk")] });
    const two = upsertPeer(one, peer("NAS"));
    expect(upsertPeer(two, peer("Desk", "new")).computers.map(c => c.address)).toEqual(["new", "box"]);
    expect(removePeer(two, "Desk").computers.map(c => c.name)).toEqual(["NAS"]);
    expect(removePeer(two, "Missing").computers).toHaveLength(2);
  });
});
