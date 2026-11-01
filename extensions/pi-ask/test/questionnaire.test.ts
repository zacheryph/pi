import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { sanitizeText } from "../../../packages/pi-ui/src/index.ts";
import { Questionnaire } from "../src/questionnaire.ts";
import { readQuestions, type AskOutcome } from "../src/questions.ts";

const theme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};
const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";

function open(questions: Parameters<typeof readQuestions>[0]["questions"]) {
  const finish = vi.fn<(outcome: AskOutcome) => void>();
  const tui = { requestRender: vi.fn() };
  const q = new Questionnaire(
    readQuestions({ questions }),
    theme,
    new KeybindingsManager(TUI_KEYBINDINGS),
    tui,
    finish,
  );
  q.focused = true;
  const type = (text: string) => {
    for (const char of text) q.handleInput(char);
  };
  const screen = (width = 60) => q.render(width).map(sanitizeText).join("\n");
  return { q, finish, tui, type, screen };
}

const db = {
  question: "Which database?",
  header: "Storage",
  options: [
    { label: "Postgres", description: "In production" },
    { label: "SQLite", description: "No server" },
  ],
};

describe("Questionnaire", () => {
  it("answers a single-select question with enter on the cursor", () => {
    const { q, finish, screen } = open([db]);
    expect(screen()).toContain("› 1. Postgres — In production");
    expect(screen()).toContain("Type something…");
    q.handleInput(DOWN);
    expect(screen()).toContain("› 2. SQLite");
    q.handleInput(ENTER);
    expect(finish).toHaveBeenCalledWith({
      status: "answered",
      answers: [{ question: "Which database?", selected: ["SQLite"] }],
    });
  });

  it("takes a number as a quick pick and moves through every question before submitting", () => {
    const { q, finish, screen } = open([db, { ...db, question: "Which cache?", header: "Cache" }]);
    expect(screen()).toContain("● Storage  ○ Cache");
    q.handleInput("1");
    expect(finish).not.toHaveBeenCalled();
    expect(screen()).toContain("✓ Storage  ● Cache");
    q.handleInput("2");
    expect(finish).toHaveBeenCalledWith({
      status: "answered",
      answers: [
        { question: "Which database?", selected: ["Postgres"] },
        { question: "Which cache?", selected: ["SQLite"] },
      ],
    });
  });

  it("toggles multi-select options with space and confirms with enter", () => {
    const { q, finish, screen } = open([{ ...db, multiSelect: true }]);
    q.handleInput(" ");
    q.handleInput(DOWN);
    q.handleInput(" ");
    expect(screen()).toContain("[x] Postgres");
    expect(screen()).toContain("[x] SQLite");
    q.handleInput(ENTER);
    expect(finish).toHaveBeenCalledWith({
      status: "answered",
      answers: [{ question: "Which database?", selected: ["Postgres", "SQLite"] }],
    });
  });

  it("takes the user's own words from the free-text row", () => {
    const { q, finish, type, screen } = open([db]);
    q.handleInput(DOWN);
    q.handleInput(DOWN);
    q.handleInput(ENTER);
    expect(screen()).toContain("enter submit · esc back to choices");
    q.handleInput(ENTER); // blank is not an answer
    expect(finish).not.toHaveBeenCalled();
    type("DuckDB");
    q.handleInput(ENTER);
    expect(finish).toHaveBeenCalledWith({
      status: "answered",
      answers: [{ question: "Which database?", selected: [], text: "DuckDB" }],
    });
  });

  it("goes back to the choices from the text row, and dismisses on escape", () => {
    const { q, finish, screen } = open([db]);
    q.handleInput(DOWN);
    q.handleInput(DOWN);
    q.handleInput(ENTER);
    q.handleInput(ESC);
    expect(screen()).toContain("esc dismiss");
    expect(finish).not.toHaveBeenCalled();
    q.handleInput(ESC);
    expect(finish).toHaveBeenCalledWith({ status: "cancelled" });
  });

  it("opens text-only questions straight in the text row", () => {
    const { q, finish, type, screen } = open([{ question: "Which port?" }]);
    expect(screen()).toContain("enter submit · esc dismiss");
    type("8080");
    q.handleInput(ENTER);
    expect(finish).toHaveBeenCalledWith({
      status: "answered",
      answers: [{ question: "Which port?", selected: [], text: "8080" }],
    });
  });

  it("switches questions with the arrow keys without answering", () => {
    const { q, finish, screen } = open([db, { question: "Why?", header: "Reason" }]);
    q.handleInput(RIGHT);
    expect(screen()).toContain("○ Storage  ● Reason");
    expect(finish).not.toHaveBeenCalled();
  });

  it("pads every row and stays within narrow widths with ANSI and wide text", () => {
    const { q } = open([
      {
        question: "\x1b[31m日本語で答えてください 👩‍💻\x1b[39m é\nsecond line \x1b]52;c;x\x07",
        header: "質問",
        options: [{ label: "はい", description: "\x1b[2Jyes" }, { label: "いいえ" }],
      },
    ]);
    for (let width = 0; width <= 40; width++) {
      for (const row of q.render(width)) {
        expect(visibleWidth(row)).toBeLessThanOrEqual(width);
        expect(row).not.toContain("\x1b[2J");
        expect(row).not.toContain("\x1b]52");
        if (width <= 2) expect(row).toBe(" ".repeat(width));
        else expect(row.startsWith(" ") && row.endsWith(" ")).toBe(true);
      }
    }
  });
});
