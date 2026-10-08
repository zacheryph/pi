import { beforeEach, describe, expect, it, vi } from "vitest";
import { type OverlayWidth, OVERLAY_WIDTH_PRESETS } from "#src/settings";
import { SubagentsSettingsHandler } from "#src/ui/subagents-settings";
import { makeMenuUI } from "#test/helpers/ui-stubs";

function makeSettings() {
  return {
    maxConcurrent: 4,
    defaultMaxTurns: undefined as number | undefined,
    wrapUpTurns: 2,
    applyMaxConcurrent: vi.fn((): { message: string; level: "info" | "warning" } => ({
      message: "Max concurrency set to 8",
      level: "info",
    })),
    applyDefaultMaxTurns: vi.fn((): { message: string; level: "info" | "warning" } => ({
      message: "Default max turns set to unlimited",
      level: "info",
    })),
    applyWrapUpTurns: vi.fn((): { message: string; level: "info" | "warning" } => ({
      message: "Wrap-up turns set to 3",
      level: "info",
    })),
    consumedSessionRetentionMinutes: 10,
    unconsumedSessionRetentionMinutes: 720,
    applyConsumedSessionRetentionMinutes: vi.fn((): { message: string; level: "info" | "warning" } => ({
      message: "Consumed-session retention set to 30 min",
      level: "info",
    })),
    applyUnconsumedSessionRetentionMinutes: vi.fn((): { message: string; level: "info" | "warning" } => ({
      message: "Unconsumed-session retention set to 1440 min",
      level: "info",
    })),
    abortAllOnInterrupt: true,
    toggleAbortAllOnInterrupt: vi.fn((): { message: string; level: "info" | "warning" } => ({
      message: "Abort all subagents on ESC: off",
      level: "info",
    })),
    overlayWidth: "third" as OverlayWidth,
    overlayDefaultOpen: false,
    applyOverlayWidth: vi.fn((width: OverlayWidth): { message: string; level: "info" | "warning" } => ({
      message: `Overlay width set to ${width}`,
      level: "info",
    })),
    toggleOverlayDefaultOpen: vi.fn((): { message: string; level: "info" | "warning" } => ({
      message: "Overlay default visibility: shown (before explicit show/hide this session)",
      level: "info",
    })),
    midRunUpdates: true,
    toggleMidRunUpdates: vi.fn((): { message: string; level: "info" | "warning" } => ({
      message: "Mid-run updates from background subagents: off",
      level: "info",
    })),
  };
}

function makeHandler(settings = makeSettings()) {
  const handler = new SubagentsSettingsHandler(settings);
  return { handler, settings };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SubagentsSettingsHandler", () => {
  it("is constructable", () => {
    const { handler } = makeHandler();
    expect(handler).toBeInstanceOf(SubagentsSettingsHandler);
  });

  it("shows the nine settings options with current values", async () => {
    const { handler } = makeHandler();
    const ui = makeMenuUI([undefined]); // cancel immediately
    await handler.handle({ ui });
    const options = ui.select.mock.calls[0][1] as string[];
    expect(options).toEqual([
      "Max concurrency (current: 4)",
      "Default max turns (current: unlimited)",
      "Wrap-up turns (current: 2)",
      "Consumed-session retention (current: 10 min)",
      "Unconsumed-session retention (current: 720 min)",
      "Abort all subagents on ESC (current: on)",
      "Mid-run updates from background subagents (current: on)",
      "Overlay width (current: third)",
      "Overlay default visibility (before explicit show/hide this session) (current: hidden)",
    ]);
  });

  it("toggles mid-run updates from the settings list", async () => {
    const settings = makeSettings();
    const { handler } = makeHandler(settings);
    const ui = makeMenuUI(["Mid-run updates from background subagents (current: on)"]);

    await handler.handle({ ui });

    expect(settings.toggleMidRunUpdates).toHaveBeenCalledOnce();
    expect(ui.notify).toHaveBeenCalledWith(
      "Mid-run updates from background subagents: off",
      "info",
    );
  });

  it("renders the abort-on-ESC option as off when the policy is disabled", async () => {
    const settings = makeSettings();
    settings.abortAllOnInterrupt = false;
    const { handler } = makeHandler(settings);
    const ui = makeMenuUI([undefined]);
    await handler.handle({ ui });
    const options = ui.select.mock.calls[0][1] as string[];
    expect(options[5]).toBe("Abort all subagents on ESC (current: off)");
  });

  it("applies no change when the settings list is cancelled", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI([undefined]);
    await handler.handle({ ui });
    expect(settings.applyMaxConcurrent).not.toHaveBeenCalled();
    expect(settings.applyDefaultMaxTurns).not.toHaveBeenCalled();
    expect(settings.applyWrapUpTurns).not.toHaveBeenCalled();
    expect(settings.applyOverlayWidth).not.toHaveBeenCalled();
    expect(settings.toggleOverlayDefaultOpen).not.toHaveBeenCalled();
    expect(ui.input).not.toHaveBeenCalled();
  });
});

describe("SubagentsSettingsHandler — overlay settings", () => {
  it.each<OverlayWidth>(["quarter", "third", "half", "two-thirds"])(
    "selects width preset %s without freeform input",
    async (width) => {
      const { handler, settings } = makeHandler();
      const ui = makeMenuUI(["Overlay width (current: third)", OVERLAY_WIDTH_PRESETS[width].label]);
      await handler.handle({ ui });
      expect(ui.select).toHaveBeenNthCalledWith(
        2,
        "Overlay width (fraction of terminal width)",
        ["Quarter (1/4)", "Third (1/3)", "Half (1/2)", "Two-thirds (2/3)"],
      );
      expect(settings.applyOverlayWidth).toHaveBeenCalledExactlyOnceWith(width);
      expect(ui.input).not.toHaveBeenCalled();
      expect(ui.notify).toHaveBeenCalledWith(`Overlay width set to ${width}`, "info");
    },
  );

  it("does not change width or notify when preset selection is cancelled", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Overlay width (current: third)", undefined]);
    await handler.handle({ ui });
    expect(settings.applyOverlayWidth).not.toHaveBeenCalled();
    expect(ui.input).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("ignores a selection outside the fixed preset list", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Overlay width (current: third)", "0.75"]);
    await handler.handle({ ui });
    expect(settings.applyOverlayWidth).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("renders the current width and default visibility", async () => {
    const settings = makeSettings();
    settings.overlayWidth = "half";
    settings.overlayDefaultOpen = true;
    const { handler } = makeHandler(settings);
    const ui = makeMenuUI([undefined]);
    await handler.handle({ ui });
    expect(ui.select.mock.calls[0][1]).toContain("Overlay width (current: half)");
    expect(ui.select.mock.calls[0][1]).toContain(
      "Overlay default visibility (before explicit show/hide this session) (current: shown)",
    );
  });

  it("toggles default visibility directly and states explicit session choice takes precedence", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI([
      "Overlay default visibility (before explicit show/hide this session) (current: hidden)",
    ]);
    await handler.handle({ ui });
    expect(settings.toggleOverlayDefaultOpen).toHaveBeenCalledOnce();
    expect(ui.input).not.toHaveBeenCalled();
    expect(ui.select).toHaveBeenCalledOnce();
    expect(ui.notify).toHaveBeenCalledWith(
      "Overlay default visibility: shown (before explicit show/hide this session)", "info",
    );
  });

  it("forwards persistence warning from the width mutation", async () => {
    const { handler, settings } = makeHandler();
    settings.applyOverlayWidth.mockReturnValue({
      message: "Overlay width set to half (session only; failed to persist)",
      level: "warning",
    });
    const ui = makeMenuUI(["Overlay width (current: third)", "Half (1/2)"]);
    await handler.handle({ ui });
    expect(ui.notify).toHaveBeenCalledWith(
      "Overlay width set to half (session only; failed to persist)", "warning",
    );
  });
});

describe("SubagentsSettingsHandler — max concurrency", () => {
  it("delegates a valid value to applyMaxConcurrent and notifies the returned toast", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Max concurrency (current: 4)"]);
    ui.input = vi.fn().mockResolvedValue("8");
    await handler.handle({ ui });
    expect(settings.applyMaxConcurrent).toHaveBeenCalledWith(8);
    expect(ui.notify).toHaveBeenCalledWith("Max concurrency set to 8", "info");
  });

  it("rejects a value below 1 with a warning and does not apply", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Max concurrency (current: 4)"]);
    ui.input = vi.fn().mockResolvedValue("0");
    await handler.handle({ ui });
    expect(settings.applyMaxConcurrent).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Must be a positive integer.", "warning");
  });

  it("does not apply when the input is cancelled", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Max concurrency (current: 4)"]);
    ui.input = vi.fn().mockResolvedValue(undefined);
    await handler.handle({ ui });
    expect(settings.applyMaxConcurrent).not.toHaveBeenCalled();
  });

  it("rejects non-numeric input with a warning and does not apply", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Max concurrency (current: 4)"]);
    ui.input = vi.fn().mockResolvedValue("abc");
    await handler.handle({ ui });
    expect(settings.applyMaxConcurrent).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Must be a positive integer.", "warning");
  });
});

describe("SubagentsSettingsHandler — default max turns", () => {
  it("delegates 0 (unlimited) to applyDefaultMaxTurns", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Default max turns (current: unlimited)"]);
    ui.input = vi.fn().mockResolvedValue("0");
    await handler.handle({ ui });
    expect(settings.applyDefaultMaxTurns).toHaveBeenCalledWith(0);
    expect(ui.notify).toHaveBeenCalledWith("Default max turns set to unlimited", "info");
  });

  it("delegates a positive value to applyDefaultMaxTurns", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Default max turns (current: unlimited)"]);
    ui.input = vi.fn().mockResolvedValue("20");
    await handler.handle({ ui });
    expect(settings.applyDefaultMaxTurns).toHaveBeenCalledWith(20);
  });

  it("rejects a negative value with a warning and does not apply", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Default max turns (current: unlimited)"]);
    ui.input = vi.fn().mockResolvedValue("-1");
    await handler.handle({ ui });
    expect(settings.applyDefaultMaxTurns).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(
      "Must be 0 (unlimited) or a positive integer.",
      "warning",
    );
  });
});

describe("SubagentsSettingsHandler — wrap-up turns", () => {
  it("delegates a valid value to applyWrapUpTurns and notifies the returned toast", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Wrap-up turns (current: 2)"]);
    ui.input = vi.fn().mockResolvedValue("3");
    await handler.handle({ ui });
    expect(settings.applyWrapUpTurns).toHaveBeenCalledWith(3);
    expect(ui.notify).toHaveBeenCalledWith("Wrap-up turns set to 3", "info");
  });

  it("rejects a value below 1 with a warning and does not apply", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Wrap-up turns (current: 2)"]);
    ui.input = vi.fn().mockResolvedValue("0");
    await handler.handle({ ui });
    expect(settings.applyWrapUpTurns).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Must be a positive integer.", "warning");
  });
});

describe("SubagentsSettingsHandler — retention windows", () => {
  it("delegates a valid consumed window to applyConsumedSessionRetentionMinutes", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Consumed-session retention (current: 10 min)"]);
    ui.input = vi.fn().mockResolvedValue("30");
    await handler.handle({ ui });
    expect(settings.applyConsumedSessionRetentionMinutes).toHaveBeenCalledWith(30);
    expect(ui.notify).toHaveBeenCalledWith("Consumed-session retention set to 30 min", "info");
  });

  it("delegates a valid unconsumed window to applyUnconsumedSessionRetentionMinutes", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Unconsumed-session retention (current: 720 min)"]);
    ui.input = vi.fn().mockResolvedValue("1440");
    await handler.handle({ ui });
    expect(settings.applyUnconsumedSessionRetentionMinutes).toHaveBeenCalledWith(1440);
    expect(ui.notify).toHaveBeenCalledWith("Unconsumed-session retention set to 1440 min", "info");
  });

  it("rejects a consumed window below 1 with a warning and does not apply", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Consumed-session retention (current: 10 min)"]);
    ui.input = vi.fn().mockResolvedValue("0");
    await handler.handle({ ui });
    expect(settings.applyConsumedSessionRetentionMinutes).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Must be a positive integer.", "warning");
  });
});

describe("SubagentsSettingsHandler — abort all subagents on ESC", () => {
  it("flips the policy directly and notifies the returned toast", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Abort all subagents on ESC (current: on)"]);
    await handler.handle({ ui });
    expect(settings.toggleAbortAllOnInterrupt).toHaveBeenCalledOnce();
    expect(ui.notify).toHaveBeenCalledWith("Abort all subagents on ESC: off", "info");
  });

  it("never prompts for input — the toggle is a direct flip", async () => {
    const { handler } = makeHandler();
    const ui = makeMenuUI(["Abort all subagents on ESC (current: on)"]);
    await handler.handle({ ui });
    expect(ui.input).not.toHaveBeenCalled();
  });

  it("does not flip the policy when the settings list is cancelled", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI([undefined]);
    await handler.handle({ ui });
    expect(settings.toggleAbortAllOnInterrupt).not.toHaveBeenCalled();
  });

  it("does not flip the policy when a numeric setting is chosen", async () => {
    const { handler, settings } = makeHandler();
    const ui = makeMenuUI(["Wrap-up turns (current: 2)"]);
    ui.input = vi.fn().mockResolvedValue("3");
    await handler.handle({ ui });
    expect(settings.toggleAbortAllOnInterrupt).not.toHaveBeenCalled();
  });
});
