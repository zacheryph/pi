import { chmodSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tempDir, writeFiles } from "#test-helpers";

vi.mock("@anthropic-ai/sandbox-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("@anthropic-ai/sandbox-runtime")>();
  return {
    ...original,
    SandboxManager: {
      initialize: vi.fn(),
      reset: vi.fn(),
      checkDependenciesAsync: vi.fn(),
      wrapWithSandbox: vi.fn(),
    },
  };
});
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
vi.mock("#src/lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/lifecycle")>()),
  checkProcessTable: vi.fn(),
}));
import { launch } from "#src/launch";

const originalTmp = process.env.TMPDIR;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(SandboxManager.checkDependenciesAsync).mockResolvedValue({ errors: [], warnings: [] });
});
afterEach(() => {
  process.env.TMPDIR = originalTmp;
});

function policy(cleanup: (fn: () => void) => void) {
  const root = realpathSync(tempDir(cleanup));
  writeFiles(root, {
    "host/policy.yaml": {
      version: 1,
      sandbox: {
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      },
    },
  });
  const path = join(root, "host/policy.yaml");
  chmodSync(path, 0o600);
  return path;
}
it("resets partial initialization and removes private files before reporting failure", async ({
  onTestFinished,
}) => {
  const path = policy(onTestFinished);
  let privateDir = "";
  vi.mocked(SandboxManager.initialize).mockImplementation(async (config) => {
    privateDir = config.filesystem.allowWrite[0] as string;
    expect(existsSync(privateDir)).toBe(true);
    throw new Error("partial setup");
  });
  await expect(launch([], path, new AbortController().signal)).rejects.toThrow("partial setup");
  expect(SandboxManager.reset).toHaveBeenCalledTimes(1);
  expect(SandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
  expect(existsSync(privateDir)).toBe(false);
});
it("does not initialize or spawn when prerequisites are missing", async ({ onTestFinished }) => {
  vi.mocked(SandboxManager.checkDependenciesAsync).mockResolvedValue({
    errors: ["bubblewrap missing"],
    warnings: [],
  });
  await expect(launch([], policy(onTestFinished), new AbortController().signal)).rejects.toThrow(
    "bubblewrap missing",
  );
  expect(SandboxManager.initialize).not.toHaveBeenCalled();
  expect(SandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
});
it("cancels during setup without launching Pi", async ({ onTestFinished }) => {
  const abort = new AbortController();
  vi.mocked(SandboxManager.initialize).mockImplementation(async () => {
    abort.abort("SIGTERM");
  });
  await expect(launch([], policy(onTestFinished), abort.signal)).rejects.toBe("SIGTERM");
  expect(SandboxManager.wrapWithSandbox).not.toHaveBeenCalled();
  expect(SandboxManager.reset).toHaveBeenCalledOnce();
});
