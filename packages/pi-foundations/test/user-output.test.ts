import { describe, expect, it, vi } from "vitest";
import { fakePi } from "#test-helpers";
import {
  capOutput,
  isTerminal,
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_LINES,
  userOutput,
  type OutputContext,
} from "#src/user-output";

const context = (mode: OutputContext["mode"], hasUI = mode === "tui" || mode === "rpc") => ({
  mode,
  hasUI,
  ui: { notify: vi.fn() },
});

describe("userOutput", () => {
  it("notifies in the terminal and sends nothing", () => {
    const h = fakePi();
    const ctx = context("tui");
    userOutput(h.api, "demo:output").show(ctx, "hello \u001b[31mred", "warning");
    // The terminal keeps the text exactly as the caller built it.
    expect(ctx.ui.notify).toHaveBeenCalledWith("hello \u001b[31mred", "warning");
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["rpc", "json", "print"] as const)(
    "sends a displayed message that starts no turn in %s mode",
    (mode) => {
      const h = fakePi();
      const ctx = context(mode);
      userOutput(h.api, "demo:output").show(ctx, "hello");
      expect(ctx.ui.notify).not.toHaveBeenCalled();
      expect(h.pi.sendMessage).toHaveBeenCalledWith(
        {
          customType: "demo:output",
          content: "hello",
          display: true,
          details: { userOutput: true, level: "info" },
        },
        { triggerTurn: false },
      );
    },
  );

  it("leads a warning or an error with its level and strips terminal controls", () => {
    const h = fakePi();
    const output = userOutput(h.api, "demo:output");
    output.show(context("rpc"), "careful\u001b[2Jnow", "warning");
    output.show(context("rpc"), "broken\r\nline", "error");
    expect(h.shown().map(({ content, level }) => [content, level])).toEqual([
      ["Warning: carefulnow", "warning"],
      ["Error: broken\nline", "error"],
    ]);
  });

  it("falls back to the host's notification when the message cannot be sent", () => {
    const h = fakePi({
      sendMessage: vi.fn(() => {
        throw new Error("session closed");
      }),
    });
    const ctx = context("rpc");
    userOutput(h.api, "demo:output").show(ctx, "hello");
    expect(ctx.ui.notify).toHaveBeenCalledWith("hello", "info");
    const headless = context("json", false);
    userOutput(h.api, "demo:output").show(headless, "hello");
    expect(headless.ui.notify).not.toHaveBeenCalled();
  });

  it("keeps its messages out of the model's context, once per pi however many outputs", async () => {
    const h = fakePi();
    userOutput(h.api, "a:output");
    userOutput(h.api, "b:output");
    expect(h.handlers.get("context")).toHaveLength(1);
    userOutput(h.api, "a:output").show(context("rpc"), "listing");
    const [[sent]] = h.pi.sendMessage.mock.calls as [[Record<string, unknown>]];
    const user = { role: "user", content: "hi" };
    const card = { role: "custom", customType: "todo:context", content: "x", display: false };
    const shown = { role: "custom", ...sent };
    expect(await h.emit("context", { messages: [user, shown, card] })).toEqual({
      messages: [user, card],
    });
    // Nothing to drop: the handler leaves the list (and Pi's cached prefix) alone.
    expect(await h.emit("context", { messages: [user, card] })).toBeUndefined();
  });
});

describe("isTerminal", () => {
  it("is true only for the terminal UI with a UI", () => {
    expect(isTerminal({ mode: "tui", hasUI: true })).toBe(true);
    expect(isTerminal({ mode: "tui", hasUI: false })).toBe(false);
    expect(isTerminal({ mode: "rpc", hasUI: true })).toBe(false);
  });
});

describe("capOutput", () => {
  it("returns text within both limits unchanged", () => {
    expect(capOutput("a\nb")).toBe("a\nb");
    expect(capOutput("x".repeat(MAX_OUTPUT_CHARS))).toHaveLength(MAX_OUTPUT_CHARS);
  });

  it("keeps the first lines and counts the rest", () => {
    const lines = Array.from({ length: MAX_OUTPUT_LINES + 3 }, (_, index) => `row ${index}`);
    const capped = capOutput(lines.join("\n")).split("\n");
    expect(capped).toHaveLength(MAX_OUTPUT_LINES + 1);
    expect(capped.at(-2)).toBe(`row ${MAX_OUTPUT_LINES - 1}`);
    expect(capped.at(-1)).toBe("… 3 more lines");
  });

  it("cuts long text at a line end, and a single huge line at the limit", () => {
    const rows = Array.from({ length: 40 }, () => "y".repeat(499)).join("\n");
    const capped = capOutput(rows);
    const kept = capped.split("\n");
    expect(kept.slice(0, -1)).toEqual(Array(24).fill("y".repeat(499)));
    expect(kept.at(-1)).toBe("… 16 more lines");
    const huge = capOutput("z".repeat(MAX_OUTPUT_CHARS * 2));
    expect(huge).toBe(`${"z".repeat(MAX_OUTPUT_CHARS)}\n… output truncated`);
  });
});
