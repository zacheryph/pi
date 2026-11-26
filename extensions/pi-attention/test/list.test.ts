import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AttentionList } from "#surface";
import {
  ansiTheme,
  expectBounded,
  expectPadded,
  fakeTui,
  keybindings,
  NARROW_WIDTHS,
  plainLines,
  plainTheme,
  stripAnsi,
  WIDE_TEXT,
} from "#test-helpers";
import { AttentionView } from "#src/list";
import { findingsItem, listOf, NOW, reviewItem, row, staleItem } from "#test/fixtures";

const mockup = () =>
  listOf([row(reviewItem()), row(findingsItem, "todo.attention"), row(staleItem)]);

function mount(
  list: AttentionList = mockup(),
  options: { rows?: number; columns?: number; theme?: typeof plainTheme } = {},
) {
  const tui = fakeTui(options.rows ?? 30, options.columns ?? 80);
  const onOpen = vi.fn();
  const onDismiss = vi.fn();
  const done = vi.fn();
  const view = new AttentionView({
    tui,
    theme: options.theme ?? plainTheme,
    keys: keybindings(),
    list,
    now: () => NOW,
    onOpen,
    onDismiss,
    done,
  });
  return { view, tui, onOpen, onDismiss, done };
}

describe("AttentionView", () => {
  it("draws the mockup: a block per row with its state, reason and age", () => {
    const { view } = mount();
    expect(plainLines(view.render(72))).toMatchInlineSnapshot(`
      " ╭───────────────────── Needs you · this session ─────────────────────╮ 
       │ → ◆ Review acme/web#42                                       Ready │ 
       │     Checkout cleanup · draft at a13c90e · 12m                      │ 
       │                                                                    │ 
       │   ◆ 2 unreviewed findings                                    Ready │ 
       │     fix-auth-bug · retry-backoff · 5m                              │ 
       │                                                                    │ 
       │   ◇ acme/api#57                                              Stale │ 
       │     Pushed since you were asked · 3h                               │ 
       │ ── 1/3 items ───────────────────────────────────────────────────── │ 
       │ Enter open · d dismiss · Esc close · ↑↓ PgUp/PgDn Home/End         │ 
       ╰────────────────────────────────────────────────────────────────────╯ "
    `);
  });

  it("keeps every row padded and bounded at narrow widths, with ANSI and wide text", () => {
    const wide = listOf([
      row(reviewItem({ title: [{ text: WIDE_TEXT, tone: "accent" }], reason: WIDE_TEXT })),
      row(staleItem),
    ]);
    for (const width of NARROW_WIDTHS) {
      const { view } = mount(wide, { rows: 20, columns: width, theme: ansiTheme });
      const lines = view.render(width);
      expectBounded(lines, width, 16);
      for (const line of lines) expectPadded(line, width);
    }
    const { view } = mount(wide, { columns: 40, theme: ansiTheme });
    const text = plainLines(view.render(40));
    expect(text).toContain("検索");
    expect(text).toContain("…");
    for (const line of view.render(40)) expect(visibleWidth(line)).toBe(40);
  });

  it("moves the pointer and adapts its hints to the row", () => {
    const { view } = mount();
    view.handleInput("\x1b[B");
    expect(view.current?.itemId).toBe(findingsItem.id);
    const text = plainLines(view.render(72));
    expect(text).toContain("→ ◆ 2 unreviewed findings");
    expect(text).toContain("Enter open · Esc close");
    expect(text).not.toContain("d dismiss");
    view.handleInput("\x1b[B");
    view.handleInput("\x1b[B");
    expect(view.current?.itemId).toBe(staleItem.id);
    expect(plainLines(view.render(72))).toContain("── 3/3 items");
  });

  it("closes, then opens the selected row on Enter", () => {
    const { view, onOpen, done } = mount();
    view.handleInput("\r");
    expect(done).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ itemId: reviewItem().id }));
    expect(view.render(72)).toEqual([]);
  });

  it("does nothing on Enter for a row with neither a link nor an open action", () => {
    const bare = row(reviewItem({ link: undefined }));
    delete bare.link;
    const { view, onOpen, done } = mount(listOf([bare]));
    view.handleInput("\r");
    expect(onOpen).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it("dismisses on d and stays open; rows without a dismiss action ignore it", () => {
    const { view, onDismiss, done } = mount();
    view.handleInput("d");
    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ itemId: reviewItem().id }));
    view.handleInput("\x1b[B");
    view.handleInput("d");
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
  });

  it("follows the producers: the selection stays on its row, and an empty list says so", () => {
    const { view, tui } = mount();
    view.handleInput("\x1b[B");
    view.setList(listOf([row(findingsItem, "todo.attention"), row(staleItem)]));
    expect(tui.requestRender).toHaveBeenCalled();
    expect(view.current?.itemId).toBe(findingsItem.id);
    view.setList(listOf([row(staleItem)]));
    expect(view.current?.itemId).toBe(staleItem.id);
    view.setList(listOf([]));
    const text = plainLines(view.render(72));
    expect(text).toContain("Nothing needs you in this session.");
    expect(text).toContain("0/0 items");
    view.handleInput("d");
    view.handleInput("\r");
  });

  it("notes failed views and the items the producers left out", () => {
    const { view } = mount(
      listOf([row(reviewItem())], { owed: 13, more: 12, failed: ["x.attention"] }),
    );
    const text = plainLines(view.render(72));
    expect(text).toContain("Couldn't read x.attention.");
    expect(text).toContain("1/1 item · and 12 more");
  });

  it("scrolls to keep the whole selected block in view", () => {
    const many = listOf(
      Array.from({ length: 12 }, (_, i) =>
        row(reviewItem({ id: `pr:${i}`, title: `Review #${i}`, since: NOW - i * 1000 })),
      ),
    );
    const { view } = mount(many, { rows: 15, columns: 60, theme: ansiTheme });
    view.handleInput("\x1b[F"); // End
    const text = stripAnsi(view.render(60).join("\n"));
    expect(text).toContain("→ ◆ Review #11");
    expect(text).toContain("Checkout cleanup");
    expect(text).not.toContain("Review #0 ");
    expect(view.render(60).length).toBeLessThanOrEqual(12);
  });

  it("closes on Esc", () => {
    const { view, done } = mount();
    view.handleInput("\x1b");
    expect(done).toHaveBeenCalledOnce();
  });
});
