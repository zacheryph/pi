import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import {
  DetailView,
  Explorer,
  ICONS,
  Widget,
  sanitizeLine,
  type UITheme,
} from "../../src/index.ts";

/** Fixture only: imports the source barrel through Pi's real loader, without workspace resolution. */
export default function probe(_pi: ExtensionAPI): void {
  const tui = { mode: "regular" as const, terminal: { columns: 60, rows: 20 }, requestRender() {} };
  const theme: UITheme = { fg: (_color, text) => text, bold: (text) => text };
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  const detail = new DetailView({
    tui,
    theme,
    keys,
    title: "SDK details",
    content: "safe\x1b]0;title\x07 content",
    done() {},
  });
  const explorer = new Explorer({
    tui,
    theme,
    keys,
    done() {},
    view: { title: "SDK explorer", items: [{ id: "a", label: "One", detail: "First" }] },
  });
  const widget = new Widget(
    { title: { label: "SDK widget", icon: ICONS.tasks }, rows: ["One"], maxRows: 2 },
    theme,
  );
  const slots = globalThis as Record<symbol, unknown>;
  slots[Symbol.for("pi-ui.test.sdk")] = {
    detail: detail.render(60),
    explorer: explorer.render(60),
    widget: widget.render(60),
    text: sanitizeLine("a\nb"),
  };
  detail.dispose();
  explorer.dispose();
}
