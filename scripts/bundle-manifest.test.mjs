import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readRepository, registrationProblems } from "./bundle-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const scripts = { check: "x", test: "x" };

/**
 * A consistent repository with one extension and one package; override parts per test.
 * @param {Partial<import("./bundle-manifest.mjs").Repository>} [overrides]
 * @returns {import("./bundle-manifest.mjs").Repository & { manifest: any, workspaces: any }}
 */
function fixture(overrides = {}) {
  return {
    manifest: {
      workspaces: ["extensions/pi-a", "packages/pi-lib"],
      pi: { extensions: ["./extensions/pi-a/src/index.ts"], skills: ["./skills"] },
    },
    directories: ["extensions/pi-a", "packages/pi-lib"],
    workspaces: {
      "extensions/pi-a": { name: "pi-a", scripts, pi: { extensions: ["./src/index.ts"] } },
      "packages/pi-lib": { name: "pi-lib", scripts },
    },
    exists: () => true,
    ...overrides,
  };
}

void test("this repository's manifest is consistent", () => {
  assert.deepEqual(registrationProblems(readRepository(root)), []);
});

void test("a consistent fixture has no problems", () => {
  assert.deepEqual(registrationProblems(fixture()), []);
});

void test("a directory missing from workspaces is reported", () => {
  const repo = fixture({ directories: ["extensions/pi-a", "extensions/pi-b", "packages/pi-lib"] });
  assert.deepEqual(registrationProblems(repo), [
    "extensions/pi-b is not listed in package.json workspaces",
  ]);
});

void test("an extension missing from root pi.extensions is reported", () => {
  const repo = fixture();
  repo.manifest.pi.extensions = [];
  assert.deepEqual(registrationProblems(repo), [
    "root pi.extensions is missing ./extensions/pi-a/src/index.ts",
  ]);
});

void test("a stale or missing root entry is reported", () => {
  const repo = fixture({ exists: (path) => !path.includes("pi-gone") });
  repo.manifest.pi.extensions.push("./extensions/pi-gone/src/index.ts");
  assert.deepEqual(registrationProblems(repo), [
    "root pi.extensions has ./extensions/pi-gone/src/index.ts, which no extension workspace declares",
    "root pi.extensions entry ./extensions/pi-gone/src/index.ts does not exist",
  ]);
});

void test("an extension's skills directory must be in root pi.skills", () => {
  const repo = fixture();
  repo.workspaces["extensions/pi-a"].pi.skills = ["./skills"];
  assert.deepEqual(registrationProblems(repo), [
    "root pi.skills is missing ./extensions/pi-a/skills",
  ]);
  repo.manifest.pi.skills.push("./extensions/pi-a/skills", "./extensions/pi-old/skills");
  assert.deepEqual(registrationProblems(repo), [
    "root pi.skills has ./extensions/pi-old/skills, which no workspace declares",
  ]);
});

void test("workspace name, scripts and entry point are checked", () => {
  const repo = fixture();
  repo.workspaces["extensions/pi-a"] = { name: "a", scripts: { check: "x" } };
  assert.deepEqual(registrationProblems(repo), [
    'extensions/pi-a/package.json name is "a", expected "pi-a"',
    'extensions/pi-a has no "test" script',
    "extensions/pi-a/package.json declares no pi.extensions entry point",
    "root pi.extensions has ./extensions/pi-a/src/index.ts, which no extension workspace declares",
  ]);
});

void test("a workspace without package.json is reported", () => {
  const repo = fixture();
  delete repo.workspaces["packages/pi-lib"];
  assert.deepEqual(registrationProblems(repo), ["workspace packages/pi-lib has no package.json"]);
});

void test("a shared package must not declare pi entries", () => {
  const repo = fixture();
  repo.workspaces["packages/pi-lib"].pi = { extensions: ["./src/index.ts"] };
  assert.deepEqual(registrationProblems(repo), [
    "packages/pi-lib is a shared package; move its pi entries to an extension",
  ]);
});
