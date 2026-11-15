// @vitest-environment jsdom
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DetailContent, ExplorerModel, WidgetModel } from "../contract.ts";
import {
  DetailView,
  ExplorerSection,
  plainText,
  WidgetRows,
  widgetTitle,
  type RunAction,
} from "../ui/surface.tsx";

afterEach(cleanup);

const widget: WidgetModel = {
  title: { label: "Todos", icon: "x" },
  meta: [[{ text: "★ 1 new", tone: "accent" }, " · 3/7"], "3/7"],
  rows: [
    { left: [{ text: "fix: Fix the loop", tone: "muted" }], right: ["◐ in progress", "◐"] },
    { left: "docs: Write it up" },
  ],
};

const explorer: ExplorerModel = {
  title: "Todos",
  noun: ["task", "tasks"],
  notices: [{ text: "Read-only task snapshot", tone: "muted" }],
  items: [
    {
      id: "fix",
      label: "fix: Fix the loop",
      badge: { text: "done", tone: "success" },
      marked: true,
    },
    { id: "docs", label: "docs: Write it up", badge: { text: "pending" } },
  ],
  tabs: [
    { label: "All", ids: ["fix", "docs"] },
    { label: "Unreviewed", ids: ["fix"] },
    { label: "Empty", ids: [], emptyText: "Nothing here." },
  ],
  marker: { label: "unreviewed", onClear: { action: "todo.review", args: { branch: 1 } } },
  loadDetail: { action: "todo.inspect", args: { reviewed: {} } },
};

function draw<P extends object>(component: (props: P) => React.ReactNode, props: P) {
  return renderSlot({ component: component as never }, props as never, {});
}

describe("lines and widgets", () => {
  it("joins a line's spans and names a widget from its title and fullest meta", () => {
    expect(plainText([{ text: "a", tone: "muted" }, "b"])).toBe("ab");
    expect(widgetTitle(widget)).toBe("Todos · ★ 1 new · 3/7");
    expect(widgetTitle({ title: "Subagents", rows: [] })).toBe("Subagents");
  });

  it("draws each row with its fullest right fallback, toned spans and a leading column", async () => {
    const slot = draw(WidgetRows, { model: widget });
    const list = await slot.findByRole("list", { name: "Todos" });
    const rows = list.querySelectorAll(":scope > li");
    expect(rows).toHaveLength(2);
    // Plain glyph text, with no state marked: drawn as the terminal draws it at full width.
    expect(rows[0]!.textContent).toBe("fix: Fix the loop◐ in progress");
    expect(rows[0]!.querySelector(".text-muted-foreground")?.textContent).toBe("fix: Fix the loop");
    // The leading column keeps row text under the card header's title.
    expect(rows[0]!.firstElementChild?.className).toContain("size-3.5");
  });

  it("draws a subagent row as the terminal does: clock, bold name, status at the right", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      const start = Date.now() - 83_000;
      const model: WidgetModel = {
        title: "Subagents",
        rows: [
          {
            left: [
              { text: "01:23", tone: "dim", since: start },
              "  ",
              { text: "explore", bold: true },
              ": ",
              { text: "Map the paths", tone: "muted" },
            ],
            right: [
              [
                { text: "●", tone: "accent", icon: "active" },
                { text: " Reading replay.ts", tone: "muted" },
              ],
            ],
          },
          {
            left: "waiter",
            right: [
              [
                { text: "", icon: "waiting" },
                { text: "waiting: answer", tone: "muted" },
              ],
            ],
          },
        ],
      };
      const slot = draw(WidgetRows, { model });
      const rows = (await slot.findByRole("list", { name: "Subagents" })).querySelectorAll(
        ":scope > li",
      );
      const active = rows[0]!;
      // No leading icon: the status, glyph and activity, stays at the right.
      expect(active.firstElementChild?.getAttribute("aria-label")).toBeNull();
      expect(active.textContent).toBe("01:23  explore: Map the paths Reading replay.ts");
      expect(active.lastElementChild?.querySelector('[aria-label="active"]')).toBeTruthy();
      expect(slot.getByText("explore").className).toContain("font-semibold");
      // The clock keeps running between snapshots.
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(slot.getByText("01:25")).toBeTruthy();
      // An icon-only glyph before text is drawn in place too.
      expect(rows[1]!.lastElementChild?.querySelector('[aria-label="waiting"]')).toBeTruthy();
      expect(rows[1]!.textContent).toBe("waiterwaiting: answer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a row whose compact form is only its state glyph as a leading icon", async () => {
    const model: WidgetModel = {
      title: "Todos",
      rows: [
        {
          left: "table: Add the table",
          right: [
            [
              { text: "✓", tone: "success", icon: "done" },
              { text: " completed", tone: "success" },
            ],
            [{ text: "✓", tone: "success", icon: "done" }],
          ],
        },
        {
          left: "worker: Move retries",
          right: [
            [
              { text: "▸", tone: "accent", icon: "active" },
              { text: " in_progress", tone: "accent" },
            ],
            [{ text: "▸", tone: "accent", icon: "active" }],
          ],
        },
      ],
    };
    const slot = draw(WidgetRows, { model });
    const [done, active] = Array.from(
      (await slot.findByRole("list", { name: "Todos" })).querySelectorAll(":scope > li"),
    );
    expect(done!.firstElementChild?.getAttribute("aria-label")).toBe("done");
    expect(done!.textContent).toBe("table: Add the table");
    expect(done!.children[1]!.className).toContain("line-through");
    // Weight comes from the spans only: an active row adds none of its own.
    expect(active!.firstElementChild?.getAttribute("aria-label")).toBe("active");
    expect(active!.children[1]!.className).not.toContain("font-");
  });

  it("says the widget's empty text when it has no rows", async () => {
    const slot = draw(WidgetRows, { model: { title: "Todos", rows: [], emptyText: "No tasks" } });
    expect(await slot.findByText("No tasks")).toBeTruthy();
  });
});

describe("details", () => {
  it("draws every block kind, and opens a bare URL field in bb", async () => {
    const openUrl = vi.fn();
    const content: DetailContent = [
      { heading: "Pull request" },
      {
        fields: [
          ["URL", "https://github.com/acme/webhooks/pull/212"],
          ["Status", { text: "failing", tone: "error" }],
        ],
      },
      { text: "Read it fresh with /git:refresh.", tone: "muted" },
      { bullets: ["one", "two"] },
      { lines: ["alpha", "beta"], numbered: 10 },
    ];
    const slot = draw(DetailView, { content, openUrl });
    expect(await slot.findByText("Pull request")).toBeTruthy();
    expect(slot.getByText("failing").className).toContain("text-destructive");
    expect(slot.getByText("Read it fresh with /git:refresh.").className).toContain(
      "text-muted-foreground",
    );
    expect(slot.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["one", "two"]);
    expect(slot.container.querySelector("pre")?.textContent).toBe("10alpha11beta");
    fireEvent.click(
      slot.getByRole("button", { name: "https://github.com/acme/webhooks/pull/212" }),
    );
    expect(openUrl).toHaveBeenCalledWith("https://github.com/acme/webhooks/pull/212");
  });

  it("draws a string as one text block", async () => {
    const slot = draw(DetailView, { content: "plain" });
    expect(await slot.findByText("plain")).toBeTruthy();
  });
});

describe("explorers", () => {
  it("switches tabs and shows a tab's empty text", async () => {
    const slot = draw(ExplorerSection, { model: explorer });
    expect(await slot.findByText("Read-only task snapshot")).toBeTruthy();
    expect(slot.getByText("1 unreviewed")).toBeTruthy();
    expect(slot.getByText("docs: Write it up")).toBeTruthy();
    fireEvent.click(slot.getByRole("tab", { name: "Unreviewed" }));
    expect(slot.queryByText("docs: Write it up")).toBeNull();
    fireEvent.click(slot.getByRole("tab", { name: "Empty" }));
    expect(slot.getByText("Nothing here.")).toBeTruthy();
  });

  it("loads an item's detail through its action and clears its mark", async () => {
    const run = vi.fn<RunAction>(async (action, args) =>
      action === "todo.inspect" ? [{ text: `detail of ${(args as { id: string }).id}` }] : null,
    );
    const slot = draw(ExplorerSection, { model: explorer, run });
    fireEvent.click(await slot.findByText("fix: Fix the loop"));
    expect(await slot.findByText("detail of fix")).toBeTruthy();
    expect(run).toHaveBeenCalledWith("todo.inspect", { reviewed: {}, id: "fix" });
    expect(run).toHaveBeenCalledWith("todo.review", { branch: 1, ids: ["fix"] });
    expect(slot.queryByText("1 unreviewed")).toBeNull();
    // Closing and opening again loads it again; the mark stays cleared.
    fireEvent.click(slot.getByText("fix: Fix the loop"));
    expect(slot.queryByText("detail of fix")).toBeNull();
    fireEvent.click(slot.getByText("fix: Fix the loop"));
    expect(await slot.findByText("detail of fix")).toBeTruthy();
    expect(run.mock.calls.filter(([action]) => action === "todo.review")).toHaveLength(1);
  });

  it("shows an action's error, or a result that is not detail content, in place", async () => {
    const run = vi.fn<RunAction>(async (_action, args) => {
      if ((args as { id: string }).id === "fix") throw new Error('No task "fix" on this branch.');
      return { not: "detail" };
    });
    const slot = draw(ExplorerSection, { model: explorer, run });
    fireEvent.click(await slot.findByText("fix: Fix the loop"));
    expect((await slot.findByRole("alert")).textContent).toBe('No task "fix" on this branch.');
    fireEvent.click(slot.getByText("docs: Write it up"));
    expect(await slot.findByText('Action "todo.inspect" returned no detail.')).toBeTruthy();
  });

  it("opens inline details without a session, but not ones it would have to load", async () => {
    const inline: ExplorerModel = {
      title: "Git worktrees",
      items: [{ id: "w", label: "api @ feat/x", detail: [{ fields: [["Branch", "feat/x"]] }] }],
    };
    const slot = draw(ExplorerSection, { model: inline });
    fireEvent.click(await slot.findByText("api @ feat/x"));
    expect(await slot.findByText("Branch")).toBeTruthy();
    cleanup();

    const remote = draw(ExplorerSection, { model: explorer });
    fireEvent.click(await remote.findByText("fix: Fix the loop"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(remote.queryByText("Loading…")).toBeNull();
    expect(remote.getByText("1 unreviewed")).toBeTruthy();
  });
});
