import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadTldrConfig } from "../src/config.ts";
let root: string, agentDir: string, cwd: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tldr-config-"));
  agentDir = join(root, "agent");
  cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
});
it("layers global and project settings without weakening strict validation", () => {
  expect(loadTldrConfig(cwd, agentDir)).toEqual(DEFAULT_CONFIG);
  writeFileSync(
    join(agentDir, "tldr.json"),
    JSON.stringify({ model: " custom/luna ", setSessionName: false }),
  );
  writeFileSync(join(cwd, ".pi/tldr.json"), JSON.stringify({ setSessionName: true }));
  expect(loadTldrConfig(cwd, agentDir)).toEqual({ model: "custom/luna", setSessionName: true });
});
it.each(["{bad", "[]", "null", '{"model":""}', '{"setSessionName":"yes"}'])(
  "rejects invalid configuration %s with its path",
  (raw) => {
    const file = join(cwd, ".pi/tldr.json");
    writeFileSync(file, raw);
    expect(() => loadTldrConfig(cwd, agentDir)).toThrow(file);
  },
);
