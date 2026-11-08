import { beforeEach, expect, it, onTestFinished } from "vitest";
import { settingsDirs, type SettingsDirs } from "../../../packages/pi-test-helpers/src/temp.ts";
import { DEFAULT_CONFIG, loadTldrConfig } from "../src/config.ts";
let dirs: SettingsDirs, agentDir: string, cwd: string;
beforeEach(() => {
  dirs = settingsDirs(onTestFinished, "tldr.json", "tldr-config-");
  ({ agentDir, cwd } = dirs);
});
it("layers global and project settings without weakening strict validation", () => {
  expect(loadTldrConfig(cwd, agentDir)).toEqual(DEFAULT_CONFIG);
  dirs.writeGlobal({ model: " custom/luna ", setSessionName: false });
  dirs.writeProject({ setSessionName: true });
  expect(loadTldrConfig(cwd, agentDir)).toEqual({ model: "custom/luna", setSessionName: true });
});
it.each(["{bad", "[]", "null", '{"model":""}', '{"setSessionName":"yes"}'])(
  "rejects invalid configuration %s with its path",
  (raw) => {
    dirs.writeProject(raw);
    expect(() => loadTldrConfig(cwd, agentDir)).toThrow(dirs.projectFile);
  },
);
