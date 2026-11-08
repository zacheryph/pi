import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { tempDir } from "../../../packages/pi-test-helpers/src/temp.ts";
import { DEFAULT_CONFIG, loadStashConfig } from "../src/config.ts";
let root: string;
beforeEach(() => {
  root = tempDir(onTestFinished, "stash-config-");
});
afterEach(() => {
  vi.restoreAllMocks();
});
it("loads global limits and ignores project settings", () => {
  writeFileSync(join(root, "stash.json"), JSON.stringify({ retentionDays: 45, maxEntryBytes: -1 }));
  mkdirSync(join(root, ".pi"));
  writeFileSync(join(root, ".pi/stash.json"), JSON.stringify({ retentionDays: 1 }));
  expect(loadStashConfig(root)).toEqual({ ...DEFAULT_CONFIG, retentionDays: 45 });
});
it("is silent for missing files and warns then defaults for malformed files", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(loadStashConfig(root)).toEqual(DEFAULT_CONFIG);
  expect(warn).not.toHaveBeenCalled();
  writeFileSync(join(root, "stash.json"), "{bad");
  expect(loadStashConfig(root)).toEqual(DEFAULT_CONFIG);
  expect(warn).toHaveBeenCalledOnce();
});
