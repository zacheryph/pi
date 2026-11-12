import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { tempDir } from "#test-helpers";
import { stashSettings } from "#src/config";
let root: string;
const DEFAULTS = {
  retentionDays: 30,
  maxEntryBytes: 20 * 1024 * 1024,
  maxStoreBytes: 1024 * 1024 * 1024,
};
const load = () => stashSettings.load(root, root);
beforeEach(() => {
  root = tempDir(onTestFinished, "stash-config-");
});
afterEach(() => {
  vi.restoreAllMocks();
});
it("loads global limits, warns about invalid ones and ignores project settings", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  writeFileSync(join(root, "stash.json"), JSON.stringify({ retentionDays: 45, maxEntryBytes: -1 }));
  mkdirSync(join(root, ".pi"));
  writeFileSync(join(root, ".pi/stash.json"), JSON.stringify({ retentionDays: 1 }));
  expect(load()).toEqual({ ...DEFAULTS, retentionDays: 45 });
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("maxEntryBytes must be"));
});
it("is silent for missing files and warns then defaults for malformed files", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(load()).toEqual(DEFAULTS);
  expect(stashSettings.defaults()).toEqual(DEFAULTS);
  expect(warn).not.toHaveBeenCalled();
  writeFileSync(join(root, "stash.json"), "{bad");
  expect(load()).toEqual(DEFAULTS);
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/^\[pi-stash\] Ignoring settings at .*stash\.json: /),
  );
});
