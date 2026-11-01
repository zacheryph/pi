import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ScrollView, visibleWidth, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  InlineWindow,
  inlineWindowOpen,
  openInlineWindow,
  type InlineWindowHost,
} from "../src/inline-window.ts";
import { bodyRow } from "../src/layout.ts";
import type { DisposableComponent } from "../src/types.ts";
import { keys, plain, theme, wheel } from "./helpers.ts";

/** A fullscreen host whose transcript follows its end until scrolled. */
function host(following: boolean | undefined = true) {
  const state = { following };
  const fake = {
    requestRender: vi.fn(),
    get isFollowingOutput() {
      return state.following;
    },
    scrollToBottom: vi.fn(() => {
      state.following = true;
    }),
    scrollBy: vi.fn(),
  };
  return { fake: fake as InlineWindowHost & typeof fake, state };
}

/**
 * Pi's fullscreen layout around a real transcript ScrollView: the window sits
 * under the transcript, which gets the screen rows the window leaves. Each frame
 * renders the window, then lays the transcript out in the remaining rows.
 */
function screen(options: { rows: number; transcript: number; scrollBy: boolean }) {
  const transcript = new ScrollView({ render: () => [], invalidate() {} }, { follow: "end" });
  let window!: InlineWindow;
  const fake: InlineWindowHost = {
    requestRender: () => {},
    get isFollowingOutput() {
      return transcript.isFollowingEnd;
    },
    scrollToBottom: () => transcript.scrollToEnd(),
    ...(options.scrollBy ? { scrollBy: (lines: number) => transcript.scrollBy(lines) } : {}),
  };
  const frame = () => {
    const rows = window.render(40).length;
    transcript.updateLayout(options.transcript, options.rows - rows, () => {});
    return rows;
  };
  window = new InlineWindow(fake, theme, body(Array.from({ length: 11 }, (_, i) => `row ${i}`)), {
    title: "Question",
  });
  frame();
  return { transcript, frame };
}

function body(rows = ["first question", "second row", "third row", "fourth row"]) {
  return {
    focused: false,
    summary: () => "Which database? (1 of 2)",
    inputs: [] as string[],
    render: (width: number) => rows.map((row) => bodyRow(row, width)),
    invalidate: vi.fn(),
    dispose: vi.fn(),
    handleInput(data: string) {
      this.inputs.push(data);
    },
    handleMouse: vi.fn(() => ({ handled: true })),
  };
}

describe("InlineWindow", () => {
  it("renders a title rule above the body while the transcript follows its end", () => {
    const h = host();
    const content = body();
    const window = new InlineWindow(h.fake, theme, content, { title: "Question" });
    const lines = window.render(40);
    expect(plain(lines)).toBe(
      [
        `── Question ${"─".repeat(28)}`,
        ` first question${" ".repeat(25)}`,
        ` second row${" ".repeat(29)}`,
        ` third row${" ".repeat(30)}`,
        ` fourth row${" ".repeat(29)}`,
      ].join("\n"),
    );
    expect(window.minimized).toBe(false);
    expect(h.fake.requestRender).not.toHaveBeenCalled();
  });

  it("minimizes to a bar, the body's summary and a hint while scrolled, keeps focus, and restores on the next key without passing it on", () => {
    const h = host();
    const content = body();
    const window = new InlineWindow(h.fake, theme, content, { title: "Question" });
    window.focused = true;
    expect(content.focused).toBe(true);
    window.render(40);

    h.state.following = false;
    const minimized = window.render(40);
    expect(
      plain(minimized)
        .split("\n")
        .map((row) => row.trimEnd()),
    ).toEqual([`── ▸ Question ${"─".repeat(26)}`, " Which database? (1 of 2)", " any key returns"]);
    expect(window.minimized).toBe(true);
    expect(window.focused).toBe(true);
    // The height change asks for another layout pass, once.
    expect(h.fake.requestRender).toHaveBeenCalledOnce();
    window.render(40);
    expect(h.fake.requestRender).toHaveBeenCalledOnce();

    window.handleInput("2");
    expect(content.inputs).toEqual([]);
    expect(h.fake.scrollToBottom).toHaveBeenCalledOnce();
    expect(window.render(40)).toHaveLength(5);
    window.handleInput("2");
    expect(content.inputs).toEqual(["2"]);
  });

  it("scrolls the transcript back by the rows minimizing frees, so a small scroll does not clamp to the end and restore", () => {
    const h = host();
    const window = new InlineWindow(h.fake, theme, body(), { title: "Question" });
    window.render(40);
    h.state.following = false;
    window.render(40);
    // Five expanded rows (title and four body rows) become three.
    expect(h.fake.scrollBy).toHaveBeenCalledExactlyOnceWith(-2);
    window.render(40);
    h.state.following = true;
    window.render(40);
    expect(h.fake.scrollBy).toHaveBeenCalledOnce();
  });

  it("does not scroll when it first renders minimized, having freed nothing", () => {
    const h = host(false);
    new InlineWindow(h.fake, theme, body(), { title: "Question" }).render(40);
    expect(h.fake.scrollBy).not.toHaveBeenCalled();
  });

  it("stays minimized after a one-line scroll against Pi's real transcript ScrollView", () => {
    const anchored = screen({ rows: 40, transcript: 200, scrollBy: true });
    anchored.transcript.scrollBy(-1);
    const heights = Array.from({ length: 4 }, anchored.frame);
    expect(heights).toEqual([3, 3, 3, 3]);
    expect(anchored.transcript.isFollowingEnd).toBe(false);
    // The last line seen (one above the end with 28 transcript rows) stays at the bottom.
    expect(anchored.transcript.scrollTop + anchored.transcript.viewportHeight).toBe(199);

    // Scrolling back to the end restores it, and it stays restored.
    anchored.transcript.scrollBy(100);
    expect(Array.from({ length: 3 }, anchored.frame)).toEqual([12, 12, 12]);
    expect(anchored.transcript.isFollowingEnd).toBe(true);

    // Without scrollBy the transcript clamps to its new end and the window restores at once.
    const clamped = screen({ rows: 40, transcript: 200, scrollBy: false });
    clamped.transcript.scrollBy(-1);
    expect(Array.from({ length: 3 }, clamped.frame)).toEqual([3, 12, 12]);
  });

  it("restores by itself when the transcript is scrolled back to its end", () => {
    const h = host(false);
    const window = new InlineWindow(h.fake, theme, body(), { title: "Question" });
    expect(window.render(30)).toHaveLength(3);
    h.state.following = true;
    expect(window.render(30)).toHaveLength(5);
  });

  it("never minimizes in regular mode, where the terminal owns scrollback", () => {
    const h = host(undefined);
    const content = body();
    const window = new InlineWindow(h.fake, theme, content, { title: "Question" });
    expect(window.render(30)).toHaveLength(5);
    window.handleInput("x");
    expect(content.inputs).toEqual(["x"]);
    expect(h.fake.scrollToBottom).not.toHaveBeenCalled();
  });

  it("routes mouse events below the title rule to the body, and none while minimized", () => {
    const h = host();
    const content = body();
    const window = new InlineWindow(h.fake, theme, content, { title: "Question" });
    window.handleMouse({ ...wheel(1), type: "click", button: "left", y: 2, height: 3 });
    expect(content.handleMouse).toHaveBeenCalledWith(expect.objectContaining({ y: 1, height: 2 }));
    h.state.following = false;
    expect(window.handleMouse(wheel(-1))).toBeUndefined();
    expect(content.handleMouse).toHaveBeenCalledOnce();
  });

  it("stays within every width, including narrow ones, with ANSI and wide text", () => {
    for (const following of [true, false]) {
      const h = host(following);
      const window = new InlineWindow(
        h.fake,
        theme,
        {
          ...body(["\x1b[31m日本語の質問 👩‍💻 é\x1b[39m", "plain"]),
          summary: () => "\x1b[2J質問 👩‍💻 waiting\nsecond line",
        },
        { title: { icon: "?", label: "質問 \x1b[2Jtitle", detail: "1/2" }, minimizedHint: "押す" },
      );
      for (let width = 0; width <= 40; width++) {
        const lines = window.render(width);
        for (const line of lines) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
          expect(line).not.toContain("\x1b[2J");
        }
        // Every row below the title rule is an inset body row, minimized or not.
        for (const row of lines.slice(1)) {
          if (width <= 2) expect(row).toBe(" ".repeat(width));
          else {
            expect(row.startsWith(" ") && row.endsWith(" ")).toBe(true);
            expect(visibleWidth(row)).toBe(width);
          }
        }
      }
    }
  });

  it("delegates invalidate and dispose to the body", () => {
    const content = body();
    const window = new InlineWindow(host().fake, theme, content, { title: "Q" });
    window.invalidate();
    window.dispose();
    expect(content.invalidate).toHaveBeenCalledOnce();
    expect(content.dispose).toHaveBeenCalledOnce();
  });
});

describe("openInlineWindow", () => {
  type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
  function context(mode: ExtensionContext["mode"] = "tui", hasUI = true) {
    let mount!: (component: DisposableComponent & Partial<Focusable>) => void;
    const mounted = new Promise<DisposableComponent & Partial<Focusable>>((resolve) => {
      mount = resolve;
    });
    let finish!: (value?: unknown) => void;
    const h = host();
    const custom = vi.fn(async (factory: Factory, _options?: unknown) => {
      const result = new Promise<unknown>((resolve) => {
        finish = resolve;
      });
      mount(
        await factory(
          h.fake as unknown as TUI,
          theme as Parameters<Factory>[1],
          keys() as Parameters<Factory>[2],
          (value) => finish(value),
        ),
      );
      return result;
    });
    const ui = { custom, notify: vi.fn() };
    return {
      ctx: { mode, hasUI, ui: ui as unknown as ExtensionContext["ui"] },
      custom,
      mounted,
      h,
    };
  }

  it("mounts in the editor's place, not as an overlay, and resolves once with done's value", async () => {
    const c = context();
    let signal!: AbortSignal;
    const content = body();
    const opening = openInlineWindow<string>(
      c.ctx,
      "Question",
      (_tui, _theme, _keys, done, lifetime) => {
        signal = lifetime;
        content.handleInput = (data: string) => {
          done(data);
          done("late");
        };
        return content;
      },
    );
    const mounted = await c.mounted;
    expect(c.custom.mock.calls[0]).toHaveLength(1);
    mounted.focused = true;
    expect(content.focused).toBe(true);
    expect(plain(mounted.render(20)).split("\n")[0]).toContain("Question");
    mounted.handleInput?.("yes");
    expect(await opening).toBe("yes");
    expect(signal.aborted).toBe(true);
    mounted.dispose?.();
    mounted.dispose?.();
    expect(content.dispose).toHaveBeenCalledOnce();
  });

  it("reports itself open from mount until disposal, across separate windows", async () => {
    expect(inlineWindowOpen()).toBe(false);
    const first = context();
    const second = context();
    const opening = [first, second].map((c) =>
      openInlineWindow<string>(c.ctx, "Q", (_tui, _theme, _keys, done) => {
        const content = body();
        content.handleInput = (data: string) => done(data);
        return content;
      }),
    );
    const [one, two] = await Promise.all([first.mounted, second.mounted]);
    expect(inlineWindowOpen()).toBe(true);
    one.dispose?.();
    one.dispose?.();
    expect(inlineWindowOpen()).toBe(true);
    two.handleInput?.("done");
    one.handleInput?.("done");
    await Promise.all(opening);
    // Resolving releases it even if the host never disposes the component.
    expect(inlineWindowOpen()).toBe(false);
    two.dispose?.();
    expect(inlineWindowOpen()).toBe(false);
  });

  it("notifies instead of opening without an interactive terminal", async () => {
    for (const [mode, hasUI] of [
      ["rpc", true],
      ["tui", false],
      ["print", false],
    ] as const) {
      const c = context(mode, hasUI);
      expect(await openInlineWindow(c.ctx, "Q", () => body(), { unavailableMessage: "nope" })).toBe(
        undefined,
      );
      expect(c.custom).not.toHaveBeenCalled();
      expect((c.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
        "nope",
        "warning",
      ]);
    }
  });
});
