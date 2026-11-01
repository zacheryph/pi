import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadDashboardConfig } from "../src/config.ts";
let root: string, path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dashboard-config-"));
  path = join(root, "dashboard.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
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
