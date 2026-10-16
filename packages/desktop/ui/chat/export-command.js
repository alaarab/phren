// The palette's "Copy chat as Markdown" and "Save chat as Markdown…": act on the chat pane the owner last used.
import { registerCommand } from "../shell/palette.js";
import { activeExportPane } from "./markdown-export.js";

registerCommand({
  id: "chat.copy-markdown",
  title: "Copy chat as Markdown",
  group: "Commands",
  when: () => !!activeExportPane(),
  run: () => activeExportPane()?.copy(),
});
registerCommand({
  id: "chat.save-markdown",
  title: "Save chat as Markdown…",
  group: "Commands",
  when: () => !!activeExportPane(),
  run: () => activeExportPane()?.save(),
});
