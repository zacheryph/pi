import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type TodoState, type TodoTask } from "../src/state.js";
import { renderTodoLines, renderTodoText, todoTaskDetail } from "../src/ui/render.js";
import { sanitizeTodoText } from "../src/ui/text.js";

const theme = { fg: (_token: string, text: string) => text } as Theme;
const task = (key: string, status: TodoTask["status"] = "pending", dependsOn?: string[]): TodoTask => ({
  key, subject: `Task ${key}`, status, dependsOn,
});
const state = (tasks: TodoTask[]): TodoState => ({ schemaVersion: 2, revision: 4, tasks });
const config = { maxVisible: 5, showCompleted: true };
const render = (s: TodoState, c = config, width = 100, rows = Infinity) => renderTodoLines(s, c, width, theme, rows);
const unsafe = "safe\x1b[2J\x1b]52;c;evil\x07\x1b_Pi:c\x07\x1bPpayload\x1b\\\x9b31m\x08\r\u202e\u2066\u200e\u061cend";

describe("todo rendering", () => {
  it("keeps top rule static with labeled progress; status right and key left", () => {
    const s = state([task("ready"), task("active", "in_progress"), task("done", "completed"), task("wait", "pending", ["ready"])]);
    const lines = render(s);
    expect(lines[0]).toMatch(/^── Todos ─+ 1\/4$/);
    expect(lines.slice(1)).toEqual([
      expect.stringMatching(/^active: Task active +▸ in_progress$/),
      expect.stringMatching(/^ready: Task ready +○ pending$/),
      expect.stringMatching(/^wait: Task wait ← ready +○ blocked$/),
      expect.stringMatching(/^done: Task done +✓ completed$/),
    ]);
    expect(render(s)).toEqual(lines);
  });

  it("orders stably and hides completed without changing state or overflow counts", () => {
    const s = state([task("done", "completed"), task("wait", "pending", ["ready"]), task("r2"), task("active", "in_progress"), task("ready")]);
    const before = JSON.stringify(s);
    const lines = render(s, { maxVisible: 2, showCompleted: false });
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("active:");
    expect(lines[2]).toContain("r2:");
    expect(lines[3]).toBe("+2 more");
    expect(lines.join("\n")).not.toContain("done:");
    expect(lines[0]).toContain("1/5");
    expect(JSON.stringify(s)).toBe(before);
    expect(render(state([task("done", "completed")]), { ...config, showCompleted: false })[1]).toBe("No unfinished tasks");
  });

  it("defaults/clamps task budget and bounds rows, preserving overflow", () => {
    const s = state(Array.from({ length: 20 }, (_, i) => task(`k${i}`)));
    for (const [limit, expected] of [[NaN, 5], [0, 1], [50, 20], [2.9, 2]]) {
      expect(render(s, { ...config, maxVisible: limit }).length).toBe(expected + 1 + Number(expected < s.tasks.length));
    }
    for (let rows = 0; rows <= 15; rows++) expect(render(s, config, 80, rows).length).toBeLessThanOrEqual(rows);
    expect(render(s, config, 80, 3).at(-1)).toBe("+19 more");
    expect(render(s, config, 0)).toEqual([]);
    expect(render(state([]))[1]).toBe("No tasks");
  });

  it("plain config matches priority, filtering, task limit and overflow without slicing rows", () => {
    const s = state([task("done", "completed"), task("blocked", "pending", ["ready"]),
      { ...task("ready"), description: "line one\nline two" }, task("active", "in_progress"), task("r2")]);
    const before = JSON.stringify(s);
    const c = { maxVisible: 2, showCompleted: false };
    const text = renderTodoText(s, c);
    expect(text).toEqual([
      "Todos 1/5 completed", "▸ active: Task active [in_progress]",
      "○ ready: Task ready [pending] — line one line two", "+2 more",
    ]);
    expect(text).toHaveLength(render(s, c).length);
    expect(renderTodoText(s)).toHaveLength(6);
    expect(renderTodoText(s).at(-1)).toContain("✓ done:");
    expect(renderTodoText(state([]), c)).toEqual(["Todos 0/0 completed", "No tasks"]);
    expect(renderTodoText(state([task("done", "completed")]), c)).toEqual(["Todos 1/1 completed", "No unfinished tasks"]);
    expect(JSON.stringify(s)).toBe(before);
  });

  it("expanded pure rendering respects 50 tasks regardless of terminal height", () => {
    const s = state(Array.from({ length: 50 }, (_, i) => task(`k${i}`)));
    const rows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    Object.defineProperty(process.stdout, "rows", { configurable: true, value: 1 });
    try {
      expect(renderTodoLines(s, { maxVisible: 50, showCompleted: true }, 100, theme)).toHaveLength(51);
      expect(renderTodoText(s, { maxVisible: 50, showCompleted: true })).toHaveLength(51);
    } finally {
      if (rows) Object.defineProperty(process.stdout, "rows", rows);
      else Reflect.deleteProperty(process.stdout, "rows");
    }
  });

  it("scrubs terminal commands, newlines, bidi and Unicode separators in all fields", () => {
    expect(sanitizeTodoText(unsafe)).toBe("safeend");
    expect(sanitizeTodoText("safe\x1b]0;unfinished")).toBe("safe");
    const s = state([{ key: unsafe, subject: `${unsafe}\nnext\u2028line`, status: "pending", dependsOn: [unsafe], description: `${unsafe}\nbody` }]);
    const before = JSON.stringify(s);
    for (const line of [...render(s), ...renderTodoText(s)]) {
      expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/);
    }
    expect(render(s).join(" ")).toContain("safeend: safeend next line ← safeend");
    expect(renderTodoText(s).join(" ")).toContain("safeend body");
    expect(todoTaskDetail(s.tasks[0], s).join("\n")).toContain("safeend — pending");
    expect(JSON.stringify(s)).toBe(before);
  });

  it("fits widths 1..30 with trusted ANSI, wide/combining/emoji text and long keys/deps", () => {
    const s = state([{ ...task("long.key"), subject: `${unsafe}\n日本語 👩‍💻 e\u0301 🦀`.repeat(20), dependsOn: ["長".repeat(40)] }]);
    const colored = { fg: (_token: string, text: string) => `\x1b[32m${text}\x1b[0m` } as Theme;
    for (let width = 1; width <= 30; width++) {
      for (const t of [theme, colored]) {
        const lines = renderTodoLines(s, config, width, t, Infinity);
        expect(lines).toHaveLength(2);
        for (const line of lines) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          expect(line).not.toMatch(/[\n\r\u202e]/);
        }
      }
    }
  });

  it("uses semantic colors and derives blocked from deps even when completed hidden", () => {
    const tokens: string[] = [];
    const t = { fg: (token: string, text: string) => { tokens.push(token); return text; } } as Theme;
    const s = state([task("done", "completed"), task("ready", "pending", ["done"]), task("active", "in_progress"), task("wait", "pending", ["ready"])]);
    renderTodoLines(s, config, 100, t, Infinity);
    expect(tokens).toEqual(expect.arrayContaining(["border", "muted", "success", "accent", "warning", "dim"]));
    expect(render(s, { ...config, showCompleted: false }).join(" ")).toContain("○ pending");
    expect(renderTodoText(s).join(" ")).toContain("✓ done:");
  });
});
