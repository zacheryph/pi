import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { resolveSpawnCwd } from "#src/lifecycle/spawn-cwd";
import { tempDir } from "#test-helpers";

describe("resolveSpawnCwd", () => {
  let base: string;

  beforeEach(() => {
    base = tempDir(onTestFinished, "spawn-cwd-");
    mkdirSync(join(base, "worktree"));
    writeFileSync(join(base, "file.txt"), "not a directory");
  });

  it("yields no override when absent", () => {
    expect(resolveSpawnCwd(undefined, base)).toEqual({});
    expect(resolveSpawnCwd(null, base)).toEqual({});
  });

  it("resolves a relative path against the base directory", () => {
    expect(resolveSpawnCwd("worktree", base)).toEqual({ cwd: join(base, "worktree") });
  });

  it("keeps an absolute path", () => {
    expect(resolveSpawnCwd(join(base, "worktree"), "/elsewhere")).toEqual({
      cwd: join(base, "worktree"),
    });
  });

  it("rejects a missing directory, naming the resolved path", () => {
    expect(resolveSpawnCwd("missing", base)).toEqual({
      error: `cwd ${join(base, "missing")} is not an existing directory`,
    });
  });

  it("rejects a file", () => {
    expect(resolveSpawnCwd("file.txt", base)).toEqual({
      error: `cwd ${join(base, "file.txt")} is not an existing directory`,
    });
  });

  it("rejects an empty string or a non-string", () => {
    for (const value of ["", "  ", 42, {}]) {
      expect(resolveSpawnCwd(value, base)).toHaveProperty("error");
    }
  });
});
