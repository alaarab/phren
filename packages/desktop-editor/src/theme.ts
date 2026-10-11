// Phren Charcoal as a real VS Code colour theme, contributed by a built-in
// extension, so extensions' own themes sit beside it in the same picker.
import { registerExtension, ExtensionHostKind } from "@codingame/monaco-vscode-api/extensions";

const theme = {
  name: "Phren Charcoal", type: "dark",
  colors: {
    "editor.background": "#141618", "editor.foreground": "#ECEDEE",
    "editorLineNumber.foreground": "#5C6168", "editorLineNumber.activeForeground": "#B994F4",
    "editor.selectionBackground": "#B994F44D", "editor.lineHighlightBackground": "#1E1E1E",
    "editorCursor.foreground": "#B994F4", "editorWidget.background": "#282A2C", "editorWidget.border": "#3C3F42",
    "editorHoverWidget.background": "#282A2C", "editorHoverWidget.border": "#3C3F42",
    "editorSuggestWidget.background": "#282A2C", "editorSuggestWidget.selectedBackground": "#3C3F42",
    "list.activeSelectionBackground": "#3C3F42", "list.hoverBackground": "#323437", "focusBorder": "#B994F4",
    "diffEditor.insertedTextBackground": "#8AC8AC33", "diffEditor.removedTextBackground": "#EF989833",
    "diffEditor.insertedLineBackground": "#8AC8AC1F", "diffEditor.removedLineBackground": "#EF98981F",
    "peekViewEditor.background": "#141618", "peekViewResult.background": "#1E1E1E", "peekView.border": "#B994F4",
    "scrollbarSlider.background": "#ECEDEE22", "scrollbarSlider.hoverBackground": "#ECEDEE33",
  },
  tokenColors: [
    { scope: ["keyword", "storage", "storage.type", "keyword.control"], settings: { foreground: "#F28B82" } },
    { scope: ["string", "constant.numeric", "constant.language"], settings: { foreground: "#7FB6F0" } },
    { scope: ["comment"], settings: { foreground: "#8B9098", fontStyle: "italic" } },
    { scope: ["entity.name.type", "entity.name.class", "support.type", "support.class"], settings: { foreground: "#F0A06E" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: "#C2AAFF" } },
    { scope: ["variable.parameter"], settings: { foreground: "#E8C07A" } },
  ],
};

export async function phrenThemeExtension(): Promise<void> {
  const { registerFileUrl, whenReady } = registerExtension({
    name: "phren-theme", publisher: "phren", version: "1.0.0", engines: { vscode: "*" },
    contributes: { themes: [{ id: "Phren Charcoal", label: "Phren Charcoal", uiTheme: "vs-dark", path: "./phren-charcoal.json" }] },
  }, ExtensionHostKind.LocalProcess);
  registerFileUrl("./phren-charcoal.json", `data:application/json;base64,${btoa(JSON.stringify(theme))}`);
  await whenReady();
}
