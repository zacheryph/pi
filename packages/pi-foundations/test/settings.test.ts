import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { settingsDirs, tempDir } from "#test-helpers";
import {
  bool,
  defineSettings,
  int,
  list,
  number,
  oneOf,
  optional,
  record,
  string,
  type SettingsOf,
  patchSettingsFile,
  readSettingsFile,
  writeSettingsFile,
} from "#src/settings";

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

describe("defineSettings", () => {
  const layered = defineSettings({
    name: "demo",
    scope: "layered",
    writable: true,
    fields: {
      enabled: bool({ default: true }),
      rows: int({ default: 5, min: 1, max: 12 }),
      ratio: number({ default: 1, min: 0, exclusiveMin: true }),
      mode: oneOf(["changes", "off"], { default: "changes" }),
      label: string({ default: "auto", trim: true, nonEmpty: true }),
      binary: optional(string({ trim: true, nonEmpty: true })),
    },
  });
  const setup = () => {
    const dirs = settingsDirs(onTestFinished, "demo.json", "pi-define-settings-");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    return { ...dirs, warn, load: () => layered.load(dirs.cwd, dirs.agentDir) };
  };
  const defaults = {
    enabled: true,
    rows: 5,
    ratio: 1,
    mode: "changes",
    label: "auto",
  };

  it("returns independent defaults silently when no file exists", () => {
    const env = setup();
    const first = env.load();
    expect(first).toStrictEqual(defaults);
    first.rows = 9;
    expect(env.load()).toEqual(defaults);
    expect(layered.defaults(env.cwd, env.agentDir)).toEqual(defaults);
    expect(env.warn).not.toHaveBeenCalled();
  });

  it("validates each field and lets the project override the global layer", () => {
    const env = setup();
    env.writeGlobal({ enabled: false, rows: 8, ratio: 0.5, mode: "off", binary: " /bin/x " });
    env.writeProject({ rows: 2, label: "  custom  " });
    expect(env.load()).toEqual({
      enabled: false,
      rows: 2,
      ratio: 0.5,
      mode: "off",
      label: "custom",
      binary: "/bin/x",
    });
    expect(env.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["enabled", "yes", "enabled must be true or false"],
    ["rows", 13, "rows must be an integer from 1 to 12"],
    ["rows", 1.5, "rows must be an integer from 1 to 12"],
    ["ratio", 0, "ratio must be a number greater than 0"],
    ["ratio", Infinity, "ratio must be a number greater than 0"],
    ["mode", "always", 'mode must be one of "changes", "off"'],
    ["label", "  ", "label must be a non-empty string"],
    ["binary", 3, "binary must be a string"],
    ["typo", 1, "typo is not a setting"],
  ])("drops invalid %s %j, keeps the lower layer and names it", (key, value, reason) => {
    const env = setup();
    env.writeGlobal({ rows: 7, mode: "off" });
    const sibling = key === "label" ? { enabled: false } : { label: "kept" };
    env.writeProject({ [key]: value, ...sibling });
    expect(env.load()).toEqual({ ...defaults, rows: 7, mode: "off", ...sibling });
    expect(env.warn).toHaveBeenCalledOnce();
    expect(env.warn).toHaveBeenCalledWith(
      `[pi-demo] Ignoring invalid settings at ${env.projectFile}: ${reason}`,
    );
  });

  it("names every invalid field of a file in one warning", () => {
    const env = setup();
    env.writeProject({ rows: 0, mode: 1 });
    env.load();
    expect(env.warn).toHaveBeenCalledOnce();
    expect(env.warn.mock.calls[0][0]).toMatch(/rows must .*; mode must /);
  });

  it.each(["{bad", "null", "[]", '"text"', "3"])(
    "warns once and uses the other layer for malformed file %s",
    (raw) => {
      const env = setup();
      env.writeGlobal({ rows: 9 });
      env.writeProject(raw);
      expect(env.load()).toEqual({ ...defaults, rows: 9 });
      expect(env.warn).toHaveBeenCalledOnce();
      expect(env.warn.mock.calls[0][0]).toMatch(
        new RegExp(
          `^\\[pi-demo\\] Ignoring settings at ${env.projectFile.replace(/\W/g, "\\$&")}: `,
        ),
      );
    },
  );

  it("warns when a settings path cannot be read", () => {
    const env = setup();
    mkdirSync(env.projectFile, { recursive: true });
    expect(env.load()).toEqual(defaults);
    expect(env.warn).toHaveBeenCalledOnce();
  });

  it("strips terminal controls from warnings", () => {
    const env = setup();
    env.writeProject({ "\u001b]52;c;clip\u0007key\nnext": 1 });
    env.load();
    // oxlint-disable-next-line no-control-regex -- Intentionally matches terminal control characters.
    expect(env.warn.mock.calls[0][0]).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });

  it("reads only the global file for a global definition", () => {
    const env = setup();
    const global = defineSettings({
      name: "demo",
      scope: "global",
      fields: { rows: int({ default: 5, min: 1 }) },
    });
    env.writeGlobal({ rows: 3 });
    env.writeProject({ rows: 4 });
    expect(global.load(env.cwd, env.agentDir)).toEqual({ rows: 3 });
    expect(global.paths(env.cwd, env.agentDir)).toEqual({ global: env.globalFile });
    expect("save" in global).toBe(false);
  });

  it("refuses to make a global definition writable", () => {
    expect(() =>
      defineSettings({ name: "demo", scope: "global", writable: true, fields: {} }),
    ).toThrow("only layered settings save");
  });

  it("computes defaults from the context and transforms merged values", () => {
    const env = setup();
    const paths = defineSettings({
      name: "demo",
      scope: "layered",
      fields: {
        root: string({
          default: ({ agentDir }) => join(agentDir, "worktrees"),
          trim: true,
          nonEmpty: true,
          transform: (value, { cwd }) => resolve(cwd, value),
        }),
      },
    });
    expect(paths.load(env.cwd, env.agentDir)).toEqual({ root: join(env.agentDir, "worktrees") });
    env.writeProject({ root: " sub " });
    expect(paths.load(env.cwd, env.agentDir)).toEqual({ root: join(env.cwd, "sub") });
  });

  it("saves only valid, defined fields to the project file and keeps its other keys", () => {
    const env = setup();
    env.writeGlobal({ rows: 8 });
    const globalBefore = readFileSync(env.globalFile, "utf8");
    env.writeProject({ label: "kept", metadata: { note: "keep" } });
    layered.save(env.cwd, { enabled: false, rows: 0, mode: "off", binary: undefined });
    expect(JSON.parse(readFileSync(env.projectFile, "utf8"))).toEqual({
      label: "kept",
      metadata: { note: "keep" },
      enabled: false,
      mode: "off",
    });
    expect(readFileSync(env.globalFile, "utf8")).toBe(globalBefore);
  });

  it.each(["{bad", "null", "[]"])("refuses to save over malformed project file %s", (raw) => {
    const env = setup();
    env.writeProject(raw);
    expect(() => layered.save(env.cwd, { enabled: false })).toThrow();
    expect(readFileSync(env.projectFile, "utf8")).toBe(raw);
  });

  describe("list and record", () => {
    const collections = defineSettings({
      name: "demo",
      scope: "layered",
      fields: {
        sources: list(string({ trim: true, nonEmpty: true }), { unique: true }),
        rules: record(oneOf(["full", "portable"], {})),
      },
    });
    const load = (env: ReturnType<typeof setup>) => collections.load(env.cwd, env.agentDir);

    it("defaults to fresh empty collections", () => {
      const env = setup();
      const first = load(env);
      expect(first).toEqual({ sources: [], rules: {} });
      first.sources.push("x");
      first.rules.x = "full";
      expect(load(env)).toEqual({ sources: [], rules: {} });
    });

    it("keeps valid members, trims and dedupes, and names each one dropped", () => {
      const env = setup();
      env.writeProject({
        sources: [" npm:a ", "npm:a", "", 3, "npm:b"],
        rules: { openai: "portable", anthropic: "full", other: "half" },
      });
      expect(load(env)).toEqual({
        sources: ["npm:a", "npm:b"],
        rules: { openai: "portable", anthropic: "full" },
      });
      expect(env.warn).toHaveBeenCalledExactlyOnceWith(
        `[pi-demo] Ignoring invalid settings at ${env.projectFile}: ` +
          'sources[2] must be a non-empty string; sources[3] must be a string; rules.other must be one of "full", "portable"',
      );
    });

    it("keeps a __proto__ key as data", () => {
      const env = setup();
      env.writeProject('{"rules":{"__proto__":"portable"}}');
      const { rules } = load(env);
      expect(Object.hasOwn(rules, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(rules)).toBe(Object.prototype);
    });

    it("drops a collection of the wrong shape and keeps the lower layer", () => {
      const env = setup();
      env.writeGlobal({ sources: ["npm:a"], rules: { openai: "portable" } });
      env.writeProject({ sources: "npm:b", rules: ["full"] });
      expect(load(env)).toEqual({ sources: ["npm:a"], rules: { openai: "portable" } });
      expect(env.warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("sources must be a list; rules must be an object"),
      );
    });

    it("lets a project's empty collection replace the global one", () => {
      const env = setup();
      env.writeGlobal({ sources: ["npm:a"] });
      env.writeProject({ sources: [] });
      expect(load(env).sources).toEqual([]);
    });
  });

  it("infers the loaded type from the fields", () => {
    expectTypeOf<SettingsOf<typeof layered>>().toEqualTypeOf<{
      enabled: boolean;
      rows: number;
      ratio: number;
      mode: "changes" | "off";
      label: string;
      binary?: string;
    }>();
  });
});
