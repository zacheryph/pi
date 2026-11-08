import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { sanitizeText, type DisposableComponent } from "../../../packages/pi-ui/src/index.ts";
import type { TldrResult } from "../src/core.js";
import { errorContent, showTldr, summaryContent } from "../src/viewer.js";
import { flushMicrotasks as flush } from "../../../packages/pi-test-helpers/src/wait.ts";

const summary: TldrResult = {
  title: "routing-migration",
  premise: "Migrate 网络 routes 🚀 to the new stack",
  findings: "One issue; two fixes ;three",
  status: "Pending rollout review",
};
const theme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};
const plain = (lines: readonly string[]) => lines.map(sanitizeText).join("\n");

type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
function context(mode: ExtensionContext["mode"] = "tui") {
  const components: DisposableComponent[] = [];
  const tui = { terminal: { rows: 30, columns: 80 }, requestRender: vi.fn() };
  let closed: () => void = () => {};
  const ui = {
    notify: vi.fn(),
    custom: vi.fn(
      (factory: Factory, _options?: unknown) =>
        new Promise<undefined>((resolve) => {
          closed = () => resolve(undefined);
          void Promise.resolve(
            factory(
              tui as unknown as Parameters<Factory>[0],
              theme as unknown as Parameters<Factory>[1],
              new KeybindingsManager(TUI_KEYBINDINGS) as Parameters<Factory>[2],
              () => closed(),
            ),
          ).then((component) => components.push(component));
        }),
    ),
  };
  return {
    ctx: { mode, hasUI: true, ui: ui as unknown as ExtensionContext["ui"] },
    ui,
    tui,
    components,
  };
}

describe("summaryContent", () => {
  it("splits semicolon-separated findings into separate bullets", () => {
    expect(summaryContent(summary)).toContainEqual({
      bullets: ["One issue", "two fixes", "three"],
    });
  });

  it("bounds error messages", () => {
    const [block] = errorContent(new Error("x".repeat(1000)));
    expect("text" in block && block.text.length).toBeLessThan(400);
  });
});

describe("showTldr", () => {
  it("shows loading, then the summary and its title in place", async () => {
    const { ctx, ui, components, tui } = context();
    let resolve!: (result: TldrResult) => void;
    const opened = showTldr(ctx, () => new Promise((r) => (resolve = r)));
    await flush();
    expect(ui.custom.mock.calls[0][1]).toMatchObject({ overlay: true });
    const view = components[0];
    expect(plain(view.render(80))).toContain("Summarizing session…");
    expect(plain(view.render(80))).toContain("TLDR / session");
    resolve(summary);
    await flush();
    expect(tui.requestRender).toHaveBeenCalled();
    const text = plain(view.render(80));
    expect(text).toContain("TLDR / routing-migration");
    expect(text).toContain("• two fixes");
    expect(text).toContain("Pending rollout review");
    for (const line of view.render(80)) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    view.handleInput?.("\r");
    await opened;
  });

  it("shows errors in place without terminal controls", async () => {
    const { ctx, components } = context();
    const opened = showTldr(ctx, async () => {
      throw new Error("boom\x1b]0;hijack\x07");
    });
    await flush();
    const text = components[0].render(80).join("\n");
    expect(sanitizeText(text)).toContain("Couldn't summarize: boom");
    expect(text).not.toContain("hijack");
    expect(text).not.toContain("\x07");
    components[0].handleInput?.("\x1b");
    await opened;
  });

  it("aborts the request when the modal closes", async () => {
    const { ctx, components } = context();
    let signal!: AbortSignal;
    const opened = showTldr(ctx, (s) => {
      signal = s;
      return new Promise(() => {});
    });
    await flush();
    expect(signal.aborted).toBe(false);
    components[0].handleInput?.("\x1b");
    await opened;
    expect(signal.aborted).toBe(true);
  });

  it("warns outside interactive TUI mode", async () => {
    const { ctx, ui } = context("rpc");
    await showTldr(ctx, async () => summary);
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("/tldr requires interactive terminal mode.", "warning");
  });
});
