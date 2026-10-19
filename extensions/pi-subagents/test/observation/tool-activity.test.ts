import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { toolActivity } from "#src/observation/tool-activity";

describe("toolActivity", () => {
  it("prefers a tool's explicit activity label over its output", () => {
    expect(toolActivity("ci_watch", {
      content: [{ type: "text", text: "verbose progress output" }],
      details: { activity: { kind: "waiting", label: "Awaiting PR merge" } },
    })).toBe("Awaiting PR merge");
  });

  it.each([undefined, null, "wrong shape", { activity: null }, { activity: { label: 42 } }, { activity: { label: " \n " } }])(
    "falls back to text with absent or invalid activity metadata: %j",
    details => {
      expect(toolActivity("ci_watch", {
        content: [{ type: "text", text: "[2/5] deploy — in_progress (120s)" }],
        details,
      })).toBe("ci_watch: [2/5] deploy — in_progress (120s)");
    },
  );

  it("uses the latest non-empty line across cumulative output and text blocks", () => {
    expect(toolActivity("ci_watch", {
      content: [
        { type: "text", text: "old output" },
        { type: "text", text: "first\nsecond\rthird\r\n\n" },
        { type: "text", text: "  " },
        { type: "image", mimeType: "image/png", data: "" },
      ],
      details: undefined,
    })).toBe("ci_watch: third");
  });

  it("prefixes built-in bash's streamed stdout/stderr fallback without requiring activity metadata", () => {
    expect(toolActivity("bash", {
      content: [{ type: "text", text: "old output\n\x1b[32mRunning migration 12/40\x1b[0m\n" }],
      details: { truncation: undefined, fullOutputPath: undefined },
    })).toBe("bash: Running migration 12/40");
  });

  it("leaves empty and non-text updates without a new label", () => {
    expect(toolActivity("ci_watch", { content: [], details: undefined })).toBeUndefined();
    expect(toolActivity("ci_watch", {
      content: [{ type: "image", mimeType: "image/png", data: "" }],
      details: { activity: {} },
    })).toBeUndefined();
  });

  it("strips terminal sequences and controls, normalizes whitespace, and bounds retained labels", () => {
    const label = toolActivity("ci_watch", {
      content: [],
      details: { activity: { label: "\x1b[31mAwaiting\x1b[0m\n\tCI\x07 " + "界🧪".repeat(200) } },
    })!;
    expect(label).toMatch(/^Awaiting CI 界🧪/);
    expect(label).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(label.endsWith("…")).toBe(true);
    expect(visibleWidth(label)).toBeLessThanOrEqual(240);
  });
});
