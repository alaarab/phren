import { describe, expect, it } from "vitest";
import { noteLines } from "../electron/updates.js";
import { updateView } from "../ui/shell/update-chip.js";

describe("release notes", () => {
  it("turns the GitHub release body into plain lines without the install link", () => {
    const html = "<ul>\n<li>Summon Phren with <strong>⌘K</strong> open</li>\n<li>A menu bar icon &amp; tray</li>\n</ul>\n<p>Install: <a href=\"https://example.com\">https://example.com</a></p>";
    expect(noteLines(html)).toEqual(["- Summon Phren with ⌘K open", "- A menu bar icon & tray"]);
    expect(noteLines([{ version: "0.1.7", note: "<p>One fix</p>" }])).toEqual(["One fix"]);
    expect(noteLines(null)).toEqual([]);
  });
});

describe("updateView", () => {
  it("offers a download to a build that cannot update itself and a restart once downloaded", () => {
    const download = updateView({ version: "0.1.7", current: "0.1.6", notes: ["- One fix"], action: "download" });
    expect(download).toMatchObject({ chip: "Phren 0.1.7", button: "Download", notes: ["One fix"] });
    expect(updateView({ version: "0.1.7", current: "0.1.6", notes: [], action: "restart" })).toMatchObject({ chip: "Restart for 0.1.7", button: "Restart to update" });
  });
});
