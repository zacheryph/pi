/**
 * A UI context that keeps the subagent widget and status bar where a test can read them: bind
 * it to a session (`bind: { uiContext }`) and `text()` is what the widget draws now. Every frame
 * Pi would draw (the widget asks for a render at each change) is kept in `frames`, because a
 * finished agent leaves the widget after a turn of its parent, which a test may not catch.
 */
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { plainTheme } from "#test-helpers";

type Component = { render(width: number): string[]; invalidate(): void };
type Factory = (tui: unknown, theme: unknown) => Component;

const WIDGET = "subagent:widget";
const STATUS = "subagent:status";

export function widgetUi(columns = 100, rows = 30) {
  let component: Component | undefined;
  let status: string | undefined;
  const frames: string[] = [];
  const statuses: (string | undefined)[] = [];
  const tui = {
    terminal: { columns, rows },
    mode: "regular",
    requestRender: () => {
      if (component) frames.push(component.render(columns).join("\n"));
    },
  };
  const own = {
    theme: plainTheme,
    setWidget(key: string, content: Factory | undefined) {
      if (key !== WIDGET) return;
      component = content?.(tui, plainTheme);
      if (!component) frames.push("");
      else tui.requestRender();
    },
    setStatus(key: string, text: string | undefined) {
      if (key !== STATUS) return;
      status = text;
      statuses.push(text);
    },
  };
  // Everything else a session may call on its UI is inert.
  const uiContext = new Proxy(own, {
    get: (target, property) =>
      property in target ? target[property as keyof typeof target] : () => undefined,
  }) as unknown as ExtensionUIContext;
  return {
    uiContext,
    /** The widget's lines as drawn now; empty when it is not shown. */
    lines: (width = columns): string[] => component?.render(width) ?? [],
    /** The widget as one string. */
    text(width = columns): string {
      return this.lines(width).join("\n");
    },
    /** Every frame drawn so far, oldest first; "" for the widget being removed. */
    frames,
    /** The status bar text, or undefined when it is cleared. */
    status: (): string | undefined => status,
    /** Every status bar text set so far, oldest first. */
    statuses,
  };
}
