import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type TodoState, type TodoTask } from "../src/state.js";
import {
  formatTodoAge, formatTodoClock, renderTodoLines, renderTodoText, todoTaskDetail, type TodoRenderConfig,
} from "../src/ui/render.js";
import { sanitizeTodoText } from "../src/ui/text.js";

const theme = { fg: (_token: string, text: string) => text } as Theme;
const task = (key: string, status: TodoTask["status"] = "pending", dependsOn?: string[]): TodoTask => ({
  key, subject: `Task ${key}`, status, dependsOn,
});
const state = (tasks: TodoTask[]): TodoState => ({ schemaVersion: 2, revision: 4, tasks });
const config = { maxVisible: 5, showCompleted: true };
const render = (s: TodoState, c: TodoRenderConfig = config, width = 100, rows = Infinity) => renderTodoLines(s, c, width, theme, rows);
const unsafe = "safe\x1b[2J\x1b]52;c;evil\x07\x1b_Pi:c\x07\x1bPpayload\x1b\\\x9b31m\x08\r\u202e\u2066\u200e\u061cend";

describe("todo rendering", () => {
  it("keeps top rule static with labeled progress; status right and key left", () => {
    const s = state([task("ready"), task("active", "in_progress"), task("done", "completed"), task("wait", "pending", ["ready"])]);
    const lines = render(s);
    expect(lines[0]).toMatch(/^──   Todos ─+ 1\/4 ──$/);
    expect(visibleWidth(lines[0])).toBe(100);
    expect(lines.slice(1)).toEqual([
      expect.stringMatching(/^ active: Task active +▸ in_progress $/),
      expect.stringMatching(/^ ready: Task ready +○ pending $/),
      expect.stringMatching(/^ wait: Task wait ← ready +○ blocked $/),
      expect.stringMatching(/^ done: Task done +✓ completed $/),
    ]);
    expect(render(s)).toEqual(lines);
  });

  it("uses a static checklist title with lifecycle colors and icon-aware width", () => {
    for (const [status, color] of [["pending", "dim"], ["in_progress", "accent"], ["completed", "dim"]] as const) {
      const calls: string[] = [];
      const t = { fg: (token: string, text: string) => { calls.push(`${token}:${text}`); return text; } } as Theme;
      const s = state([task("one", status)]);
      const lines = renderTodoLines(s, config, 19, t);
      expect(lines[0]).toBe(`──   Todos  ${status === "completed" ? "1/1" : "0/1"} ──`);
      expect(visibleWidth(lines[0])).toBe(19);
      expect(calls).toContain("border: ──");
      expect(render(s, config, 18)[0]).toBe("  Todos");
      expect(calls).toContain(`${color}:  Todos`);
      expect(render(s, config, 8)[0]).toBe("  Todos");
      expect(renderTodoText(s)[0]).not.toContain("");
    }
  });

  it("reserves trailing border columns for multi-digit progress with ANSI styling", () => {
    const s = state(Array.from({ length: 50 }, (_, i) => task(`k${i}`, "completed")));
    const colored = { fg: (_token: string, text: string) => `\x1b[32m${text}\x1b[0m` } as Theme;
    for (const width of [21, 22, 30, 80]) {
      const header = render(s, config, width)[0];
      expect(header).toMatch(/^──   Todos ─* 50\/50 ──$/);
      expect(visibleWidth(header)).toBe(width);
      expect(visibleWidth(renderTodoLines(s, config, width, colored)[0])).toBe(width);
    }
    expect(render(s, config, 20)[0]).toBe("  Todos");
  });

  it("orders stably and hides completed without changing state or overflow counts", () => {
    const s = state([task("done", "completed"), task("wait", "pending", ["ready"]), task("r2"), task("active", "in_progress"), task("ready")]);
    const before = JSON.stringify(s);
    const lines = render(s, { maxVisible: 2, showCompleted: false });
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("active:");
    expect(lines[2]).toContain("r2:");
    expect(lines[3]).toBe(" +2 more ");
    expect(lines.join("\n")).not.toContain("done:");
    expect(lines[0]).toContain("1/5");
    expect(JSON.stringify(s)).toBe(before);
    expect(render(state([task("done", "completed")]), { ...config, showCompleted: false })[1]).toBe(" No unfinished tasks ");
  });

  it("defaults/clamps task budget and bounds rows, preserving overflow", () => {
    const s = state(Array.from({ length: 20 }, (_, i) => task(`k${i}`)));
    for (const [limit, expected] of [[NaN, 5], [0, 1], [50, 20], [2.9, 2]]) {
      expect(render(s, { ...config, maxVisible: limit }).length).toBe(expected + 1 + Number(expected < s.tasks.length));
    }
    for (let rows = 0; rows <= 15; rows++) expect(render(s, config, 80, rows).length).toBeLessThanOrEqual(rows);
    expect(render(s, config, 80, 3).at(-1)).toBe(" +19 more ");
    expect(render(s, config, 0)).toEqual([]);
    expect(render(state([]))[1]).toBe(" No tasks ");
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

  it("badges delegated tasks, dropping the badge before the status glyph as width shrinks", () => {
    const s = state([task("audit", "in_progress"), task("ship")]);
    const assignees = new Map([["audit", "agent a3f2b1c4"]]);
    const wide = render(s, { ...config, assignees }, 60);
    expect(wide[1]).toMatch(/^ audit: Task audit +→ agent a3f2b1c4 · ▸ in_progress $/);
    expect(wide[2]).toMatch(/^ ship: Task ship +○ pending $/);
    expect(render(s, { ...config, assignees }, 34)[1]).toMatch(/→ agent a3f2b1c4 · ▸ $/);
    expect(render(s, { ...config, assignees }, 20)[1]).toMatch(/▸ $/);
    expect(renderTodoText(s, { ...config, assignees })).toContain("▸ audit: Task audit [in_progress] → agent a3f2b1c4");
    const colored = { fg: (_token: string, text: string) => `\x1b[32m${text}\x1b[0m` } as Theme;
    const hostile = new Map([["audit", `agent ${unsafe}日本語👩‍💻`.repeat(4)]]);
    for (let width = 0; width <= 80; width++) {
      for (const t of [theme, colored]) {
        const lines = renderTodoLines(s, { ...config, assignees: hostile }, width, t);
        for (const row of lines.slice(1)) {
          expect(visibleWidth(row)).toBeLessThanOrEqual(width);
          expect(row).not.toMatch(/[\n\r\u202e]/);
          if (width <= 2) expect(row).toBe(" ".repeat(width));
          else {
            expect(row.startsWith(" ")).toBe(true);
            expect(row.endsWith(" ")).toBe(true);
          }
        }
      }
    }
  });

  it("titles a subagent's view of its delegated tasks", () => {
    const s = state([task("audit", "in_progress")]);
    expect(render(s, { ...config, title: "Assigned tasks" }, 60)[0]).toContain("  Assigned tasks");
    expect(renderTodoText(s, { ...config, title: "Assigned tasks" })[0]).toBe("Assigned tasks 0/1 completed");
  });

  it.each([1, 2, 3, 8, 30, 80])("insets all body rows at width %i without moving header chrome", width => {
    const colored = { fg: (_token: string, text: string) => `\x1b[32m${text}\x1b[0m` } as Theme;
    const cases = [
      state([{ ...task("wide"), subject: "日本語 👩‍💻 e\u0301".repeat(20) }]),
      state(Array.from({ length: 6 }, (_, i) => task(`k${i}`))),
      state([]),
      state([task("done", "completed")]),
    ];
    for (const s of cases) {
      for (const t of [theme, colored]) {
        const lines = renderTodoLines(s, { ...config, showCompleted: false }, width, t);
        for (const row of lines.slice(1)) {
          expect(row.startsWith(" ")).toBe(true);
          expect(row.endsWith(" ")).toBe(true);
          expect(visibleWidth(row)).toBeLessThanOrEqual(width);
          if (width <= 2) expect(row).toBe(" ".repeat(width));
        }
        if (width >= 30) expect(lines[0]).toContain("── ");
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

describe("unreviewed message rendering", () => {
  const s = state([task("active", "in_progress"), task("ready"), task("done", "completed"), task("old", "completed")]);
  const unreviewed = new Map([["done", "Found 3 bugs\nin auth"], ["ready", "Queued for subagent"]]);
  const c = { ...config, unreviewed };

  it("counts new messages in the header, falling back to progress then title on narrow widths", () => {
    expect(render(s, c)[0]).toMatch(/^──   Todos ─+ ● 2 new · 2\/4 ──$/);
    expect(visibleWidth(render(s, c)[0])).toBe(100);
    const colored = { fg: (_token: string, text: string) => `\x1b[32m${text}\x1b[0m` } as Theme;
    for (let width = 1; width <= 40; width++) {
      const header = render(s, c, width)[0];
      expect(visibleWidth(header)).toBeLessThanOrEqual(width);
      expect(visibleWidth(renderTodoLines(s, c, width, colored)[0])).toBeLessThanOrEqual(width);
      if (header.includes("new")) expect(header).toMatch(/^──   Todos [─ ]+● 2 new · 2\/4 ──$/);
    }
    expect(render(s, c, 29)[0]).toBe("──   Todos  ● 2 new · 2/4 ──");
    expect(render(s, c, 28)[0]).toMatch(/^──   Todos ─+ 2\/4 ──$/);
    expect(render(s, c, 19)[0]).toBe("──   Todos  2/4 ──");
    expect(render(s, c, 18)[0]).toBe("  Todos");
    expect(render(s)[0]).not.toContain("new");
  });

  it("orders unreviewed first by recency, keeps them when completed are hidden, and aligns a gutter", () => {
    const lines = render(s, { ...c, showCompleted: false });
    expect(lines.slice(1)).toEqual([
      expect.stringMatching(/^ ● done: Task done — Found 3 bugs in auth +✓ completed $/),
      expect.stringMatching(/^ ● ready: Task ready — Queued for subagent +○ pending $/),
      expect.stringMatching(/^ {3}active: Task active +▸ in_progress $/),
    ]);
    for (const line of lines) expect(visibleWidth(line)).toBe(100);
    // Overflow beyond the task budget still prefers unreviewed rows.
    expect(render(s, { ...c, maxVisible: 1 }).slice(1)).toEqual([expect.stringContaining("● done:"), " +3 more "]);
    // No gutter unless a shown row is unreviewed.
    expect(render(s, { ...config, unreviewed: new Map() })[1]).toMatch(/^ active:/);
  });

  it("colors marker accent and excerpt dim while unreviewed completed identity stays readable", () => {
    const calls: string[] = [];
    const t = { fg: (token: string, text: string) => { calls.push(`${token}:${text}`); return text; } } as Theme;
    renderTodoLines(state([task("done", "completed")]), { ...config, unreviewed: new Map([["done", "Note"]]) }, 80, t);
    expect(calls).toEqual(expect.arrayContaining(["accent:● ", "text:done: Task done", "dim: — Note", "accent:● 1 new"]));
    expect(calls).not.toContain("muted:done: Task done");
  });

  it("plain widget text marks new messages with bounded one-line excerpts", () => {
    const text = renderTodoText(s, { ...c, unreviewed: new Map([...unreviewed, ["active", `${"x".repeat(200)}\nmore`]]) });
    expect(text[0]).toBe("Todos 2/4 completed · 3 new");
    expect(text[1]).toBe("● ✓ done: Task done [completed] · new: Found 3 bugs in auth");
    expect(text.find(line => line.includes("active:"))).toBe(`● ▸ active: Task active [in_progress] · new: ${"x".repeat(159)}…`);
    expect(text.find(line => line.includes("old:"))).toBe("✓ old: Task old [completed]");
  });

  it.each([1, 2, 3, 8, 30, 80])("insets and bounds unreviewed rows with hostile, wide and ANSI text at width %i", width => {
    const colored = { fg: (_token: string, text: string) => `\x1b[32m${text}\x1b[0m` } as Theme;
    const hostile = new Map([["wide", `${unsafe}\n日本語 👩‍💻 e\u0301 🦀`.repeat(5)], ["k1", unsafe]]);
    const s2 = state([{ ...task("wide", "completed"), subject: "日本語 👩‍💻".repeat(10) }, task("k1"), task("k2")]);
    for (const t of [theme, colored]) {
      const lines = renderTodoLines(s2, { ...config, showCompleted: false, unreviewed: hostile }, width, t);
      expect(lines).toHaveLength(4);
      for (const row of lines.slice(1)) {
        expect(row.startsWith(" ")).toBe(true);
        expect(visibleWidth(row)).toBeLessThanOrEqual(width);
        expect(row.replace(/\x1b\[[0-9;]*m/g, "")).not.toMatch(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/);
        if (width <= 2) expect(row).toBe(" ".repeat(width));
        else expect(row.endsWith(" ")).toBe(true);
      }
    }
  });
});

describe("task detail history", () => {
  const now = Date.UTC(2026, 9, 22, 12);
  const s = state([task("build", "completed")]);
  const activity = new Map([["build", { createdAt: now - 7_200_000, updates: [
    { revision: 2, at: now - 3_600_000, status: "in_progress" as const, from: "pending" as const },
    { revision: 3, at: now - 600_000, status: "completed" as const, from: "in_progress" as const, message: `Built\n${unsafe}` },
    { revision: 4, at: now - 20_000, status: "completed" as const, message: "Hand check", by: "user" as const },
  ] }]]);

  it("adds times, review state and a newest-first timeline marking unreviewed messages", () => {
    const lines = todoTaskDetail(s.tasks[0], s, { activity, review: { tasks: new Map() }, now });
    expect(lines).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Created: 2h ago \(\d\d:\d\d:\d\d\)$/),
      expect.stringMatching(/^Updated: just now \(\d\d:\d\d:\d\d\)$/),
      "Reviewed: never",
      "Activity (newest first; ● = unreviewed):",
    ]));
    const timeline = lines.slice(lines.indexOf("Activity (newest first; ● = unreviewed):") + 1);
    expect(timeline).toEqual([
      expect.stringMatching(/^ {2}just now \(.+\) · r4 · note \(completed\) · you$/), "    Hand check",
      expect.stringMatching(/^● 10m ago \(.+\) · r3 · in_progress → completed$/), "    Built", "    safeend",
      expect.stringMatching(/^ {2}1h ago \(.+\) · r2 · pending → in_progress$/),
    ]);
    const reviewed = todoTaskDetail(s.tasks[0], s, { activity, review: { at: now - 60_000, tasks: new Map([["build", { revision: 3, at: now - 60_000 }]]) }, now });
    expect(reviewed).toContainEqual(expect.stringMatching(/^Reviewed: 1m ago \(\d\d:\d\d:\d\d\) through r3$/));
    expect(reviewed.join("\n")).not.toContain("●");
    expect(todoTaskDetail(s.tasks[0], s)).not.toContain("Reviewed: never");
  });

  it("names the assignee and agent-attributed updates in details", () => {
    const delegated = new Map([["build", { updates: [{ revision: 5, at: now, status: "in_progress" as const, message: "Started", agent: "a3f2b1c4-9d8e" }] }]]);
    const lines = todoTaskDetail(s.tasks[0], s, { activity: delegated, review: { tasks: new Map() }, now }, `agent ${unsafe}`);
    expect(lines).toContain("Assigned to: agent safeend");
    expect(lines).toContainEqual(expect.stringMatching(/· r5 · note \(in_progress\) · agent a3f2b1c4$/));
    expect(todoTaskDetail(s.tasks[0], s).join("\n")).not.toContain("Assigned to");
  });

  it("formats ages and clocks deterministically", () => {
    expect([0, 44_000, 45_000, 3_599_000, 3_600_000, 86_399_000, 86_400_000, -5_000].map(ago => formatTodoAge(now - ago, now)))
      .toEqual(["just now", "just now", "1m ago", "60m ago", "1h ago", "23h ago", "1d ago", "just now"]);
    expect(formatTodoClock(now, now)).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(formatTodoClock(now - 3 * 86_400_000, now)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });
});
