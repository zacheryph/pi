import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { settingsDirs } from "../../../packages/pi-test-helpers/src/temp.ts";
import { gitSettings } from "../src/config.ts";

afterEach(() => vi.restoreAllMocks());
const setup = () => settingsDirs(onTestFinished, "git.json", "pi-git-config-");

it("defaults the worktree root under the agent directory and tracks referenced PRs", () => {
  const dirs = setup();
  expect(gitSettings.load(dirs.cwd, dirs.agentDir)).toEqual({
    worktreeRoot: join(dirs.agentDir, "worktrees"),
    trackReferenced: true,
  });
});

it("expands ~/, resolves relative roots against cwd and lets the project override", () => {
  const dirs = setup();
  dirs.writeGlobal({ worktreeRoot: " ~/trees ", trackReferenced: false });
  expect(gitSettings.load(dirs.cwd, dirs.agentDir)).toEqual({
    worktreeRoot: join(homedir(), "trees"),
    trackReferenced: false,
  });
  dirs.writeProject({ worktreeRoot: "../trees" });
  expect(gitSettings.load(dirs.cwd, dirs.agentDir).worktreeRoot).toBe(join(dirs.root, "trees"));
});

it("warns about an invalid root and keeps the lower layer", () => {
  const dirs = setup();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  dirs.writeProject({ worktreeRoot: "  ", trackReferenced: "no" });
  expect(gitSettings.load(dirs.cwd, dirs.agentDir)).toEqual({
    worktreeRoot: join(dirs.agentDir, "worktrees"),
    trackReferenced: true,
  });
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/^\[pi-git\] .*worktreeRoot must .*; trackReferenced must /),
  );
});
