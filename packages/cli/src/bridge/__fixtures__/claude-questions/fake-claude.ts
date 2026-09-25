import type { DialogQuestion } from "../../claude-question-dialog.js";

/** Claude Code's question dialog as observed: a digit picks a single-select
 * row and moves on, toggles a multi-select box, and Tab leaves a
 * multi-select question (or moves from its typed row to Next). */
export class FakeClaude {
  tab = 0; cursor: number | "next" = 1;
  picked: (string | undefined)[]; boxes: boolean[][]; typed: string[]; typedOn: boolean[];
  result?: Record<string, string | string[]>; cancelled = false; sent: string[][] = [];
  constructor(readonly questions: DialogQuestion[]) {
    this.picked = questions.map(() => undefined); this.boxes = questions.map(q => q.options.map(() => false));
    this.typed = questions.map(() => ""); this.typedOn = questions.map(() => false);
  }
  get gone() { return !!this.result || this.cancelled; }
  get review() { return this.questions.length > 1 || this.questions.some(q => q.multiSelect); }
  value(index: number) {
    const q = this.questions[index];
    if (!q.multiSelect) return this.picked[index];
    const values = q.options.filter((_, i) => this.boxes[index][i]).map(o => o.label);
    return [...values, ...(this.typedOn[index] && this.typed[index] ? [this.typed[index]] : [])];
  }
  private advance() {
    this.tab += 1; this.cursor = 1;
    if (!this.review && this.tab >= this.questions.length) this.submit();
  }
  private submit() { this.result = Object.fromEntries(this.questions.map((q, i) => [q.question, this.value(i)!])); }
  press(key: string) {
    if (this.gone) return;
    if (key === "esc") { this.cancelled = true; return; }
    if (this.tab >= this.questions.length) {
      if (key === "1") this.submit(); else if (key === "2") this.cancelled = true;
      else if (key === "left") { this.tab -= 1; this.cursor = 1; }
      return;
    }
    const q = this.questions[this.tab], n = q.options.length, other = n + 1;
    if (key === "right" || key === "left") { this.tab = Math.max(0, Math.min(this.questions.length - (this.review ? 0 : 1), this.tab + (key === "right" ? 1 : -1))); this.cursor = 1; return; }
    if (key === "up" || key === "down") {
      const at = this.cursor === "next" ? other + 1 : this.cursor, to = Math.max(1, Math.min(q.multiSelect ? other + 1 : other, at + (key === "down" ? 1 : -1)));
      this.cursor = to === other + 1 ? "next" : to; return;
    }
    if (key === "tab") { if (q.multiSelect && this.cursor === other) this.cursor = "next"; else this.advance(); return; }
    if (this.cursor === other && (key === "space" || !/^(enter|[1-9])$/.test(key) || (this.typed[this.tab] && /^[1-9]$/.test(key)))) {
      this.typed[this.tab] += key === "space" ? " " : key;
      if (q.multiSelect) this.typedOn[this.tab] = true;
      return;
    }
    if (key === "enter") {
      if (this.cursor === "next") return this.advance();
      if (q.multiSelect) { if (this.cursor <= n) this.boxes[this.tab][this.cursor - 1] = !this.boxes[this.tab][this.cursor - 1]; return; }
      this.picked[this.tab] = this.cursor === other ? this.typed[this.tab] : q.options[this.cursor - 1].label;
      return this.advance();
    }
    const digit = Number(key);
    if (!(digit >= 1 && digit <= other)) return;
    if (q.multiSelect) { if (digit === other) this.typedOn[this.tab] = !this.typedOn[this.tab]; else this.boxes[this.tab][digit - 1] = !this.boxes[this.tab][digit - 1]; return; }
    if (digit === other) { this.cursor = other; return; }
    this.picked[this.tab] = q.options[digit - 1].label; this.advance();
  }
  render(): string {
    if (this.gone) return "⏺ User answered Claude's questions:\n\n❯ \n  ⏸ manual mode on";
    const tabs = this.questions.map((q, i) => `${this.value(i)?.length ? "☒" : "☐"} ${q.question.split(" ")[1] ?? "Q"}`);
    const bar = this.review ? `←  ${tabs.join("  ")}  ✔ Submit  →` : ` ${tabs[0]}`;
    if (this.tab >= this.questions.length) {
      return [bar, "", "Review your answers", "", ...this.questions.flatMap((q, i) => {
        const value = this.value(i);
        return [` ● ${q.question}`, ...(value?.length ? [`   → ${Array.isArray(value) ? value.join(", ") : value}`] : [])];
      }), "", "Ready to submit your answers?", "", "❯ 1. Submit answers", "  2. Cancel"].join("\n");
    }
    const q = this.questions[this.tab], n = q.options.length, mark = (row: number | "next") => this.cursor === row ? "❯" : " ";
    const rows = q.options.flatMap((o, i) => q.multiSelect
      ? [`${mark(i + 1)} ${i + 1}. [${this.boxes[this.tab][i] ? "✔" : " "}] ${o.label}`, `         ${o.label}`]
      : [`${mark(i + 1)} ${i + 1}. ${o.label}${this.picked[this.tab] === o.label ? " ✔" : ""}`, `     ${o.label}`]);
    const typed = this.typed[this.tab];
    const other = q.multiSelect ? [`${mark(n + 1)} ${n + 1}. [${this.typedOn[this.tab] ? "✔" : " "}] ${typed || "Type something"}`, `${mark("next")}    Next`]
      : [`${mark(n + 1)} ${n + 1}. ${typed || "Type something."}`];
    return [bar, "", q.question, "", ...rows, ...other, "─".repeat(40), `  ${n + 2}. Chat about this`, "",
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"].join("\n");
  }
  io() {
    return {
      read: async () => this.render(),
      keys: async (keys: string[]) => {
        this.sent.push(keys);
        // Ink reads several digits in one write as one input and ignores it.
        if (keys.length > 1 && keys.every(key => /^[1-9]$/.test(key))) return;
        for (const key of keys) this.press(key);
      },
      sleep: async () => {},
    };
  }
}
