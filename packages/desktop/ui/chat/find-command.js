// The palette's "Find in chat": opens find on the chat pane the owner last used.
import { registerCommand } from "../shell/palette.js";
import { activeFindPane } from "./find-bar.js";

const MAC = /mac/i.test(navigator.userAgent || navigator.platform || "") || document.documentElement.classList.contains("platform-darwin");

registerCommand({
  id: "chat.find",
  title: "Find in chat",
  group: "Commands",
  keys: MAC ? "⌘F" : "Ctrl+F",
  when: () => !!activeFindPane(),
  run: () => activeFindPane()?.open(),
});
