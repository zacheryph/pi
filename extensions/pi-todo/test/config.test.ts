import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { todoSettings } from "#src/config";
import { settingsDirs } from "#test-helpers";

const DEFAULTS = {
  widget: true,
  maxVisible: 5,
  showCompleted: true,
  singleActive: false,
  confirmClear: true,
  contextSync: "changes",
  childPrerequisites: true,
};

function setup() {
  const dirs = settingsDirs(onTestFinished, "todo.json", "pi-todo-config-");
  mkdirSync(join(dirs.cwd, ".pi"));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  return {
    ...dirs,
    global: dirs.globalFile,
    project: dirs.projectFile,
    warning,
    load: () => todoSettings.load(dirs.cwd, dirs.agentDir),
  };
}
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), "utf8");
afterEach(() => {
  vi.restoreAllMocks();
});

describe("config validation", () => {
  it("accepts only known, correctly typed options", () => {
    const env = setup();
    const valid = {
      widget: false,
      maxVisible: 12,
      showCompleted: false,
      singleActive: true,
      confirmClear: false,
      contextSync: "off",
      childPrerequisites: false,
    };
    json(env.project, valid);
    expect(env.load()).toEqual(valid);
    expect(env.warning).not.toHaveBeenCalled();
    json(env.project, {
      widget: "false",
      showCompleted: 0,
      singleActive: null,
      confirmClear: [],
      maxVisible: "5",
      contextSync: "always",
      childPrerequisites: "no",
    });
    expect(env.load()).toEqual(DEFAULTS);
    expect(env.warning).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 13, 1.5, "3", null])(
    "rejects invalid maxVisible %j without dropping valid siblings",
    (maxVisible) => {
      const env = setup();
      json(env.project, { maxVisible, widget: false });
      expect(env.load()).toEqual({ ...DEFAULTS, widget: false });
      expect(env.warning).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("maxVisible must be an integer from 1 to 12"),
      );
    },
  );

  it.each([1, 5, 12])("accepts boundary/in-range maxVisible %i", (maxVisible) => {
    const env = setup();
    json(env.project, { maxVisible });
    expect(env.load().maxVisible).toBe(maxVisible);
  });
});

describe("config loading", () => {
  it("uses defaults when absent and returns independent configs", () => {
    const env = setup();
    const first = env.load();
    expect(first).toEqual(DEFAULTS);
    expect(todoSettings.defaults()).toEqual(DEFAULTS);
    first.widget = false;
    expect(env.load()).toEqual(DEFAULTS);
    expect(env.warning).not.toHaveBeenCalled();
  });

  it("layers defaults, global settings, and sparse project overrides", () => {
    const env = setup();
    json(env.global, {
      widget: false,
      maxVisible: 8,
      singleActive: true,
      contextSync: "off",
      confirmClear: false,
    });
    json(env.project, {
      widget: true,
      maxVisible: 2,
      contextSync: "invalid",
      showCompleted: "false",
      unrelated: 1,
    });
    expect(env.load()).toEqual({
      ...DEFAULTS,
      widget: true,
      maxVisible: 2,
      singleActive: true,
      contextSync: "off",
      confirmClear: false,
    });
    expect(env.warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/contextSync must .*showCompleted must .*unrelated is not a setting/),
    );
  });

  it.each(["{broken", "null", "[]", '"text"', '{"widget":"false","maxVisible":99}'])(
    "falls back on invalid project input %s",
    (source) => {
      const env = setup();
      json(env.global, { maxVisible: 9, widget: false });
      writeFileSync(env.project, source);
      expect(env.load()).toEqual({ ...DEFAULTS, maxVisible: 9, widget: false });
      expect(env.warning).toHaveBeenCalledOnce();
    },
  );

  it("sanitizes terminal controls in malformed-file warnings", () => {
    const env = setup();
    writeFileSync(env.project, "\u001b]52;c;clipboard\u0007broken");
    env.load();
    expect(env.warning).toHaveBeenCalledOnce();
    // oxlint-disable-next-line no-control-regex -- Intentionally matches terminal control characters.
    expect(env.warning.mock.calls[0][0]).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });

  it("warns for malformed layers but still applies remaining valid layer", () => {
    const env = setup();
    writeFileSync(env.global, "{bad");
    json(env.project, { widget: false });
    expect(env.load()).toEqual({ ...DEFAULTS, widget: false });
    expect(env.warning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`[pi-todo] Ignoring settings at ${env.global}`),
    );
  });
});

describe("project sparse patches", () => {
  it("creates .pi directory and writes only supplied valid project overrides", () => {
    const env = setup();
    rmSync(join(env.cwd, ".pi"), { recursive: true });
    json(env.global, { maxVisible: 8, singleActive: true });
    const patch = { widget: false };
    todoSettings.save(env.cwd, patch);
    expect(JSON.parse(readFileSync(env.project, "utf8"))).toEqual(patch);
    expect(readFileSync(env.project, "utf8").endsWith("\n")).toBe(true);
    expect(env.load()).toEqual({ ...DEFAULTS, widget: false, maxVisible: 8, singleActive: true });
    json(env.global, { maxVisible: 10, singleActive: false });
    expect(env.load().maxVisible).toBe(10);
    expect(patch).toEqual({ widget: false });
  });

  it("preserves unknown/project keys, replaces only valid supplied fields, leaves global untouched", () => {
    const env = setup();
    json(env.global, { widget: true, maxVisible: 8 });
    const globalBefore = readFileSync(env.global, "utf8");
    json(env.project, { showCompleted: false, maxVisible: 3, metadata: { note: "keep" } });
    todoSettings.save(env.cwd, { widget: false, maxVisible: 0, contextSync: "off" });
    expect(JSON.parse(readFileSync(env.project, "utf8"))).toEqual({
      showCompleted: false,
      maxVisible: 3,
      metadata: { note: "keep" },
      widget: false,
      contextSync: "off",
    });
    expect(readFileSync(env.global, "utf8")).toBe(globalBefore);
  });

  it.each(["{broken", "null", "[]", "false", '"text"'])(
    "refuses to overwrite malformed project settings %s",
    (source) => {
      const env = setup();
      writeFileSync(env.project, source);
      expect(() => todoSettings.save(env.cwd, { widget: false })).toThrow();
      expect(readFileSync(env.project, "utf8")).toBe(source);
    },
  );
});
