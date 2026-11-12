import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { sanitizeText, type DisposableComponent } from "../../../packages/pi-ui/src/index.ts";
import type { InsightView } from "#src/types";
import { legendNotice, showInsightView, toExplorerView } from "#src/viewer";
import { fakeCustomUi, fakeTui } from "../../../packages/pi-test-helpers/src/ui.ts";

const ENTER = "\r";
const palette: Record<string, number> = { success: 32, dim: 90, accent: 36, muted: 37 };
const theme = {
  fg: (token: string, text: string) => `\x1b[${palette[token] ?? 37}m${text}\x1b[0m`,
  bold: (text: string) => text,
};
const plain = (lines: readonly string[]) => lines.map(sanitizeText).join("\n");

const skillView: InsightView = {
  title: "Skills",
  note: "Read-only snapshot",
  noun: ["skill", "skills"],
  legend: [
    { label: "[loaded]", tone: "success", meaning: "fresh observation" },
    { label: "[loaded]", tone: "dim", meaning: "unobserved/dirty" },
  ],
  items: ["fresh", "dirty"].map((label, index) => ({
    id: label,
    label,
    description: `Hidden searchable description ${label}`,
    status: index ? "loaded · dirty" : "loaded",
    badge: { text: "[loaded]", tone: index ? ("dim" as const) : ("success" as const) },
    detail: [{ fields: [["Path", `/skills/${label}/SKILL.md`]] }],
  })),
};
const textView: InsightView = { title: "System prompt", note: "Captured prompt", text: "Body" };

function context(mode: ExtensionContext["mode"] = "tui", hasUI = true) {
  const mounted = fakeCustomUi<DisposableComponent>({ theme, tui: fakeTui(30, 100) });
  const ui = { notify: vi.fn(), custom: mounted.custom };
  return {
    ctx: { mode, hasUI, ui: ui as unknown as ExtensionContext["ui"] },
    ui,
    components: mounted.components,
  };
}

describe("toExplorerView", () => {
  it("prefixes titles, keeps note and legend as notices, and hides descriptions in search", () => {
    const view = toExplorerView(skillView);
    expect(view.title).toBe("System insights · Skills");
    expect(view.noun).toEqual(["skill", "skills"]);
    expect(view.notices).toEqual([
      { text: "Read-only snapshot", tone: "muted" },
      legendNotice(skillView.legend!),
    ]);
    expect(view.items[0]).toMatchObject({
      id: "fresh",
      label: "fresh",
      badge: { text: "[loaded]", tone: "success" },
      search: "loaded Hidden searchable description fresh",
    });
  });

  it("does not double-prefix titles that already name the extension", () => {
    expect(toExplorerView({ ...skillView, title: "System insights" }).title).toBe(
      "System insights",
    );
  });
});

describe("showInsightView", () => {
  it("opens lists in the shared explorer with colored badges and legend", async () => {
    const { ctx, ui, components } = context();
    await showInsightView(ctx, skillView);
    expect(ui.custom).toHaveBeenCalledOnce();
    expect(ui.custom.mock.calls[0][1]).toMatchObject({ overlay: true });
    const explorer = components[0];
    const list = explorer.render(80);
    for (const line of list) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    expect(list.find((line) => sanitizeText(line).includes("→ fresh"))).toContain(
      "\x1b[32m[loaded]\x1b[0m",
    );
    expect(plain(list)).toContain("[loaded]=fresh observation · [loaded]=unobserved/dirty");
    expect(plain(list)).toContain("1/2 skills");
    expect(plain(list)).not.toContain("Hidden searchable description");
    explorer.handleInput?.(ENTER);
    const detail = plain(explorer.render(80));
    expect(detail).toContain("System insights · Skills / fresh");
    expect(detail).toContain("/skills/fresh/SKILL.md");
    expect(detail).toContain("[loaded]=fresh observation");
  });

  it("opens the prompt as a scrolling detail view with its note above the text", async () => {
    const { ctx, components } = context();
    await showInsightView(ctx, textView);
    const rows = plain(components[0].render(80));
    expect(rows).toContain("System insights · System prompt");
    expect(rows.indexOf("Captured prompt")).toBeLessThan(rows.indexOf("Body"));
  });

  it.each(["rpc", "json", "print"] as const)("warns in %s mode without custom", async (mode) => {
    const { ctx, ui } = context(mode);
    const prepare = vi.fn(() => textView);
    await showInsightView(ctx, prepare);
    expect(prepare).not.toHaveBeenCalled();
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(
      "/system requires interactive terminal mode.",
      "warning",
    );
  });

  it("guards hasUI too", async () => {
    const { ctx, ui } = context("tui", false);
    await showInsightView(ctx, skillView);
    expect(ui.custom).not.toHaveBeenCalled();
  });

  it("snapshots items before opening so later mutation cannot change the view", async () => {
    const { ctx, ui, components } = context();
    const view = structuredClone(skillView) as InsightView & {
      items: { label: string }[];
    };
    const original = ui.custom.getMockImplementation()!;
    ui.custom.mockImplementationOnce(async (factory) => {
      view.items[0].label = "mutated";
      return original(factory);
    });
    await showInsightView(ctx, view);
    expect(plain(components[0].render(80))).not.toContain("mutated");
  });
});
