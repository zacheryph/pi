import { describe, expect, it, vi } from "vitest";
import { viewRegistry } from "#surface";
import { fakeCustomUi, fakePi, flushMicrotasks, plainLines, plainTheme } from "#test-helpers";
import piAttention, { STATUS_KEY, type AttentionDependencies } from "#src/index";
import { NOW, producers, reviewItem } from "#test/fixtures";

const ENTER = "\r";
const DOWN = "\x1b[B";

function harness(dependencies: AttentionDependencies = {}) {
  const fake = fakePi();
  const openUrl = vi.fn<(url: string) => Promise<boolean>>().mockResolvedValue(true);
  piAttention(fake.api, { openUrl, now: () => NOW, ...dependencies });
  return { ...fake, openUrl };
}

/** What `openModal` mounts: a host that delegates to the list. */
type Overlay = { render(width: number): string[]; handleInput(data: string): void };

function context(mode: "tui" | "rpc" | "print" = "tui", hasUI = true) {
  const mounted = fakeCustomUi<Overlay>({ theme: plainTheme, awaitDone: true });
  const ui = { setStatus: vi.fn(), notify: vi.fn(), custom: mounted.custom, theme: plainTheme };
  return { ctx: { mode, hasUI, ui }, ui, mounted };
}

/** The hint the footer shows now, as the last `setStatus` for this extension's key left it. */
const hint = (setStatus: ReturnType<typeof vi.fn>) =>
  setStatus.mock.calls.filter(([key]) => key === STATUS_KEY).at(-1)?.[1];

/** Run `/attention` in the TUI and hand back the mounted overlay and the pending command. */
async function openList(h: ReturnType<typeof harness>, ctx: ReturnType<typeof context>) {
  const running = h.runCommand("attention", "", ctx.ctx) as Promise<void>;
  await flushMicrotasks();
  const view = ctx.mounted.latest()!;
  return { view, running };
}

describe("status hint", () => {
  it("counts owed items while any are, and clears when the last resolves", async () => {
    const h = harness();
    const fixture = producers(h.events);
    const { ctx, ui } = context();
    await h.emit("session_start", { reason: "startup" }, ctx);
    expect(hint(ui.setStatus)).toBe("◆ 3 need you · /attention");

    fixture.set("git", undefined);
    await flushMicrotasks();
    expect(hint(ui.setStatus)).toBe("◆ 1 needs you · /attention");

    fixture.set("todo", { items: [], total: 0 });
    await flushMicrotasks();
    expect(hint(ui.setStatus)).toBeUndefined();
    expect(ui.setStatus).toHaveBeenCalledTimes(3);
  });

  it("notices a producer that starts after it, and one that goes away", async () => {
    const h = harness();
    const { ctx, ui } = context();
    await h.emit("session_start", { reason: "startup" }, ctx);
    expect(ui.setStatus).not.toHaveBeenCalled();
    const views = viewRegistry(h.events);
    const remove = views.define({
      id: "late.attention",
      kind: "attention",
      title: "Late",
      model: () => ({ items: [reviewItem()], total: 1 }),
    });
    await flushMicrotasks();
    expect(hint(ui.setStatus)).toBe("◆ 1 needs you · /attention");
    remove();
    await flushMicrotasks();
    expect(hint(ui.setStatus)).toBeUndefined();
  });

  it("reads nothing for other views' announcements, and once per burst", async () => {
    const h = harness();
    const fixture = producers(h.events);
    const other = viewRegistry(h.events);
    let reads = 0;
    other.define({
      id: "todo.widget",
      kind: "summary",
      title: "Todos",
      model: () => {
        reads++;
        return { counts: [] };
      },
    });
    const { ctx, ui } = context();
    await h.emit("session_start", { reason: "startup" }, ctx);
    const before = reads;
    for (let i = 0; i < 5; i++) other.changed("todo.widget");
    await flushMicrotasks();
    expect(reads).toBe(before);
    fixture.views.changed("git.attention");
    fixture.views.changed("todo.attention");
    await flushMicrotasks();
    expect(reads).toBe(before + 1);
    expect(ui.setStatus).toHaveBeenCalledTimes(1);
  });

  it("clears on shutdown and stops following the bus", async () => {
    const h = harness();
    const fixture = producers(h.events);
    const { ctx, ui } = context();
    await h.emit("session_start", { reason: "startup" }, ctx);
    await h.emit("session_shutdown", {}, ctx);
    expect(hint(ui.setStatus)).toBeUndefined();
    const calls = ui.setStatus.mock.calls.length;
    fixture.set("git", { items: [reviewItem({ id: "new" })], total: 1 });
    await flushMicrotasks();
    expect(ui.setStatus).toHaveBeenCalledTimes(calls);
  });

  it("sets no hint in a session without a UI", async () => {
    const h = harness();
    producers(h.events);
    const { ctx, ui } = context("print", false);
    await h.emit("session_start", { reason: "startup" }, ctx);
    expect(ui.setStatus).not.toHaveBeenCalled();
  });
});

describe("/attention", () => {
  it("opens the padded list over the session's owed items", async () => {
    const h = harness();
    producers(h.events);
    const ctx = context();
    const { view, running } = await openList(h, ctx);
    expect(ctx.ui.custom.mock.calls[0][1]).toMatchObject({ overlay: true });
    const text = plainLines(view.render(80));
    expect(text).toContain("Needs you · this session");
    expect(text).toContain("→ ◆ Review acme/web#42");
    expect(text).toContain("◇ acme/api#57");
    view.handleInput("\x1b");
    await running;
  });

  it("opens the selected row's link on Enter", async () => {
    const h = harness();
    producers(h.events);
    const ctx = context();
    const { view, running } = await openList(h, ctx);
    view.handleInput(ENTER);
    await running;
    expect(h.openUrl).toHaveBeenCalledWith("https://github.com/acme/web/pull/42");
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("prints the URL when no opener can open it", async () => {
    const h = harness({ openUrl: vi.fn().mockResolvedValue(false) });
    producers(h.events);
    const ctx = context();
    const { view, running } = await openList(h, ctx);
    view.handleInput(ENTER);
    await running;
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "acme/web#42: https://github.com/acme/web/pull/42",
      "info",
    );
  });

  it("runs a row's open action when it has no link", async () => {
    const h = harness();
    const fixture = producers(h.events);
    const ctx = context();
    const { view, running } = await openList(h, ctx);
    view.handleInput(DOWN);
    expect(plainLines(view.render(80))).toContain("→ ◆ 2 findings to discuss");
    view.handleInput(ENTER);
    await running;
    expect(fixture.opened).toEqual([{ id: "fix-auth-bug" }]);
    expect(h.openUrl).not.toHaveBeenCalled();
  });

  it("dismisses with d through the item's action, and the list and hint follow", async () => {
    const h = harness();
    const fixture = producers(h.events);
    const ctx = context();
    await h.emit("session_start", { reason: "startup" }, ctx.ctx);
    const { view, running } = await openList(h, ctx);
    view.handleInput("d");
    await flushMicrotasks();
    expect(fixture.dismissed).toEqual([{ id: "pr:github.com/acme/web#42" }]);
    expect(plainLines(view.render(80))).not.toContain("Review acme/web#42");
    expect(plainLines(view.render(80))).toContain("→ ◆ 2 findings to discuss");
    expect(hint(ctx.ui.setStatus)).toBe("◆ 2 need you · /attention");
    view.handleInput("\x1b");
    await running;
  });

  it("says why a dismissal failed", async () => {
    const h = harness();
    producers(h.events);
    const ctx = context();
    const fixture = viewRegistry(h.events);
    fixture.define({
      id: "gone.attention",
      kind: "attention",
      title: "Gone",
      model: () => ({
        items: [reviewItem({ id: "x", since: 0, dismiss: { action: "gone.dismiss" } })],
        total: 1,
      }),
    });
    const { view, running } = await openList(h, ctx);
    expect(plainLines(view.render(80))).toContain("→ ◆ Review acme/web#42");
    view.handleInput("d");
    await flushMicrotasks();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      'Couldn\'t dismiss Review acme/web#42: Unknown action "gone.dismiss".',
      "error",
    );
    view.handleInput("\x1b");
    await running;
  });

  it("says so when nothing is owed, without opening a list", async () => {
    const h = harness();
    const ctx = context();
    await h.runCommand("attention", "", ctx.ctx);
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Nothing needs you in this session.", "info");
  });

  it("prints the rows through userOutput outside the terminal", async () => {
    const h = harness();
    producers(h.events);
    const ctx = context("rpc");
    await h.runCommand("attention", "", ctx.ctx);
    expect(ctx.ui.custom).not.toHaveBeenCalled();
    const [shown] = h.shown();
    expect(shown.level).toBe("info");
    expect(shown.text.split("\n")).toEqual([
      "Needs you · this session",
      "◆ Review acme/web#42 · Ready",
      "  Checkout cleanup · draft at a13c90e · 12m",
      "  https://github.com/acme/web/pull/42",
      "◆ 2 findings to discuss · Ready",
      "  fix-auth-bug · retry-backoff · 5m",
      "◇ acme/api#57 · Stale",
      "  Pushed since you were asked · 3h",
      "  https://github.com/acme/api/pull/57",
    ]);
    expect(shown.options).toEqual({ triggerTurn: false });
  });

  it("prints that nothing is owed outside the terminal", async () => {
    const h = harness();
    await h.runCommand("attention", "", context("rpc").ctx);
    expect(h.shown().map((s) => s.text)).toEqual(["Nothing needs you in this session."]);
  });
});
