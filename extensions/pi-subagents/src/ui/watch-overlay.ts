/** Read-only, non-capturing Pi overlay. Child agents remain in-process. */
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { debugLog } from "#src/debug";
import type { AgentConfigLookup } from "#src/config/agent-types";
import type { SubagentManagerObserver } from "#src/lifecycle/subagent-manager";
import type { Subagent } from "#src/lifecycle/subagent";
import { OVERLAY_WIDTH_PERCENT, type OverlayWidth } from "#src/settings";
import { getDisplayName } from "#src/ui/display";
import { renderWatchOverlay, watchHeight, type WatchSection } from "#src/ui/watch-renderer";
import { WatchTail, type WatchResources } from "#src/ui/watch-tail";

export type WatchAgent = Pick<Subagent, "id" | "type" | "description" | "isBackground" | "status" | "responseText"
  | "result" | "error" | "subscribeToUpdates"> & {
    /** Resource metadata only; never inspect session messages or skill contents. */
    readonly subagentSession?: { readonly session: {
      readonly resourceLoader: { getSkills(): { skills: WatchResources["skills"] } };
      readonly sessionManager: { getCwd(): string };
    } };
  };
export interface WatchSettings {
  readonly overlayWidth: OverlayWidth;
  readonly overlayDefaultOpen: boolean;
  readonly overlayShowThinking?: boolean;
}
type WatchContext = Pick<ExtensionContext, "mode" | "hasUI"> & {
  ui: Pick<ExtensionUIContext, "setWidget" | "theme" | "notify">;
};
type WatchTUI = Pick<TUI, "mode" | "terminal" | "showOverlay" | "requestRender">;
interface Watched { record: WatchAgent; tail: WatchTail; unsubscribe?: () => void; finishedAt?: number }
const HOST_KEY = "subagent-watch-host";
const LINGER_MS = 8000;
const REPAINT_MS = 100;

export class WatchOverlay implements SubagentManagerObserver {
  private context?: WatchContext;
  private tui?: WatchTUI;
  private handle?: OverlayHandle;
  private appliedWidth?: OverlayWidth;
  private watched = new Map<string, Watched>();
  // Explicit session choice wins over persisted default; automatic idle hiding does not change it.
  private lastVisibility?: boolean;
  private visible = false;
  private repaint?: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly manager: { listAgents(): readonly WatchAgent[] },
    private readonly registry: AgentConfigLookup,
    private readonly settings: WatchSettings,
  ) {}

  setContext(context: WatchContext): void {
    this.dispose();
    if (context.mode !== "tui" || !context.hasUI) return;
    this.context = context;
    // Zero-row widget obtains Pi's injected TUI without replacing its editor or
    // opening an unresolved custom dialog. We own the low-level overlay handle,
    // so hide() removes THIS overlay, even when another extension is above it.
    context.ui.setWidget(HOST_KEY, tui => {
      this.tui = tui;
      this.refresh();
      let mode = tui.mode;
      return {
        render: () => {
          if (mode !== tui.mode) { mode = tui.mode; this.refresh(); }
          return [];
        },
        invalidate: () => {},
      };
    });
    for (const record of this.manager.listAgents()) {
      if (record.isBackground && (record.status === "running" || record.status === "queued")) {
        const watched = this.track(record);
        if (watched && record.responseText) watched.tail.note(record.responseText, "text");
        this.subscribe(record);
      }
    }
    this.refresh();
  }

  toggle(): void {
    if (!this.context) return;
    if (this.tui?.mode !== "fullscreen") {
      this.context.ui.notify("Subagent watch overlay requires Pi fullscreen mode.", "warning");
      return;
    }
    this.lastVisibility = !this.visible;
    this.refresh();
  }

  settingsChanged(): void { this.refresh(); }

  onSubagentCreated(record: WatchAgent): void { this.track(record); this.refresh(); }
  onSubagentStarted(record: WatchAgent): void { this.track(record); this.refresh(); }
  onSubagentSessionCreated(record: WatchAgent): void { this.subscribe(record); this.refresh(); }
  onSubagentCompleted(record: WatchAgent): void { this.finish(record); }
  onSubagentResumed(record: WatchAgent): void { this.finish(record); }
  onSubagentResuming(record: WatchAgent): void {
    const watched = this.track(record);
    if (watched) {
      watched.finishedAt = undefined;
      watched.tail.note("Resuming…");
      this.subscribe(record);
    }
    this.scheduleExpiry();
    this.refresh();
  }
  onSubagentCompacted(): void { this.requestRepaint(); }

  private track(record: WatchAgent): Watched | undefined {
    if (!this.context || !record.isBackground) return undefined;
    let watched = this.watched.get(record.id);
    if (!watched) {
      watched = { record, tail: new WatchTail() };
      this.watched.set(record.id, watched);
    }
    watched.record = record;
    return watched;
  }

  private subscribe(record: WatchAgent): void {
    const watched = this.track(record);
    if (!watched || watched.unsubscribe) return;
    // No inherited history: use child resources only to recognize live read evidence.
    try {
      const session = record.subagentSession?.session;
      if (session) watched.tail.setResources({
        cwd: session.sessionManager.getCwd(), skills: session.resourceLoader.getSkills().skills,
      });
    } catch (error) {
      debugLog("WatchOverlay.resources", error);
      // Metadata failure must not break observation or produce stale skill evidence.
      watched.tail.setResources({ cwd: process.cwd(), skills: [] });
    }
    watched.unsubscribe = record.subscribeToUpdates(event => {
      if (watched.tail.apply(event)) this.requestRepaint();
    });
  }

  private finish(record: WatchAgent): void {
    const watched = this.track(record);
    if (!watched) return;
    watched.unsubscribe?.();
    watched.unsubscribe = undefined;
    watched.finishedAt = Date.now();
    if (record.error) watched.tail.note(`Error: ${record.error}`, "error");
    else if (record.result && !watched.tail.blocks.some(block => block.kind === "text")) watched.tail.note(record.result, "text");
    this.scheduleExpiry();
    this.refresh();
  }

  private sections(): WatchSection[] {
    return [...this.watched.values()]
      .sort((a, b) => priority(a.record) - priority(b.record))
      .map(({ record, tail }) => ({
        id: record.id,
        label: `${getDisplayName(record.type, this.registry)}: ${record.description}`,
        status: record.status,
        blocks: tail.visibleBlocks(this.settings.overlayShowThinking ?? true),
      }));
  }

  private refresh(): void {
    if (!this.context || !this.tui) return;
    const wanted = this.lastVisibility ?? this.settings.overlayDefaultOpen;
    this.visible = this.tui.mode === "fullscreen" && wanted && (this.lastVisibility === true || this.watched.size > 0);
    if (this.handle && this.appliedWidth !== this.settings.overlayWidth) {
      this.handle.hide();
      this.handle = undefined;
    }
    if (!this.handle && this.visible) {
      try {
        this.handle = this.tui.showOverlay({
          render: width => renderWatchOverlay(this.sections(), width, watchHeight(this.tui!.terminal.rows), this.context!.ui.theme),
          invalidate: () => {},
        }, {
          anchor: "top-right",
          width: OVERLAY_WIDTH_PERCENT[this.settings.overlayWidth],
          maxHeight: "100%",
          nonCapturing: true,
          // Tiny terminals cannot afford a panel; retain visibility preference on resize.
          visible: (width, height) => this.tui?.mode === "fullscreen" && width >= 20 && height >= 10,
        });
        this.appliedWidth = this.settings.overlayWidth;
      } catch (error) {
        debugLog("WatchOverlay.showOverlay", error);
        this.visible = false;
        this.context.ui.notify("Could not open subagent watch overlay.", "warning");
      }
    }
    this.handle?.setHidden(!this.visible);
    this.requestRepaint();
  }

  private requestRepaint(): void {
    if (!this.visible || !this.tui || this.repaint) return;
    this.repaint = setTimeout(() => {
      this.repaint = undefined;
      this.tui?.requestRender();
    }, REPAINT_MS);
    this.repaint.unref?.();
  }

  private scheduleExpiry(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    const ends = [...this.watched.values()].flatMap(item => item.finishedAt == null ? [] : [item.finishedAt + LINGER_MS]);
    if (!ends.length) return;
    this.expiry = setTimeout(() => {
      this.expiry = undefined;
      const now = Date.now();
      for (const [id, item] of this.watched) {
        if (item.finishedAt != null && item.finishedAt + LINGER_MS <= now) {
          item.unsubscribe?.();
          this.watched.delete(id);
        }
      }
      this.refresh();
      this.scheduleExpiry();
    }, Math.max(0, Math.min(...ends) - Date.now()));
    this.expiry.unref?.();
  }

  dispose(): void {
    if (this.repaint) clearTimeout(this.repaint);
    if (this.expiry) clearTimeout(this.expiry);
    this.repaint = this.expiry = undefined;
    for (const item of this.watched.values()) item.unsubscribe?.();
    this.watched.clear();
    this.handle?.hide();
    this.handle = undefined;
    this.context?.ui.setWidget(HOST_KEY, undefined);
    this.context = undefined;
    this.tui = undefined;
    this.lastVisibility = undefined;
    this.appliedWidth = undefined;
    this.visible = false;
  }
}

function priority(record: WatchAgent): number {
  return record.status === "running" ? 0 : record.status === "queued" ? 1 : 2;
}
