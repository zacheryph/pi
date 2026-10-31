import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cmuxAdapter, detectTerminal, runCommand } from "#src/terminal";
import { tempDir } from "#test/helpers";

describe("cmux adapter", () => {
  it("is absent outside cmux", () => {
    expect(cmuxAdapter({ env: {} })).toBeUndefined();
    expect(detectTerminal({ env: { TERM: "xterm" } })).toBeUndefined();
  });

  it("focuses the panel with the bundled CLI, then raises the app on macOS", async () => {
    const run = vi.fn(async () => {});
    const adapter = cmuxAdapter({
      env: {
        CMUX_PANEL_ID: "CD96",
        CMUX_BUNDLED_CLI_PATH: "/Applications/cmux.app/bin/cmux",
        CMUX_BUNDLE_ID: "com.cmuxterm.app",
      },
      platform: "darwin",
      run,
    })!;
    expect(adapter.info).toEqual({ kind: "cmux", label: "cmux" });
    await adapter.focus();
    expect(run.mock.calls).toEqual([
      ["/Applications/cmux.app/bin/cmux", ["focus-panel", "--panel", "CD96"]],
      ["open", ["-b", "com.cmuxterm.app"]],
    ]);
  });

  it("falls back to the surface id and the cmux on PATH, and skips app activation off macOS", async () => {
    const run = vi.fn(async () => {});
    await cmuxAdapter({ env: { CMUX_SURFACE_ID: "S1" }, platform: "linux", run })!.focus();
    expect(run.mock.calls).toEqual([["cmux", ["focus-panel", "--panel", "S1"]]]);
  });

  it("stops at a failing focus-panel", async () => {
    const run = vi.fn(async () => {
      throw new Error("cmux focus-panel: panel not found");
    });
    await expect(
      cmuxAdapter({ env: { CMUX_PANEL_ID: "gone" }, platform: "darwin", run })!.focus(),
    ).rejects.toThrow("panel not found");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("runCommand", () => {
  it("runs a real command and reports its first stderr line on failure", async () => {
    const dir = tempDir();
    const script = join(dir, "fake-cmux");
    writeFileSync(
      script,
      `#!/bin/sh\necho "$@" > "${dir}/args"\n[ "$2" = "--panel" ] || { echo "bad args" >&2; exit 1; }\n`,
    );
    chmodSync(script, 0o755);
    await runCommand(script, ["focus-panel", "--panel", "P1"]);
    expect(readFileSync(join(dir, "args"), "utf8").trim()).toBe("focus-panel --panel P1");
    await expect(runCommand(script, ["focus-panel"])).rejects.toThrow(
      /fake-cmux focus-panel: bad args/,
    );
  });
});
