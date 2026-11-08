import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { tempDir } from "#test/helpers";
import { DEFAULT_CONFIG, loadDashboardConfig } from "../src/config.ts";
let root: string, path: string;
beforeEach(() => {
  root = tempDir();
  path = join(root, "dashboard.json");
});
it("uses silent defaults for missing and malformed files", () => {
  expect(loadDashboardConfig(path)).toEqual(DEFAULT_CONFIG);
  writeFileSync(path, "{bad");
  expect(loadDashboardConfig(path)).toEqual(DEFAULT_CONFIG);
});
it("validates the port and trims the node binary without losing valid sibling fields", () => {
  writeFileSync(path, JSON.stringify({ port: 0, node: " /opt/node " }));
  expect(loadDashboardConfig(path)).toEqual({ ...DEFAULT_CONFIG, node: "/opt/node" });
  writeFileSync(path, JSON.stringify({ port: 65535 }));
  expect(loadDashboardConfig(path)).toEqual({ port: 65535 });
});
