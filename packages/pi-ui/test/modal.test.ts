import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Focusable, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { openModal, PassiveOverlay } from "../src/modal.ts";
import { showExplorer } from "../src/explorer.ts";
import { showDetail } from "../src/detail.ts";
import type { DisposableComponent } from "../src/types.ts";
import { keys, plain, surface, theme } from "./helpers.ts";

type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
function context(mode: ExtensionContext["mode"] = "tui", hasUI = true) {
  let mount!: (component: DisposableComponent & Partial<Focusable>) => void;
  const mounted = new Promise<DisposableComponent & Partial<Focusable>>((resolve) => {
    mount = resolve;
  });
  let finish!: (value?: unknown) => void;
  const tui = surface(30),
    bindings = keys() as Parameters<Factory>[2];
  const custom = vi.fn(async (factory: Factory) => {
    const result = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const component = await factory(
      tui as unknown as TUI,
      theme as Parameters<Factory>[1],
      bindings,
      (value) => finish(value),
    );
    mount(component);
    return result;
  });
  const ui = { custom, notify: vi.fn() };
  return {
    ctx: { mode, hasUI, ui: ui as unknown as ExtensionContext["ui"] },
    custom,
    mounted,
    finish: (value?: unknown) => finish(value),
    notify: ui.notify,
  };
}

describe("modal lifecycle", () => {
  it("opens one centered overlay and delegates focus/input/disposal", async () => {
    const c = context();
    let signal!: AbortSignal;
    const component = {
      focused: false,
      value: 0,
      render() {
        return [String(this.value)];
      },
      invalidate: vi.fn(),
      dispose: vi.fn(),
      handleInput() {
        this.value++;
      },
    };
    const opening = openModal<number>(c.ctx, (_tui, _theme, _keys, done, lifetime) => {
      signal = lifetime;
      component.handleInput = function () {
        this.value++;
        done(this.value);
        done(99);
      };
      return component;
    });
    const host = await c.mounted;
    expect(signal.aborted).toBe(false);
    expect(c.custom).toHaveBeenCalledOnce();
    const options = c.custom.mock.calls[0] as unknown as [
      Factory,
      { overlay: boolean; overlayOptions?: OverlayOptions },
    ];
    expect(options[1]).toEqual({
      overlay: true,
      overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" },
    });
    host.focused = true;
    expect(component.focused).toBe(true);
    host.handleInput?.("x");
    expect(await opening).toBe(1);
    expect(signal.aborted).toBe(true);
    expect(host.render(80)).toEqual(["1"]);
    host.dispose?.();
    host.dispose?.();
    expect(component.dispose).toHaveBeenCalledOnce();
  });
  it("aborts on host disposal, and aborts a rejected factory", async () => {
    const c = context();
    let signal!: AbortSignal;
    const opening = openModal(c.ctx, (_tui, _theme, _keys, _done, lifetime) => {
      signal = lifetime;
      return { render: () => [], invalidate() {} };
    });
    const host = await c.mounted;
    host.dispose?.();
    expect(signal.aborted).toBe(true);
    c.finish();
    await opening;
    const failed = context();
    await expect(
      openModal(failed.ctx, (_tui, _theme, _keys, _done, lifetime) => {
        signal = lifetime;
        throw new Error("failed factory");
      }),
    ).rejects.toThrow("failed factory");
    expect(signal.aborted).toBe(true);
  });
  it("rejects noninteractive contexts without mounting or starting work", async () => {
    for (const c of [context("print"), context("rpc"), context("tui", false)]) {
      const factory = vi.fn(() => ({ render: () => [], invalidate() {} }));
      expect(await openModal(c.ctx, factory)).toBeUndefined();
      expect(factory).not.toHaveBeenCalled();
      expect(c.custom).not.toHaveBeenCalled();
      expect(c.notify).toHaveBeenCalledOnce();
    }
  });
  it("captures explorer nested data and detail titles before the factory runs", async () => {
    const c = context();
    const data = {
      title: { label: "Original" },
      items: [{ id: "a", label: ["Before"], badge: { text: "enabled", tone: "success" as const } }],
    };
    const opening = showExplorer(c.ctx, data);
    data.title.label = "Mutated";
    data.items[0].label[0] = "After";
    data.items[0].badge.text = "disabled";
    const host = await c.mounted;
    expect(plain(host.render(80))).toContain("Original");
    expect(plain(host.render(80))).toContain("Before");
    expect(plain(host.render(80))).toContain("enabled");
    host.handleInput?.("\x1b");
    await opening;
    const detailContext = context(),
      title = { label: "Old" },
      content = [{ heading: "Kept" }];
    const detail = showDetail(detailContext.ctx, { title, content });
    title.label = "New";
    content[0].heading = "Changed";
    const detailHost = await detailContext.mounted;
    expect(plain(detailHost.render(80))).toContain("Old");
    expect(plain(detailHost.render(80))).toContain("Kept");
    detailHost.handleInput?.("\x1b");
    await detail;
  });
});

describe("passive overlay ownership", () => {
  function setup() {
    const handles: OverlayHandle[] = [];
    const tui = {
      showOverlay: vi.fn((_component: DisposableComponent, _options?: OverlayOptions) => {
        let hidden = false;
        const handle: OverlayHandle = {
          hide: vi.fn(),
          setHidden: vi.fn((value) => {
            hidden = value;
          }),
          isHidden: () => hidden,
          focus: vi.fn(),
          unfocus: vi.fn(),
          isFocused: () => false,
          getBounds: () => undefined,
        };
        handles.push(handle);
        return handle;
      }),
    };
    return { tui, handles, owner: new PassiveOverlay(tui) };
  }
  const component = () => ({ render: () => [], invalidate() {}, dispose: vi.fn() });
  it("always stays noncapturing, hides only its own handle and disposes exactly once", () => {
    const { tui, owner, handles } = setup(),
      other = new PassiveOverlay(tui),
      a = component(),
      b = component();
    owner.show(a, { width: "50%" });
    other.show(b);
    expect(tui.showOverlay.mock.calls[0][1]).toEqual({ width: "50%", nonCapturing: true });
    owner.setHidden(true);
    expect(handles[0].isHidden()).toBe(true);
    owner.setHidden(false);
    owner.dispose();
    owner.dispose();
    expect(handles[0].hide).toHaveBeenCalledOnce();
    expect(a.dispose).toHaveBeenCalledOnce();
    expect(handles[1].hide).not.toHaveBeenCalled();
    expect(owner.show(component())).toBe(false);
    other.dispose();
    expect(b.dispose).toHaveBeenCalledOnce();
  });
  it("can remount the same component at a new width without disposing it", () => {
    const { owner, handles } = setup(),
      a = component();
    owner.show(a);
    owner.show(a, { width: "70%" });
    expect(handles[0].hide).toHaveBeenCalledOnce();
    expect(a.dispose).not.toHaveBeenCalled();
    owner.hide();
    expect(handles[1].hide).toHaveBeenCalledOnce();
    expect(a.dispose).toHaveBeenCalledOnce();
  });
  it("does not take ownership of a component that failed to mount", () => {
    const { tui, owner } = setup(),
      a = component();
    tui.showOverlay.mockImplementationOnce(() => {
      throw new Error("no overlay");
    });
    expect(() => owner.show(a)).toThrow("no overlay");
    owner.dispose();
    expect(a.dispose).not.toHaveBeenCalled();
  });
});
