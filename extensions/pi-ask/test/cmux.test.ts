import type { ExecFileOptionsWithStringEncoding } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CmuxNotifications } from "#src/cmux";
import { flushMicrotasks as flush } from "#test-helpers";

type Callback = (error: Error | null, stdout: string, stderr: string) => void;
const { execFile } = vi.hoisted(() => ({
  execFile:
    vi.fn<
      (
        cli: string,
        args: string[],
        options: ExecFileOptionsWithStringEncoding,
        cb: Callback,
      ) => void
    >(),
}));
vi.mock("node:child_process", () => ({ execFile }));

const ID = "59A9DCD2-BB99-4BD2-8FC7-943073019662";
const ID2 = "69A9DCD2-BB99-4BD2-8FC7-943073019662";
const receipt = (id = ID) =>
  JSON.stringify({ id, surface_id: "surface", workspace_id: "workspace" });
const reply = (index: number, stdout = "", error: Error | null = null) =>
  execFile.mock.calls[index]![3](error, stdout, "");

beforeEach(() => {
  execFile.mockReset();
  for (const key of [
    "CMUX_SURFACE_ID",
    "CMUX_PANEL_ID",
    "CMUX_WORKSPACE_ID",
    "CMUX_TAB_ID",
    "CMUX_BUNDLED_CLI_PATH",
    "CMUX_PI_HOOKS_DISABLED",
  ])
    vi.stubEnv(key, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("optional cmux notifications", () => {
  it("does nothing outside cmux, even with a workspace or installed CLI", async () => {
    vi.stubEnv("CMUX_WORKSPACE_ID", "workspace");
    vi.stubEnv("CMUX_BUNDLED_CLI_PATH", "/installed/cmux");
    const notifications = new CmuxNotifications();
    notifications.open()();
    await notifications.shutdown();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("honors the cmux Pi hooks opt-out", async () => {
    vi.stubEnv("CMUX_SURFACE_ID", "surface");
    vi.stubEnv("CMUX_PI_HOOKS_DISABLED", "1");
    const notifications = new CmuxNotifications();
    notifications.open()();
    await notifications.shutdown();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("uses the bundled CLI, modern targets, generic text and inherited socket capability", async () => {
    vi.stubEnv("CMUX_BUNDLED_CLI_PATH", "/path with spaces/cmux");
    vi.stubEnv("CMUX_SURFACE_ID", "surface");
    vi.stubEnv("CMUX_PANEL_ID", "old-surface");
    vi.stubEnv("CMUX_WORKSPACE_ID", "workspace");
    vi.stubEnv("CMUX_TAB_ID", "old-workspace");
    vi.stubEnv("CMUX_SOCKET_CAPABILITY", "capability");
    vi.stubEnv("CMUX_SOCKET_PATH", "/socket/path");
    const notifications = new CmuxNotifications();
    const close = notifications.open();
    expect(execFile.mock.calls[0]!.slice(0, 3)).toEqual([
      "/path with spaces/cmux",
      [
        "notify",
        "--json",
        "--id-format",
        "uuids",
        "--title",
        "Pi needs your input",
        "--body",
        "Answer the questions in your terminal.",
        "--surface",
        "surface",
        "--workspace",
        "workspace",
      ],
      {
        env: { ...process.env },
        encoding: "utf8",
        timeout: 1500,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024,
      },
    ]);
    reply(0, receipt());
    await flush();
    close();
    close();
    expect(execFile.mock.calls[1]!.slice(0, 3)).toEqual([
      "/path with spaces/cmux",
      ["dismiss-notification", "--id", ID],
      execFile.mock.calls[0]![2],
    ]);
    reply(1, "OK");
    await notifications.shutdown();
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("falls back to PATH, legacy panel/tab and leaves workspace optional", async () => {
    vi.stubEnv("CMUX_PANEL_ID", "panel");
    vi.stubEnv("CMUX_TAB_ID", "tab");
    const notifications = new CmuxNotifications();
    notifications.open();
    expect(execFile.mock.calls[0]![0]).toBe("cmux");
    expect(execFile.mock.calls[0]![1].slice(-4)).toEqual([
      "--surface",
      "panel",
      "--workspace",
      "tab",
    ]);
    reply(0, "{}");
    vi.stubEnv("CMUX_TAB_ID", undefined);
    notifications.open();
    expect(execFile.mock.calls[1]![1].slice(-2)).toEqual(["--surface", "panel"]);
    expect(execFile.mock.calls[1]![1]).not.toContain("--workspace");
    reply(1, "{}");
    await notifications.shutdown();
  });

  it("cleans a delayed receipt after close without waiting or cancelling create", async () => {
    vi.stubEnv("CMUX_SURFACE_ID", "surface");
    const notifications = new CmuxNotifications();
    const close = notifications.open();
    close();
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]![2]).not.toHaveProperty("signal");
    reply(0, receipt());
    await flush();
    expect(execFile.mock.calls[1]![1]).toEqual(["dismiss-notification", "--id", ID]);
    reply(1, "OK");
    await notifications.shutdown();
    close();
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("owns each receipt independently and never clears unrelated notices", async () => {
    vi.stubEnv("CMUX_SURFACE_ID", "surface");
    const notifications = new CmuxNotifications();
    const close1 = notifications.open();
    const close2 = notifications.open();
    reply(1, receipt(ID2));
    reply(0, receipt());
    await flush();
    close1();
    expect(execFile.mock.calls[2]![1]).toEqual(["dismiss-notification", "--id", ID]);
    reply(2);
    close2();
    expect(execFile.mock.calls[3]![1]).toEqual(["dismiss-notification", "--id", ID2]);
    reply(3);
    await notifications.shutdown();
    expect(execFile).toHaveBeenCalledTimes(4);
  });

  it.each([
    "",
    "not json",
    `OK ${ID}`,
    "{}",
    "null",
    "[]",
    '{"id":42}',
    '{"id":"notification:wrong"}',
    JSON.stringify({ result: { id: ID } }),
    JSON.stringify({ id: `${ID} trailing` }),
  ])(
    "ignores malformed/unrecognized receipt %s without guessing a cleanup target",
    async (output) => {
      vi.stubEnv("CMUX_SURFACE_ID", "surface");
      const notifications = new CmuxNotifications();
      const close = notifications.open();
      reply(0, output);
      await flush();
      close();
      await notifications.shutdown();
      expect(execFile).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["ENOENT", "socket denied", "timeout", "maxBuffer exceeded"])(
    "silently ignores creation failure: %s, even with a receipt on stdout",
    async (message) => {
      vi.stubEnv("CMUX_SURFACE_ID", "surface");
      const notifications = new CmuxNotifications();
      const close = notifications.open();
      reply(0, receipt(), new Error(message));
      await flush();
      close();
      await notifications.shutdown();
      expect(execFile).toHaveBeenCalledTimes(1);
    },
  );

  it("contains synchronous spawn errors and cleanup failures", async () => {
    vi.stubEnv("CMUX_SURFACE_ID", "surface");
    const notifications = new CmuxNotifications();
    execFile.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });
    notifications.open()();
    const close = notifications.open();
    reply(1, receipt());
    await flush();
    close();
    reply(2, "", new Error("dismiss failed"));
    await notifications.shutdown();
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  it("drains pending creation and its exact cleanup on shutdown/reload", async () => {
    vi.stubEnv("CMUX_SURFACE_ID", "surface");
    const notifications = new CmuxNotifications();
    notifications.open();
    let stopped = false;
    const shutdown = notifications.shutdown().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    reply(0, receipt());
    await flush();
    expect(execFile.mock.calls[1]![1]).toEqual(["dismiss-notification", "--id", ID]);
    expect(stopped).toBe(false);
    reply(1, "OK");
    await shutdown;
    notifications.open()();
    await notifications.shutdown();
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("closes already-created active notices on shutdown", async () => {
    vi.stubEnv("CMUX_SURFACE_ID", "surface");
    const notifications = new CmuxNotifications();
    notifications.open();
    reply(0, receipt());
    await flush();
    const shutdown = notifications.shutdown();
    expect(execFile.mock.calls[1]![1]).toEqual(["dismiss-notification", "--id", ID]);
    reply(1, "OK");
    await shutdown;
  });

  it.each(["hang", "oversized output"])("bounds a real CLI with %s", async (mode) => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    execFile.mockImplementation((cli, args, options, callback) => {
      actual.execFile(cli, args, options, callback);
    });
    const dir = await mkdtemp(join(tmpdir(), "pi-ask-cmux-"));
    try {
      const cli = join(dir, "cmux");
      await writeFile(
        cli,
        `#!${process.execPath}\n` +
          (mode === "hang"
            ? "setInterval(() => {}, 1000);"
            : 'process.stdout.write("x".repeat(32768));'),
        { mode: 0o700 },
      );
      vi.stubEnv("CMUX_BUNDLED_CLI_PATH", cli);
      vi.stubEnv("CMUX_SURFACE_ID", "surface");
      const notifications = new CmuxNotifications();
      const close = notifications.open();
      close();
      await notifications.shutdown();
      expect(execFile).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("bounds shutdown even if a process callback never arrives", async () => {
    vi.useFakeTimers();
    vi.stubEnv("CMUX_SURFACE_ID", "surface");
    const notifications = new CmuxNotifications();
    notifications.open();
    const shutdown = notifications.shutdown();
    await vi.advanceTimersByTimeAsync(3100);
    await shutdown;
    // The late receipt still gets exact cleanup, even beyond the drain deadline.
    reply(0, receipt());
    await flush();
    expect(execFile.mock.calls[1]![1]).toEqual(["dismiss-notification", "--id", ID]);
    reply(1, "OK");
  });
});
