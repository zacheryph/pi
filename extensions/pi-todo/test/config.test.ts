import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_FILE, DEFAULT_CONFIG, loadTodoConfig, sanitizeConfig, saveTodoConfig } from "../src/config.ts";

const dirs: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "pi-todo-config-"));
  dirs.push(root);
  const cwd = join(root, "project"), agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir);
  return { cwd, agentDir, global: join(agentDir, CONFIG_FILE), project: join(cwd, ".pi", CONFIG_FILE) };
}
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), "utf8");
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("config validation", () => {
  it("accepts only known, correctly typed options", () => {
    expect(sanitizeConfig({ widget: false, maxVisible: 12, showCompleted: false, singleActive: true, confirmClear: false, contextSync: "off", extra: true })).toEqual({
      widget: false, maxVisible: 12, showCompleted: false, singleActive: true, confirmClear: false, contextSync: "off",
    });
    expect(sanitizeConfig({ widget: "false", showCompleted: 0, singleActive: null, confirmClear: [], maxVisible: "5", contextSync: "always" })).toEqual({});
  });

  it.each([null, undefined, false, 3, "text", [], [DEFAULT_CONFIG]])("ignores non-object input %j", raw => {
    expect(sanitizeConfig(raw)).toEqual({});
  });

  it.each([0, -1, 13, 1.5, NaN, Infinity, "3", null])("rejects invalid maxVisible %j without dropping valid siblings", maxVisible => {
    expect(sanitizeConfig({ maxVisible, widget: false })).toEqual({ widget: false });
  });

  it.each([1, 5, 12])("accepts boundary/in-range maxVisible %i", maxVisible => {
    expect(sanitizeConfig({ maxVisible })).toEqual({ maxVisible });
  });
});

describe("config loading", () => {
  it("uses defaults when absent and returns independent configs", () => {
    const env = setup();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = loadTodoConfig(env.cwd, env.agentDir);
    expect(first).toEqual(DEFAULT_CONFIG);
    expect(first).not.toBe(DEFAULT_CONFIG);
    first.widget = false;
    expect(loadTodoConfig(env.cwd, env.agentDir)).toEqual(DEFAULT_CONFIG);
    expect(warning).not.toHaveBeenCalled();
  });

  it("layers defaults, global settings, and sparse project overrides", () => {
    const env = setup();
    json(env.global, { widget: false, maxVisible: 8, singleActive: true, contextSync: "off", confirmClear: false });
    json(env.project, { widget: true, maxVisible: 2, contextSync: "invalid", showCompleted: "false", unrelated: 1 });
    expect(loadTodoConfig(env.cwd, env.agentDir)).toEqual({
      ...DEFAULT_CONFIG, widget: true, maxVisible: 2, singleActive: true, contextSync: "off", confirmClear: false,
    });
  });

  it.each(["{broken", "null", "[]", '"text"', '{"widget":"false","maxVisible":99}'])("falls back on invalid project input %s", source => {
    const env = setup();
    json(env.global, { maxVisible: 9, widget: false });
    writeFileSync(env.project, source);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadTodoConfig(env.cwd, env.agentDir)).toEqual({ ...DEFAULT_CONFIG, maxVisible: 9, widget: false });
  });

  it("sanitizes terminal controls in malformed-file warnings", () => {
    const env = setup();
    writeFileSync(env.project, "\u001b]52;c;clipboard\u0007broken");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadTodoConfig(env.cwd, env.agentDir);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0][0]).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });

  it("warns for malformed layers but still applies remaining valid layer", () => {
    const env = setup();
    writeFileSync(env.global, "{bad");
    json(env.project, { widget: false });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadTodoConfig(env.cwd, env.agentDir)).toEqual({ ...DEFAULT_CONFIG, widget: false });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(`Ignoring settings at ${env.global}`));
    expect(warning).toHaveBeenCalledTimes(1);
  });
});

describe("project sparse patches", () => {
  it("creates .pi directory and writes only supplied valid project overrides", () => {
    const env = setup();
    rmSync(join(env.cwd, ".pi"), { recursive: true });
    json(env.global, { maxVisible: 8, singleActive: true });
    const patch = { widget: false };
    saveTodoConfig(env.cwd, patch);
    expect(JSON.parse(readFileSync(env.project, "utf8"))).toEqual(patch);
    expect(readFileSync(env.project, "utf8").endsWith("\n")).toBe(true);
    expect(loadTodoConfig(env.cwd, env.agentDir)).toEqual({ ...DEFAULT_CONFIG, widget: false, maxVisible: 8, singleActive: true });
    json(env.global, { maxVisible: 10, singleActive: false });
    expect(loadTodoConfig(env.cwd, env.agentDir).maxVisible).toBe(10);
    expect(patch).toEqual({ widget: false });
  });

  it("preserves unknown/project keys, replaces only valid supplied fields, leaves global untouched", () => {
    const env = setup();
    json(env.global, { widget: true, maxVisible: 8 });
    const globalBefore = readFileSync(env.global, "utf8");
    json(env.project, { showCompleted: false, maxVisible: 3, metadata: { note: "keep" } });
    saveTodoConfig(env.cwd, { widget: false, maxVisible: 0, contextSync: "off" });
    expect(JSON.parse(readFileSync(env.project, "utf8"))).toEqual({
      showCompleted: false, maxVisible: 3, metadata: { note: "keep" }, widget: false, contextSync: "off",
    });
    expect(readFileSync(env.global, "utf8")).toBe(globalBefore);
  });

  it.each(["{broken", "null", "[]", "false", '"text"'])("refuses to overwrite malformed project settings %s", source => {
    const env = setup();
    writeFileSync(env.project, source);
    expect(() => saveTodoConfig(env.cwd, { widget: false })).toThrow();
    expect(readFileSync(env.project, "utf8")).toBe(source);
  });
});
