import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { tempDir } from "../../pi-test-helpers/src/temp.ts";
import {
  loadLayeredSettings,
  patchSettingsFile,
  readSettingsFile,
  writeSettingsFile,
} from "../src/settings.ts";

let root: string;
beforeEach(() => {
  root = tempDir(onTestFinished, "pi-foundations-");
});
afterEach(() => vi.restoreAllMocks());
const sanitize = (raw: unknown): { count?: number } => {
  const count = (raw as { count?: unknown } | null)?.count;
  return typeof count === "number" ? { count } : {};
};

describe("settings files", () => {
  it("treats missing files as absent without swallowing validation failures", () => {
    const file = join(root, "settings.json");
    expect(readSettingsFile(file, sanitize)).toEqual({});
    writeFileSync(file, "{}");
    const error = new Error("invalid settings");
    expect(() =>
      readSettingsFile(file, () => {
        throw error;
      }),
    ).toThrow(error);
  });

  it("lets callers choose strict, warned or silent fallback on read/parse failures", () => {
    const file = join(root, "settings.json");
    writeFileSync(file, "{bad");
    expect(() => readSettingsFile(file, sanitize)).toThrow(SyntaxError);
    const report = vi.fn();
    expect(readSettingsFile(file, sanitize, report)).toEqual({});
    expect(report).toHaveBeenCalledWith(expect.any(SyntaxError));
    expect(readSettingsFile(root, sanitize, report)).toEqual({});
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("shallow-merges project settings over global settings and reports a bad layer", () => {
    const agentDir = join(root, "agent"),
      cwd = join(root, "project");
    const global = join(agentDir, "settings.json"),
      project = join(cwd, ".pi/settings.json");
    writeSettingsFile(global, { count: 2 });
    writeSettingsFile(project, { count: 3 });
    const options = { agentDir, cwd, filename: "settings.json", sanitize, warnLabel: "test" };
    expect(loadLayeredSettings(options)).toEqual({ count: 3 });
    writeFileSync(project, "{bad");
    const onError = vi.fn();
    expect(loadLayeredSettings({ ...options, onError })).toEqual({ count: 2 });
    expect(onError).toHaveBeenCalledWith(project, expect.any(SyntaxError));
  });

  it("preserves unknown settings on sparse patches and writes only the supplied file", () => {
    const file = join(root, "project/.pi/settings.json");
    writeSettingsFile(file, { count: 2, metadata: { keep: true } });
    patchSettingsFile(file, { count: 4 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ count: 4, metadata: { keep: true } });
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  it.each(["{bad", "null", "[]", "false"])("refuses to overwrite malformed settings %s", (raw) => {
    const file = join(root, "settings.json");
    writeFileSync(file, raw);
    expect(() => patchSettingsFile(file, { count: 2 })).toThrow();
    expect(readFileSync(file, "utf8")).toBe(raw);
  });

  it("propagates write failures for the caller to report", () => {
    const file = join(root, "directory");
    mkdirSync(file);
    expect(() => writeSettingsFile(file, {})).toThrow();
  });
});
