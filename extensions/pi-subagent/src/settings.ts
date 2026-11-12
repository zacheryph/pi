// Persistence for pi-subagent operational settings.
// - Global:  ~/.pi/agent/subagent.json (agentDir injected at construction) — manual defaults, never written here
// - Project: <cwd>/.pi/subagent.json — written by /subagent:settings; overrides global on load

import {
  bool,
  defineSettings,
  int,
  list,
  oneOf,
  record,
  type SettingsOf,
  string,
} from "../../../packages/pi-foundations/src/settings.ts";
import { isBelowMinimumTurns, MIN_MAX_TURNS } from "#src/lifecycle/turn-limits";
import type { PromptInheritance } from "#src/types";

export type OverlayWidth = "quarter" | "third" | "half" | "two-thirds" | "four-fifths";

/** Shared settings choices and exact terminal-width fractions for the overlay. */
export const OVERLAY_WIDTH_PRESETS = {
  quarter: { label: "Quarter (1/4)", fraction: 1 / 4 },
  third: { label: "Third (1/3)", fraction: 1 / 3 },
  half: { label: "Half (1/2)", fraction: 1 / 2 },
  "two-thirds": { label: "Two-thirds (2/3)", fraction: 2 / 3 },
  "four-fifths": { label: "Four-fifths (4/5)", fraction: 4 / 5 },
} as const satisfies Record<OverlayWidth, { label: string; fraction: number }>;

/** Pi overlay sizing percentages, shared with the overlay controller. */
export const OVERLAY_WIDTH_PERCENT = {
  quarter: "25%",
  third: "33.333%",
  half: "50%",
  "two-thirds": "66.667%",
  "four-fifths": "80%",
} as const satisfies Record<OverlayWidth, `${number}%`>;

// Sanity ceilings — prevent hand-edited configs from asking for values that
// make no operational sense (e.g. 1e6 concurrent subagents). Permissive enough
// that any realistic power-user setting passes through.
const MAX_CONCURRENT_CEILING = 1024;
const MAX_TURNS_CEILING = 10_000;
const WRAP_UP_TURNS_CEILING = 1_000;
// Retention windows: 1 minute floor, two-week ceiling (60 * 24 * 14).
const RETENTION_MINUTES_CEILING = 20_160;

export const subagentSettings = defineSettings({
  name: "subagent",
  scope: "layered",
  writable: true,
  fields: {
    /** Overlay width as a fraction of the terminal width. */
    overlayWidth: oneOf(Object.keys(OVERLAY_WIDTH_PRESETS) as OverlayWidth[], {
      default: "third",
    }),
    /** Fullscreen default visibility only before an explicit show/hide in the current session. */
    overlayDefaultOpen: bool({ default: false }),
    /** Show provider-emitted thinking in the watch feed; hidden thinking remains bounded and retained. */
    overlayShowThinking: bool({ default: true }),
    maxConcurrent: int({ default: 4, min: 1, max: MAX_CONCURRENT_CEILING }),
    /**
     * 0 = unlimited — the extension's single source of truth for that convention:
     * `normalizeMaxTurns()` in turn-limits.ts treats 0 → `undefined`, and the
     * `/subagent:settings` input prompt explicitly says "0 = unlimited".
     */
    defaultMaxTurns: int({ default: 0, min: 0, max: MAX_TURNS_CEILING }),
    /** Turns left when a subagent is warned about its budget. */
    wrapUpTurns: int({ default: 2, min: 1, max: WRAP_UP_TURNS_CEILING }),
    /**
     * Minutes a done agent's session is retained once the parent read its finished result with
     * `subagent_get` (measured from the later of being done and the read). Applies only to an agent
     * with no open work; one that waits keeps its session.
     */
    consumedSessionRetentionMinutes: int({ default: 10, min: 1, max: RETENTION_MINUTES_CEILING }),
    /** Minutes a done agent's session is retained when the parent only had the completion message (safety cap). */
    unconsumedSessionRetentionMinutes: int({
      default: 720,
      min: 1,
      max: RETENTION_MINUTES_CEILING,
    }),
    /** When false, a parent interrupt (ESC) leaves running and queued subagents running. */
    abortAllOnInterrupt: bool({ default: true }),
    /**
     * When false, a background child is not given the `parent_notify` tool, so it
     * cannot interrupt the parent with a mid-run finding. Ask-back is unaffected.
     */
    midRunUpdates: bool({ default: true }),
    /**
     * Pi package sources whose extensions child sessions must not load, matched
     * against Pi's configured source string exactly (e.g. `npm:@scope/pkg`).
     * The package's skills, prompts, and themes stay available to children.
     */
    excludedExtensionPackages: list(string({ trim: true, nonEmpty: true }), { unique: true }),
    /**
     * Prompt-inheritance strategy per provider, keyed by the provider id of the
     * child's resolved model. Every provider not listed inherits `"full"`.
     * The key is the provider rather than the agent because re-homing is a
     * property of the transport, and a per-spawn `model` override moves a child
     * between transports (ADR 0009).
     */
    promptInheritance: record(oneOf(["full", "portable"] satisfies PromptInheritance[], {})),
  },
});

/** Every setting, defaults filled in. */
export type SubagentsSettings = SettingsOf<typeof subagentSettings>;

/**
 * The persisted form of the in-memory settings values. `save` merges it into
 * the project file, keeping keys it does not name. The hand-edited collections
 * are present only when non-empty, so files that never set them gain no noise.
 */
export type SettingsSnapshot = Omit<
  SubagentsSettings,
  "excludedExtensionPackages" | "promptInheritance"
> &
  Partial<Pick<SubagentsSettings, "excludedExtensionPackages" | "promptInheritance">>;

/** What a settings change tells the user, and how loudly. */
export interface Toast {
  message: string;
  level: "info" | "warning";
}

/** Emit callback — a subset of `pi.events.emit` to keep helpers testable. */
export type SettingsEmit = (event: string, payload: unknown) => void;

/**
 * Owns in-memory settings values and their load/save/persist cycle.
 * Replaces the scattered free-function + SettingsAppliers callback pattern.
 */
export class SettingsManager {
  // Assigned in the constructor from the definition's defaults.
  private _overlayWidth!: OverlayWidth;
  private _overlayDefaultOpen!: boolean;
  private _overlayShowThinking!: boolean;
  private _defaultMaxTurns: number | undefined;
  private _wrapUpTurns!: number;
  private _maxConcurrent!: number;
  private _consumedSessionRetentionMinutes!: number;
  private _unconsumedSessionRetentionMinutes!: number;
  private _abortAllOnInterrupt!: boolean;
  private _midRunUpdates!: boolean;
  private _excludedExtensionPackages!: string[];
  private _promptInheritance!: Record<string, PromptInheritance>;

  private readonly emit: SettingsEmit;
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly onMaxConcurrentChanged: (() => void) | undefined;

  constructor(deps: {
    emit: SettingsEmit;
    cwd: string;
    agentDir: string;
    onMaxConcurrentChanged?: () => void;
  }) {
    this.emit = deps.emit;
    this.cwd = deps.cwd;
    this.agentDir = deps.agentDir;
    this.onMaxConcurrentChanged = deps.onMaxConcurrentChanged;
    this.apply(subagentSettings.defaults(this.cwd, this.agentDir));
  }

  /** Take every value from `settings`, normalized by the setters. */
  private apply(settings: SubagentsSettings): void {
    this._overlayWidth = settings.overlayWidth;
    this._overlayDefaultOpen = settings.overlayDefaultOpen;
    this._overlayShowThinking = settings.overlayShowThinking;
    this.maxConcurrent = settings.maxConcurrent;
    this.defaultMaxTurns = settings.defaultMaxTurns;
    this.wrapUpTurns = settings.wrapUpTurns;
    this.consumedSessionRetentionMinutes = settings.consumedSessionRetentionMinutes;
    this.unconsumedSessionRetentionMinutes = settings.unconsumedSessionRetentionMinutes;
    this._abortAllOnInterrupt = settings.abortAllOnInterrupt;
    this._midRunUpdates = settings.midRunUpdates;
    this._excludedExtensionPackages = [...settings.excludedExtensionPackages];
    this._promptInheritance = { ...settings.promptInheritance };
  }

  get overlayWidth(): OverlayWidth {
    return this._overlayWidth;
  }

  /** Applies in fullscreen only, before an explicit show/hide in the current session. */
  get overlayDefaultOpen(): boolean {
    return this._overlayDefaultOpen;
  }

  get overlayShowThinking(): boolean {
    return this._overlayShowThinking;
  }

  // ── defaultMaxTurns: 0 or undefined → unlimited (undefined); else at least MIN_MAX_TURNS ──

  get defaultMaxTurns(): number | undefined {
    return this._defaultMaxTurns;
  }

  set defaultMaxTurns(n: number | undefined) {
    if (n == null || n === 0) {
      this._defaultMaxTurns = undefined;
    } else {
      this._defaultMaxTurns = Math.max(MIN_MAX_TURNS, n);
    }
  }

  // ── wrapUpTurns: minimum 1 ──

  get wrapUpTurns(): number {
    return this._wrapUpTurns;
  }

  set wrapUpTurns(n: number) {
    this._wrapUpTurns = Math.max(1, n);
  }

  // ── maxConcurrent: minimum 1 ──

  get maxConcurrent(): number {
    return this._maxConcurrent;
  }

  set maxConcurrent(n: number) {
    this._maxConcurrent = Math.max(1, n);
  }

  // ── retention windows: clamped to [1, RETENTION_MINUTES_CEILING] minutes ──

  get consumedSessionRetentionMinutes(): number {
    return this._consumedSessionRetentionMinutes;
  }

  set consumedSessionRetentionMinutes(n: number) {
    this._consumedSessionRetentionMinutes = clampRetentionMinutes(n);
  }

  get unconsumedSessionRetentionMinutes(): number {
    return this._unconsumedSessionRetentionMinutes;
  }

  set unconsumedSessionRetentionMinutes(n: number) {
    this._unconsumedSessionRetentionMinutes = clampRetentionMinutes(n);
  }

  // ── abortAllOnInterrupt: flipped via toggleAbortAllOnInterrupt(); no normalization ──

  get abortAllOnInterrupt(): boolean {
    return this._abortAllOnInterrupt;
  }

  // ── excludedExtensionPackages: hand-edited only; no /subagent:settings affordance ──

  get excludedExtensionPackages(): readonly string[] {
    return this._excludedExtensionPackages;
  }

  // ── promptInheritance: hand-edited only; no /subagent:settings affordance ──

  /**
   * The prompt-inheritance strategy a child on `provider` adopts.
   *
   * Unlisted providers, and a child that resolved no model at all, inherit
   * `"full"` — the default, which changes no existing child's prompt.
   */
  promptInheritanceFor(provider: string | undefined): PromptInheritance {
    if (provider === undefined) return "full";
    return this._promptInheritance[provider] ?? "full";
  }

  // ── Lifecycle methods ──

  /**
   * Load merged settings (global + project, defaults filled in), apply them to
   * the in-memory values, and emit the `subagent:settings:loaded` lifecycle event.
   * Returns the loaded settings object.
   */
  load(): SubagentsSettings {
    const settings = subagentSettings.load(this.cwd, this.agentDir);
    warnAboutAdjustedSettings(settings);
    this.apply(settings);
    this.emit("subagent:settings:loaded", { settings });
    return settings;
  }

  /**
   * Snapshot current in-memory values for persistence.
   * `defaultMaxTurns` uses 0 as the on-disk marker for unlimited (undefined).
   */
  snapshot(): SettingsSnapshot {
    const snapshot: SettingsSnapshot = {
      overlayWidth: this._overlayWidth,
      overlayDefaultOpen: this._overlayDefaultOpen,
      overlayShowThinking: this._overlayShowThinking,
      maxConcurrent: this._maxConcurrent,
      defaultMaxTurns: this._defaultMaxTurns ?? 0,
      wrapUpTurns: this._wrapUpTurns,
      consumedSessionRetentionMinutes: this._consumedSessionRetentionMinutes,
      unconsumedSessionRetentionMinutes: this._unconsumedSessionRetentionMinutes,
      abortAllOnInterrupt: this._abortAllOnInterrupt,
      midRunUpdates: this._midRunUpdates,
    };
    if (this._excludedExtensionPackages.length > 0) {
      snapshot.excludedExtensionPackages = [...this._excludedExtensionPackages];
    }
    if (Object.keys(this._promptInheritance).length > 0) {
      snapshot.promptInheritance = { ...this._promptInheritance };
    }
    return snapshot;
  }

  /** Set the overlay width preset, persist, and return the toast. */
  applyOverlayWidth(width: OverlayWidth): Toast {
    this._overlayWidth = width;
    return this.saveAndNotify(`Overlay width set to ${width}`);
  }

  /** Filter live without discarding retained thinking; existing settings event repaints the overlay. */
  toggleOverlayShowThinking(): Toast {
    this._overlayShowThinking = !this._overlayShowThinking;
    return this.saveAndNotify(
      `Overlay thinking: ${this._overlayShowThinking ? "shown" : "hidden"}`,
    );
  }

  /** Flip default visibility; explicit session show/hide still takes precedence. */
  toggleOverlayDefaultOpen(): Toast {
    this._overlayDefaultOpen = !this._overlayDefaultOpen;
    return this.saveAndNotify(
      `Overlay default visibility: ${this._overlayDefaultOpen ? "shown" : "hidden"} (before explicit show/hide this session)`,
    );
  }

  /**
   * Set maxConcurrent, notify interested parties, persist, and return the toast.
   * Owns the full consequence chain so callers just say what they want.
   */
  applyMaxConcurrent(n: number): Toast {
    this.maxConcurrent = n; // setter normalizes: max(1, n)
    this.onMaxConcurrentChanged?.();
    return this.saveAndNotify(`Max concurrency set to ${this.maxConcurrent}`);
  }

  /**
   * Set defaultMaxTurns, persist, and return the toast.
   * Pass 0 for unlimited (maps to undefined internally).
   */
  applyDefaultMaxTurns(n: number): Toast {
    this.defaultMaxTurns = n === 0 ? undefined : n; // setter normalizes further
    const label = this.defaultMaxTurns == null ? "unlimited" : String(this.defaultMaxTurns);
    return this.saveAndNotify(`Default max turns set to ${label}`);
  }

  /**
   * Set wrapUpTurns, persist, and return the toast.
   */
  applyWrapUpTurns(n: number): Toast {
    this.wrapUpTurns = n; // setter normalizes: max(1, n)
    return this.saveAndNotify(`Wrap-up turns set to ${this.wrapUpTurns}`);
  }

  /** Set the window for a done agent whose result was read (minutes), persist, and return the toast. */
  applyConsumedSessionRetentionMinutes(n: number): Toast {
    this.consumedSessionRetentionMinutes = n; // setter normalizes: clamp [1, ceiling]
    return this.saveAndNotify(
      `Session retention (result read) set to ${this.consumedSessionRetentionMinutes} min`,
    );
  }

  /** Set the window for a done agent whose result was not read (minutes), persist, and return the toast. */
  applyUnconsumedSessionRetentionMinutes(n: number): Toast {
    this.unconsumedSessionRetentionMinutes = n; // setter normalizes: clamp [1, ceiling]
    return this.saveAndNotify(
      `Session retention (result not read) set to ${this.unconsumedSessionRetentionMinutes} min`,
    );
  }

  /**
   * Flip whether a parent interrupt (ESC) aborts every subagent, persist, and
   * return the toast. The manager owns the negation so callers just say "flip it".
   */
  toggleAbortAllOnInterrupt(): Toast {
    this._abortAllOnInterrupt = !this._abortAllOnInterrupt;
    return this.saveAndNotify(
      `Abort all subagents on ESC: ${this._abortAllOnInterrupt ? "on" : "off"}`,
    );
  }

  get midRunUpdates(): boolean {
    return this._midRunUpdates;
  }

  /**
   * Flip whether a background child may interrupt the parent with a mid-run
   * update, persist, and return the toast.
   */
  toggleMidRunUpdates(): Toast {
    this._midRunUpdates = !this._midRunUpdates;
    return this.saveAndNotify(
      `Mid-run updates from background subagents: ${this._midRunUpdates ? "on" : "off"}`,
    );
  }

  /**
   * Persist the current snapshot, emit `subagent:settings:changed`,
   * and return the toast the UI should display.
   */
  saveAndNotify(successMsg: string): Toast {
    const snap = this.snapshot();
    let persisted = true;
    try {
      subagentSettings.save(this.cwd, snap);
    } catch {
      persisted = false;
    }
    this.emit("subagent:settings:changed", { settings: snap, persisted });
    return persistToastFor(successMsg, persisted);
  }
}

/** Clamp/** Clamp a retention window to [1, RETENTION_MINUTES_CEILING] minutes. */
function clampRetentionMinutes(n: number): number {
  return Math.min(RETENTION_MINUTES_CEILING, Math.max(1, n));
}

/**
 * Tell the operator about a setting that is applied differently from what
 * they wrote, so it does not change behavior silently.
 */
function warnAboutAdjustedSettings(settings: SubagentsSettings): void {
  if (isBelowMinimumTurns(settings.defaultMaxTurns)) {
    console.warn(
      `[pi-subagent] defaultMaxTurns ${settings.defaultMaxTurns} is below the minimum of ${MIN_MAX_TURNS}; using ${MIN_MAX_TURNS}.`,
    );
  }
}

/**
 * Format the user-facing toast for a settings mutation. Pure function —
 * routes the success/failure of the save into the right message + level
 * so the UI layer (index.ts) stays a thin wire between input and notification.
 */
export function persistToastFor(successMsg: string, persisted: boolean): Toast {
  return persisted
    ? { message: successMsg, level: "info" }
    : { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}
