import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { settingsDirs, type SettingsDirs } from "#test-helpers";
import { tldrSettings } from "#src/config";
let dirs: SettingsDirs;
const DEFAULTS = { model: "auto", setSessionName: true };
const load = () => tldrSettings.load(dirs.cwd, dirs.agentDir);
beforeEach(() => {
  dirs = settingsDirs(onTestFinished, "tldr.json", "tldr-config-");
});
afterEach(() => vi.restoreAllMocks());
it("layers global and project settings", () => {
  expect(load()).toEqual(DEFAULTS);
  dirs.writeGlobal({ model: " custom/luna ", setSessionName: false });
  dirs.writeProject({ setSessionName: true });
  expect(load()).toEqual({ model: "custom/luna", setSessionName: true });
});
it.each(["{bad", "[]", "null", '{"model":""}', '{"setSessionName":"yes"}'])(
  "warns about invalid configuration %s with its path and keeps the global layer",
  (raw) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dirs.writeGlobal({ model: "custom/luna" });
    dirs.writeProject(raw);
    expect(load()).toEqual({ ...DEFAULTS, model: "custom/luna" });
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(dirs.projectFile));
  },
);
