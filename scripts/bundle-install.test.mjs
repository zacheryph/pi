import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

void test("root production dependencies resolve bundle aliases without dev workspaces", (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-production-install-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  for (const path of [
    "package.json",
    "package-lock.json",
    "extensions",
    "packages",
    "skills",
    "test",
  ]) {
    cpSync(join(root, path), join(fixture, path), { recursive: true });
  }
  // Pi's Git installer omits dev dependencies and host-provided peers.
  try {
    execFileSync(
      "npm",
      [
        "install",
        "--omit=dev",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--offline",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: fixture, encoding: "utf8", stdio: "pipe" },
    );
    // Drop links that are not root runtime dependencies so a dev workspace
    // cannot accidentally satisfy an alias used by the production bundle.
    const manifest = JSON.parse(readFileSync(join(fixture, "package.json"), "utf8"));
    for (const workspace of manifest.workspaces) {
      const { name } = JSON.parse(readFileSync(join(fixture, workspace, "package.json"), "utf8"));
      if (!Object.hasOwn(manifest.dependencies, name)) {
        rmSync(join(fixture, "node_modules", name), { recursive: true, force: true });
      }
    }
    assert.equal(existsSync(join(fixture, "node_modules/vitest")), false);
    assert.equal(existsSync(join(fixture, "node_modules/pi-test-helpers")), false);
    assert.equal(existsSync(join(fixture, "node_modules/@earendil-works/pi-coding-agent")), false);
    // The host loader supplies the Pi peers; the package supplies its own links.
    execFileSync(process.execPath, [join(root, "scripts/verify-bundle.mjs"), fixture], {
      cwd: fixture,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    assert.fail(`${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`);
  }
});
