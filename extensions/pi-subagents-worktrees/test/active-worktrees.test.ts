import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActiveWorktrees } from "#src/active-worktrees";

describe("ActiveWorktrees", () => {
  it("matches a path added in unresolved form against its resolved form", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-agent-live-"));
    try {
      const active = new ActiveWorktrees();
      active.add(dir);

      // git reports resolved paths (/private/var/... on macOS), so that is the
      // form the scan asks about.
      expect(active.contains(realpathSync(dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not contain a path that was never added", () => {
    const active = new ActiveWorktrees();
    expect(active.contains(realpathSync(tmpdir()))).toBe(false);
  });

  it("forgets a path after its directory is gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-agent-live-"));
    const resolved = realpathSync(dir);
    const active = new ActiveWorktrees();
    active.add(dir);
    rmSync(dir, { recursive: true, force: true });

    active.remove(dir);

    expect(active.contains(resolved)).toBe(false);
  });

  it("falls back to the given path when it cannot be resolved", () => {
    const missing = join(tmpdir(), "pi-agent-never-created");
    const active = new ActiveWorktrees();
    active.add(missing);

    expect(active.contains(missing)).toBe(true);
  });
});
