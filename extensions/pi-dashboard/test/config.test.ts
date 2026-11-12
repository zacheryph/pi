import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tempDir } from "#test/helpers";
import { dashboardSettings } from "../src/config.ts";
import { DEFAULT_PORT } from "../src/protocol.ts";
let root: string, path: string;
const load = () => dashboardSettings.load(root, root);
beforeEach(() => {
  root = tempDir();
  path = join(root, "dashboard.json");
});
afterEach(() => vi.restoreAllMocks());
it("is silent for a missing file and warns then defaults for a malformed one", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(load()).toEqual({ port: DEFAULT_PORT });
  expect(warn).not.toHaveBeenCalled();
  writeFileSync(path, "{bad");
  expect(load()).toEqual({ port: DEFAULT_PORT });
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining(`[pi-dashboard] Ignoring settings at ${path}`),
  );
});
it("validates the port and trims the node binary without losing valid sibling fields", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  writeFileSync(path, JSON.stringify({ port: 0, node: " /opt/node " }));
  expect(load()).toEqual({ port: DEFAULT_PORT, node: "/opt/node" });
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("port must be an integer from 1 to 65535"),
  );
  writeFileSync(path, JSON.stringify({ port: 65535 }));
  expect(load()).toEqual({ port: 65535 });
});
