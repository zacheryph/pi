import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type {
  Focusable,
  KeybindingsManager,
  OverlayHandle,
  OverlayOptions,
  TUI,
} from "@earendil-works/pi-tui";
import { sanitizeText } from "./text.ts";
import type { DisposableComponent } from "./types.ts";

export type ModalContext = Pick<ExtensionContext, "mode" | "hasUI" | "ui">;
export type ModalFactory<T> = (
  tui: TUI,
  theme: Theme,
  keys: KeybindingsManager,
  done: (value: T) => void,
  signal: AbortSignal,
) => DisposableComponent | Promise<DisposableComponent>;

export interface ModalOptions {
  /** Plain text used outside TUI; evaluated only when the view cannot open. */
  fallback?: string | (() => string);
  fallbackLevel?: "info" | "warning" | "error";
  command?: string;
  unavailableMessage?: string;
  overlayOptions?: Omit<OverlayOptions, "nonCapturing">;
}

/**
 * Open a capturing, centered overlay. Only Pi's fullscreen TUI is supported.
 * The signal ends on close, host disposal or failure; late async results can ignore it.
 */
export async function openModal<T>(
  ctx: ModalContext,
  factory: ModalFactory<T>,
  options: ModalOptions = {},
): Promise<T | undefined> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    const hasFallback = options.fallback !== undefined;
    const text = hasFallback
      ? typeof options.fallback === "function"
        ? options.fallback()
        : options.fallback!
      : (options.unavailableMessage ??
        `${options.command ?? "This view"} requires interactive terminal mode.`);
    ctx.ui.notify(sanitizeText(text), hasFallback ? (options.fallbackLevel ?? "info") : "warning");
    return undefined;
  }
  const controller = new AbortController();
  let finished = false;
  try {
    return await ctx.ui.custom<T>(
      async (tui, theme, keys, done) => {
        const component = await factory(
          tui,
          theme,
          keys,
          (value) => {
            if (!finished) {
              finished = true;
              controller.abort();
              done(value);
            }
          },
          controller.signal,
        );
        let disposed = false;
        // Explicit delegation retains method receivers, focus and Pi Input cursor behavior.
        const host: DisposableComponent & Focusable = {
          get focused() {
            return "focused" in component ? Boolean(component.focused) : false;
          },
          set focused(value: boolean) {
            if ("focused" in component) component.focused = value;
          },
          get wantsKeyRelease() {
            return component.wantsKeyRelease;
          },
          render: (width) => component.render(width),
          invalidate: () => component.invalidate(),
          handleInput: (data) => component.handleInput?.(data),
          handleMouse: (event) => component.handleMouse?.(event),
          dispose() {
            if (!disposed) {
              disposed = true;
              controller.abort();
              component.dispose?.();
            }
          },
        };
        return host;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "80%",
          maxHeight: "80%",
          ...options.overlayOptions,
        },
      },
    );
  } finally {
    controller.abort();
  }
}

/** Own only this passive overlay; never steal focus or use a capturing custom dialog. */
export class PassiveOverlay {
  private handle?: OverlayHandle;
  private component?: DisposableComponent;
  private disposed = false;
  constructor(private readonly tui: Pick<TUI, "showOverlay">) {}
  show(
    component: DisposableComponent,
    options: Omit<OverlayOptions, "nonCapturing"> = {},
  ): boolean {
    if (this.disposed) return false;
    if (this.component === component) {
      this.handle?.hide();
      this.handle = undefined;
    } else this.hide();
    this.handle = this.tui.showOverlay(component, { ...options, nonCapturing: true });
    this.component = component;
    return true;
  }
  setHidden(hidden: boolean): void {
    this.handle?.setHidden(hidden);
  }
  hide(): void {
    const handle = this.handle,
      component = this.component;
    this.handle = undefined;
    this.component = undefined;
    try {
      handle?.hide();
    } finally {
      component?.dispose?.();
    }
  }
  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.hide();
    }
  }
}
