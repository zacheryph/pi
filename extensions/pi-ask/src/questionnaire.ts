import {
  Input,
  Key,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  bodyRow,
  divider,
  footerRows,
  HINT_PRIORITY,
  paint,
  sanitizeLine,
  sanitizeText,
  styleLine,
  type DisposableComponent,
  type Hint,
  type UIKeys,
  type UITheme,
} from "#ui";
import type { AskAnswer, AskOutcome, AskQuestion } from "#src/questions";

export const TYPE_LABEL = "Type something…";

const firstLine = (text: string) => sanitizeLine(text.split("\n")[0] ?? "");

interface QuestionState {
  cursor: number;
  /** Single-select: the chosen option. */
  chosen?: number;
  /** Multi-select: the checked options. */
  checked: Set<number>;
  typed?: string;
  answered: boolean;
}

/**
 * Keyboard questionnaire: one question at a time, options plus a free-text row.
 * Answering moves to the next unanswered question; the last answer submits.
 */
export class Questionnaire implements DisposableComponent, Focusable {
  private index = 0;
  private typing = false;
  private hasFocus = false;
  private readonly states: QuestionState[];
  private readonly input = new Input({ placeholder: "Type your answer, enter to submit" });
  private readonly questions: readonly AskQuestion[];
  private readonly theme: UITheme;
  private readonly keys: UIKeys;
  private readonly tui: Pick<TUI, "requestRender">;
  private readonly finish: (outcome: AskOutcome) => void;

  constructor(
    questions: readonly AskQuestion[],
    theme: UITheme,
    keys: UIKeys,
    tui: Pick<TUI, "requestRender">,
    finish: (outcome: AskOutcome) => void,
  ) {
    this.questions = questions;
    this.theme = theme;
    this.keys = keys;
    this.tui = tui;
    this.finish = finish;
    this.states = questions.map(() => ({ cursor: 0, checked: new Set(), answered: false }));
    this.input.onSubmit = (value) => this.submitText(value);
    this.input.onEscape = () => this.leaveTyping();
    this.enterQuestion(0);
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.input.focused = value && this.typing;
  }

  private get question(): AskQuestion {
    return this.questions[this.index]!;
  }

  private get state(): QuestionState {
    return this.states[this.index]!;
  }

  /** The free-text row sits after the options. */
  private get typeRow(): number {
    return this.question.options.length;
  }

  private enterQuestion(index: number): void {
    this.index = index;
    // A question without options only takes text.
    if (!this.question.options.length) this.startTyping();
    else this.typing = false;
    this.input.focused = this.hasFocus && this.typing;
  }

  private startTyping(): void {
    this.typing = true;
    this.input.setValue(this.state.typed ?? "");
    this.input.focused = this.hasFocus;
  }

  private leaveTyping(): void {
    if (!this.question.options.length) {
      this.finish({ status: "cancelled" });
      return;
    }
    this.typing = false;
    this.input.focused = false;
    this.refresh();
  }

  private submitText(value: string): void {
    const text = value.trim();
    if (!text) return;
    const state = this.state;
    state.typed = text;
    if (!this.question.multiSelect) state.chosen = undefined;
    this.typing = false;
    this.input.focused = false;
    this.answer();
  }

  private answer(): void {
    this.state.answered = true;
    const next = this.states.findIndex((state, offset) => !state.answered && offset !== this.index);
    if (next < 0) {
      this.finish({ status: "answered", answers: this.answers() });
      return;
    }
    this.enterQuestion(next);
    this.refresh();
  }

  private answers(): AskAnswer[] {
    return this.questions.map((question, at) => {
      const state = this.states[at]!;
      const picked = question.multiSelect
        ? [...state.checked].sort((a, b) => a - b)
        : state.chosen === undefined
          ? []
          : [state.chosen];
      return {
        question: question.question,
        selected: picked.map((choice) => question.options[choice]!.label),
        ...(state.typed !== undefined ? { text: state.typed } : {}),
      };
    });
  }

  private choose(option: number): void {
    const state = this.state;
    if (this.question.multiSelect) {
      if (!state.checked.size && state.typed === undefined) state.checked.add(option);
      this.answer();
      return;
    }
    state.chosen = option;
    state.typed = undefined;
    this.answer();
  }

  private toggle(option: number): void {
    const checked = this.state.checked;
    if (checked.has(option)) checked.delete(option);
    else checked.add(option);
  }

  private move(delta: number): void {
    const rows = this.typeRow + 1;
    this.state.cursor = (this.state.cursor + delta + rows) % rows;
  }

  private refresh(): void {
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.typing) {
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
        this.switchQuestion(matchesKey(data, Key.tab) ? 1 : -1);
        return;
      }
      this.input.handleInput(data);
      this.refresh();
      return;
    }
    const state = this.state;
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.finish({ status: "cancelled" });
      return;
    }
    if (this.keys.matches(data, "tui.select.up")) this.move(-1);
    else if (this.keys.matches(data, "tui.select.down")) this.move(1);
    else if (
      matchesKey(data, Key.right) ||
      matchesKey(data, Key.tab) ||
      matchesKey(data, Key.left) ||
      matchesKey(data, Key.shift("tab"))
    ) {
      this.switchQuestion(matchesKey(data, Key.right) || matchesKey(data, Key.tab) ? 1 : -1);
      return;
    } else if (data === " " && this.question.multiSelect && state.cursor < this.typeRow)
      this.toggle(state.cursor);
    else if (/^[1-9]$/.test(data) && Number(data) <= this.typeRow) {
      const option = Number(data) - 1;
      state.cursor = option;
      if (this.question.multiSelect) this.toggle(option);
      else {
        this.choose(option);
        return;
      }
    } else if (this.keys.matches(data, "tui.select.confirm")) {
      if (state.cursor === this.typeRow) this.startTyping();
      else {
        this.choose(state.cursor);
        return;
      }
    } else return;
    this.refresh();
  }

  private switchQuestion(delta: number): void {
    if (this.questions.length < 2) return;
    this.enterQuestion((this.index + delta + this.questions.length) % this.questions.length);
    this.refresh();
  }

  /** One line for the minimized window: the question waiting on the user. */
  summary(): string {
    const position =
      this.questions.length > 1 ? ` (${this.index + 1} of ${this.questions.length})` : "";
    return `${firstLine(this.question.question)}${position}`;
  }

  render(width: number): string[] {
    const inner = Math.max(0, width - 2);
    const rows: string[] = [];
    const row = (text: string) => rows.push(bodyRow(text, width));
    // Header: progress tabs (or the lone question's header), divided from the content.
    const header =
      this.questions.length > 1
        ? this.questions
            .map((question, at) => {
              const done = this.states[at]!.answered;
              const label = sanitizeLine(question.header || `Q${at + 1}`);
              const mark = at === this.index ? "●" : done ? "✓" : "○";
              const tone = at === this.index ? "accent" : done ? "success" : "dim";
              return paint(this.theme, tone, `${mark} ${label}`, at === this.index);
            })
            .join("  ")
        : this.question.header
          ? paint(this.theme, "accent", sanitizeLine(this.question.header), true)
          : "";
    if (header) {
      row(header);
      row(divider(inner, this.theme));
    }
    const text = sanitizeText(this.question.question);
    for (const line of inner > 0
      ? wrapTextWithAnsi(paint(this.theme, "default", text, true), inner)
      : [""])
      row(line);
    row("");
    const state = this.state;
    this.question.options.forEach((option, at) => {
      const current = at === state.cursor && !this.typing;
      const box = this.question.multiSelect
        ? state.checked.has(at)
          ? "[x] "
          : "[ ] "
        : state.chosen === at
          ? "● "
          : "";
      row(
        styleLine(
          [
            { text: current ? "› " : "  ", tone: "accent" },
            { text: `${at + 1}. ${box}`, tone: current ? "accent" : "dim" },
            { text: option.label, tone: current ? "accent" : "default", bold: current },
            ...(option.description
              ? [{ text: ` — ${option.description}`, tone: "muted" as const }]
              : []),
          ],
          this.theme,
        ),
      );
    });
    if (this.typing) {
      const line = inner > 0 ? (this.input.render(inner)[0] ?? "") : "";
      rows.push(
        inner > 0
          ? ` ${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))} `
          : " ".repeat(Math.max(0, width)),
      );
    } else {
      const current = state.cursor === this.typeRow;
      row(
        styleLine(
          [
            { text: current ? "› " : "  ", tone: "accent" },
            {
              text: state.typed === undefined ? TYPE_LABEL : `✎ ${state.typed}`,
              tone: current ? "accent" : "muted",
              bold: current,
            },
          ],
          this.theme,
        ),
      );
    }
    for (const line of footerRows(this.status(), this.hints(), inner, this.theme)) row(line);
    return rows;
  }

  /** The footer rule: where the user is, and what this question takes. */
  private status(): string {
    const parts =
      this.questions.length > 1 ? [`${this.index + 1} of ${this.questions.length}`] : [];
    if (!this.question.options.length) parts.push("your own words");
    else if (this.question.multiSelect)
      parts.push(`choose any · ${this.state.checked.size} selected`);
    else parts.push("choose one");
    return parts.join(" · ");
  }

  private hints(): Hint[] {
    const switching =
      this.questions.length > 1
        ? [{ keys: this.typing ? "tab" : "←→", action: "question", priority: HINT_PRIORITY.view }]
        : [];
    if (this.typing)
      return [
        { keys: "enter", action: "submit", priority: HINT_PRIORITY.action },
        ...switching,
        {
          keys: "esc",
          action: this.question.options.length ? "back to choices" : "dismiss",
          priority: HINT_PRIORITY.action,
        },
      ];
    return [
      { keys: "↑↓", action: "move", priority: HINT_PRIORITY.navigation },
      { keys: "enter", action: "choose", priority: HINT_PRIORITY.action },
      ...(this.question.multiSelect
        ? [{ keys: "space", action: "toggle", priority: HINT_PRIORITY.action }]
        : []),
      ...switching,
      { keys: "esc", action: "dismiss", priority: HINT_PRIORITY.action },
    ];
  }

  invalidate(): void {
    this.input.invalidate?.();
  }

  dispose(): void {
    this.input.focused = false;
  }
}
