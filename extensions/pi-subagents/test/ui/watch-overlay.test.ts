import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { AgentSessionEvent } from "#src/types";
import { WatchOverlay, type WatchAgent, type WatchSettings } from "#src/ui/watch-overlay";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function agent(overrides: Partial<WatchAgent> = {}) {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  let ready = false;
  const unsubscribe = vi.fn();
  const record: Mutable<WatchAgent> = {
    id: "a", type: "general-purpose", description: "watch me", isBackground: true,
    status: "running", responseText: "", result: undefined, error: undefined,
    subscribeToUpdates: vi.fn(fn => {
      if (!ready) return undefined;
      listeners.add(fn);
      return () => { listeners.delete(fn); unsubscribe(); };
    }),
    ...overrides,
  };
  return { record, unsubscribe, ready: () => { ready = true; }, emit: (event: AgentSessionEvent) => { for (const listener of listeners) listener(event); } };
}

function fixture(initial: WatchAgent[] = [], mode: "tui" | "rpc" | "print" = "tui") {
  const overlays: Array<{ component: Component; options?: OverlayOptions; handle: OverlayHandle }> = [];
  const hosts: Component[] = [];
  const tui = {
    mode: "fullscreen" as "regular" | "fullscreen",
    terminal: { columns: 120, rows: 30 },
    requestRender: vi.fn(),
    showOverlay: vi.fn((component: Component, options?: OverlayOptions) => {
      let hidden = false;
      const handle = {
        hide: vi.fn(), setHidden: vi.fn((value: boolean) => { hidden = value; }),
        isHidden: () => hidden, focus: vi.fn(), unfocus: vi.fn(), isFocused: () => false,
        getBounds: () => undefined,
      };
      overlays.push({ component, options, handle });
      return handle;
    }),
  };
  const ui = {
    theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    notify: vi.fn(),
    setWidget: vi.fn((_key: string, factory: unknown) => {
      if (typeof factory === "function") {
        const host = factory(tui, ui.theme);
        hosts.push(host);
        expect(host.render(120)).toEqual([]);
      }
    }),
  };
  const context = { mode, hasUI: mode !== "print", ui: ui as unknown as ExtensionUIContext };
  const settings: Mutable<WatchSettings> = { overlayWidth: "third", overlayDefaultOpen: true, overlayShowThinking: true };
  const watch = new WatchOverlay({ listAgents: () => initial }, new AgentTypeRegistry(() => new Map()), settings);
  watch.setContext(context);
  return { watch, context, settings, ui, tui, overlays, hosts, text: () => overlays.at(-1)!.component.render(40).join("\n") };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10000); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("WatchOverlay lifecycle and visibility", () => {
  it("auto-opens passively on background activity using configured width", () => {
    const f = fixture();
    expect(f.overlays).toHaveLength(0);
    const a = agent();
    f.watch.onSubagentStarted(a.record);
    expect(f.overlays).toHaveLength(1);
    expect(f.overlays[0].options).toMatchObject({ anchor: "top-right", width: "33.333%", nonCapturing: true });
    expect(f.overlays[0].options!.visible!(120, 30)).toBe(true);
    expect(f.overlays[0].options!.visible!(12, 7)).toBe(false);
    expect(f.text()).toContain("watch me");
    f.watch.dispose();
  });

  it("subscribes at session-ready before first output, including while hidden", () => {
    const f = fixture();
    const a = agent();
    f.watch.onSubagentStarted(a.record);
    expect(a.record.subscribeToUpdates).not.toHaveBeenCalled();
    a.ready();
    f.watch.onSubagentSessionCreated(a.record);
    f.watch.toggle();
    a.emit({ type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "auth.ts" } });
    a.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Found middleware" }] } } as AgentSessionEvent);
    f.watch.toggle();
    expect(f.text()).toContain("auth.ts");
    expect(f.text()).toContain("Found middleware");
    expect(a.record.subscribeToUpdates).toHaveBeenCalledTimes(1);
    f.watch.dispose();
  });

  it("shows thinking by default, filters live, and re-shows recent thinking retained while hidden", () => {
    const f = fixture();
    const a = agent();
    a.ready();
    f.watch.onSubagentSessionCreated(a.record);
    a.emit({ type: "message_update", message: { role: "assistant", content: [
      { type: "thinking", thinking: "provider reasoning" }, { type: "text", text: "normal output" },
    ] } } as AgentSessionEvent);
    expect(f.text()).toContain("Think provider reasoning");
    expect(f.text()).toContain("normal output");
    vi.advanceTimersByTime(100);
    const paints = f.tui.requestRender.mock.calls.length;
    f.settings.overlayShowThinking = false;
    f.watch.settingsChanged();
    expect(f.text()).not.toContain("provider reasoning");
    expect(f.text()).toContain("normal output");
    vi.advanceTimersByTime(100);
    expect(f.tui.requestRender).toHaveBeenCalledTimes(paints + 1);
    f.watch.toggle(); // panel hidden; feed still retained
    a.emit({ type: "message_end", message: { role: "assistant", content: [
      { type: "thinking", thinking: "recent hidden reasoning" }, { type: "text", text: "normal output" },
    ] } } as AgentSessionEvent);
    f.settings.overlayShowThinking = true;
    f.watch.settingsChanged();
    expect(f.overlays).toHaveLength(1);
    expect(f.overlays[0].handle.isHidden()).toBe(true);
    f.watch.toggle();
    expect(f.text()).toContain("Think recent hidden reasoning");
    expect(f.text()).not.toContain("provider reasoning");
    f.watch.dispose();
  });

  it("recognizes live nested skill reads using child resources and cwd, never inherited history", () => {
    const f = fixture();
    const skills = [{ name: "deploy", filePath: "/child/skills/deploy/SKILL.md" }];
    const session = {
      resourceLoader: { getSkills: vi.fn(() => ({ skills })) },
      sessionManager: { getCwd: vi.fn(() => "/child") },
      get messages(): never { throw new Error("Must not read inherited transcript"); },
    };
    const a = agent({ subagentSession: { session } });
    a.ready();
    f.watch.onSubagentSessionCreated(a.record);
    expect(f.text()).not.toContain("Skill deploy");
    a.emit({ type: "tool_execution_start", toolCallId: "p/1", parentToolCallId: "p", toolName: "read", args: { path: "skills/deploy/SKILL.md" } });
    expect(f.text()).toContain("Skill deploy · loading…");
    expect(f.text()).not.toContain("loaded");
    a.emit({ type: "tool_execution_end", toolCallId: "p/1", parentToolCallId: "p", toolName: "read", result: { content: [{ type: "text", text: "private instructions" }] }, isError: false });
    expect(f.text()).toContain("Skill deploy · loaded");
    expect(f.text()).not.toContain("private instructions");
    expect(session.resourceLoader.getSkills).toHaveBeenCalledOnce();
    expect(session.sessionManager.getCwd).toHaveBeenCalledOnce();
    f.watch.dispose();
  });

  it("colors final agent errors with error theme token", () => {
    const f = fixture();
    const fg = vi.fn((_color: string, text: string) => text);
    f.ui.theme.fg = fg;
    f.watch.onSubagentCompleted(agent({ status: "error", error: "Oops" }).record);
    f.text();
    expect(fg).toHaveBeenCalledWith("error", "Error: Oops");
    f.watch.dispose();
  });

  it("keeps explicit hide across idle and subsequent agent runs", () => {
    const f = fixture();
    const a = agent();
    f.watch.onSubagentStarted(a.record);
    f.watch.toggle(); // explicitly hidden
    a.record.status = "completed";
    f.watch.onSubagentCompleted(a.record);
    vi.advanceTimersByTime(8100);
    f.watch.onSubagentStarted(agent({ id: "b" }).record);
    expect(f.overlays).toHaveLength(1);
    expect(f.overlays[0].handle.isHidden()).toBe(true);
    f.watch.toggle();
    expect(f.overlays[0].handle.isHidden()).toBe(false);
    f.watch.dispose();
  });

  it("automatic idle hiding does not change default preference", () => {
    const f = fixture();
    const a = agent();
    f.watch.onSubagentStarted(a.record);
    a.record.status = "completed";
    f.watch.onSubagentCompleted(a.record);
    vi.advanceTimersByTime(8100);
    expect(f.overlays[0].handle.isHidden()).toBe(true);
    f.watch.onSubagentStarted(agent({ id: "b" }).record);
    expect(f.overlays[0].handle.isHidden()).toBe(false);
    f.watch.dispose();
  });

  it("uses persisted closed default only before explicit session choice", () => {
    const f = fixture();
    f.settings.overlayDefaultOpen = false;
    f.watch.onSubagentStarted(agent().record);
    expect(f.overlays).toHaveLength(0);
    f.watch.toggle();
    expect(f.overlays[0].handle.isHidden()).toBe(false);
    f.watch.toggle();
    f.settings.overlayDefaultOpen = true;
    f.watch.settingsChanged();
    expect(f.overlays[0].handle.isHidden()).toBe(true);
    f.watch.dispose();
  });

  it("changes width live without taking focus or creating duplicate overlays", () => {
    const f = fixture();
    f.watch.onSubagentStarted(agent().record);
    f.settings.overlayWidth = "half";
    f.watch.settingsChanged();
    expect(f.overlays).toHaveLength(2);
    expect(f.overlays[0].handle.hide).toHaveBeenCalledTimes(1);
    expect(f.overlays[1].options!.width).toBe("50%");
    expect(f.overlays[1].handle.focus).not.toHaveBeenCalled();
    f.watch.dispose();
  });

  it("coalesces output repaint requests and stops repainting while hidden", () => {
    const f = fixture();
    const a = agent();
    a.ready();
    f.watch.onSubagentSessionCreated(a.record);
    for (let i = 0; i < 50; i++) a.emit({ type: "tool_execution_start", toolCallId: String(i), toolName: "read", args: {} });
    vi.advanceTimersByTime(100);
    expect(f.tui.requestRender).toHaveBeenCalledTimes(1);
    f.watch.toggle();
    a.emit({ type: "tool_execution_start", toolCallId: "hidden", toolName: "read", args: {} });
    vi.advanceTimersByTime(100);
    expect(f.tui.requestRender).toHaveBeenCalledTimes(1);
    f.watch.dispose();
  });

  it("retains final outcome briefly and re-subscribes when resumed", () => {
    const f = fixture();
    const a = agent();
    a.ready();
    f.watch.onSubagentSessionCreated(a.record);
    a.record.status = "error";
    a.record.error = "Oops";
    f.watch.onSubagentCompleted(a.record);
    expect(a.unsubscribe).toHaveBeenCalledTimes(1);
    expect(f.text()).toContain("Error: Oops");
    vi.advanceTimersByTime(4000);
    a.record.status = "running";
    f.watch.onSubagentResuming(a.record);
    expect(a.record.subscribeToUpdates).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(8000);
    expect(f.text()).toContain("Resuming");
    expect(f.overlays[0].handle.isHidden()).toBe(false);
    f.watch.dispose();
  });

  it("does not mount in regular mode, warns on toggle, and responds to mode switches", () => {
    const f = fixture();
    f.tui.mode = "regular";
    f.hosts[0].render(120);
    const a = agent();
    f.watch.onSubagentStarted(a.record);
    expect(f.overlays).toHaveLength(0);
    f.watch.toggle();
    expect(f.ui.notify).toHaveBeenCalledWith("Subagent watch overlay requires Pi fullscreen mode.", "warning");
    f.tui.mode = "fullscreen";
    f.hosts[0].render(120);
    expect(f.overlays).toHaveLength(1);
    f.watch.toggle(); // explicit close
    f.tui.mode = "regular";
    f.hosts[0].render(120);
    f.tui.mode = "fullscreen";
    f.hosts[0].render(120);
    expect(f.overlays[0].handle.isHidden()).toBe(true);
    f.watch.dispose();
  });

  it("ignores foreground agents and all non-terminal modes", () => {
    for (const mode of ["tui", "rpc", "print"] as const) {
      const f = fixture([], mode);
      f.watch.onSubagentStarted(agent({ isBackground: mode !== "tui" }).record);
      expect(f.overlays).toHaveLength(0);
      if (mode !== "tui") expect(f.ui.setWidget).not.toHaveBeenCalled();
      f.watch.dispose();
    }
  });

  it("resets session preference, captures ongoing activity without inherited history, and cleans up", () => {
    const a = agent({ responseText: "Current streamed response" });
    a.ready();
    const f = fixture([a.record]);
    expect(f.text()).toContain("Current streamed response");
    f.watch.toggle();
    f.watch.setContext(f.context);
    expect(f.overlays[0].handle.hide).toHaveBeenCalledTimes(1);
    expect(f.overlays[1].handle.isHidden()).toBe(false);
    f.watch.dispose();
    f.watch.dispose();
    expect(a.unsubscribe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    const count = f.ui.setWidget.mock.calls.length;
    f.watch.onSubagentStarted(agent().record);
    expect(f.ui.setWidget.mock.calls.length).toBe(count);
  });
});
