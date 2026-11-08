import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { defer } from "#src/cleanup.ts";
import { settingsDirs, tempDir, writeFiles } from "#src/temp.ts";

describe("defer", () => {
  it("calls a function target or a node:test context's after", () => {
    const fn = vi.fn();
    const after = vi.fn();
    const cleanup = () => {};
    defer(fn, cleanup);
    defer({ after }, cleanup);
    expect(fn).toHaveBeenCalledWith(cleanup);
    expect(after).toHaveBeenCalledWith(cleanup);
  });
});

describe("tempDir", () => {
  it("creates a directory and removes it when the cleanup runs", () => {
    const cleanups: Array<() => void | Promise<void>> = [];
    const dir = tempDir((fn) => void cleanups.push(fn), "pth-");
    expect(existsSync(dir)).toBe(true);
    expect(dir).toContain("pth-");
    for (const fn of cleanups) void fn();
    expect(existsSync(dir)).toBe(false);
  });

  it("writes nested files, objects as JSON", () => {
    const dir = tempDir(onTestFinished);
    writeFiles(dir, { "a/b.txt": "text", "c.json": { ok: true } });
    expect(readFileSync(join(dir, "a/b.txt"), "utf8")).toBe("text");
    expect(JSON.parse(readFileSync(join(dir, "c.json"), "utf8"))).toEqual({ ok: true });
  });
});

describe("settingsDirs", () => {
  it("lays out an agent directory and a project, writing either scope", () => {
    const dirs = settingsDirs(onTestFinished, "x.json");
    expect(existsSync(join(dirs.cwd, ".pi"))).toBe(false);
    dirs.writeGlobal({ a: 1 });
    dirs.writeProject("{bad");
    expect(readFileSync(join(dirs.agentDir, "x.json"), "utf8")).toBe('{"a":1}');
    expect(readFileSync(join(dirs.cwd, ".pi", "x.json"), "utf8")).toBe("{bad");
    expect(dirs.globalFile.startsWith(dirs.root)).toBe(true);
  });
});
