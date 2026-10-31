import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changedFiles, selectExtensions } from "./select-test-extensions.mjs";

const workspaces = [
  "extensions/pi-todo",
  "extensions/pi-subagents",
  "extensions/pi-system-insights",
  "packages/pi-session-tree",
];
const all = [...workspaces].sort();

void test("main runs all extension workspaces", () => {
  assert.deepEqual(selectExtensions([...workspaces, "other-workspace"], [], true), all);
});

void test("PRs select only changed extensions, once per extension", () => {
  assert.deepEqual(
    selectExtensions(workspaces, [
      "extensions/pi-todo/src/index.ts",
      "extensions/pi-todo/test/example.test.ts",
      "extensions/pi-subagents/README.md",
    ]),
    ["extensions/pi-subagents", "extensions/pi-todo"],
  );
});

void test("unrelated, removed, and similarly prefixed extensions do not match", () => {
  assert.deepEqual(
    selectExtensions(workspaces, [
      "README.md",
      "extensions/removed/index.ts",
      "extensions/pi-todo-extra/index.ts",
    ]),
    [],
  );
  assert.deepEqual(selectExtensions(workspaces, []), []);
});

void test("shared dependency, compiler, and CI changes select all extensions", () => {
  for (const path of [
    ".nvmrc",
    "package.json",
    "package-lock.json",
    "tsconfig.base.json",
    "tsconfig.json",
    ".oxlintrc.json",
    ".oxfmtrc.json",
    ".github/workflows/extensions.yml",
    "scripts/select-test-extensions.mjs",
  ]) {
    assert.deepEqual(selectExtensions(workspaces, [path]), all, path);
  }
});

void test("a shared package change selects every workspace, including the package", () => {
  assert.deepEqual(selectExtensions(workspaces, ["packages/pi-session-tree/src/index.ts"]), all);
});

void test("packages/ files outside a workspace directory do not select everything", () => {
  assert.deepEqual(selectExtensions(workspaces, ["packages/README.md"]), []);
});

void test("git diff excludes base-only changes and selects both sides of cross-extension moves", () => {
  const cwd = mkdtempSync(join(tmpdir(), "extension-selection-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "test fixture",
    );
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "--initial-branch=main");
    mkdirSync(join(cwd, "extensions/pi-todo"), { recursive: true });
    mkdirSync(join(cwd, "extensions/pi-subagents"), { recursive: true });
    writeFileSync(join(cwd, "extensions/pi-todo/old file.ts"), "example");
    const start = commit();
    writeFileSync(join(cwd, "package.json"), "{}");
    const base = commit();
    git("checkout", "-b", "pr", start);
    git("mv", "extensions/pi-todo/old file.ts", "extensions/pi-subagents/new file.ts");
    const head = commit();
    const paths = changedFiles(base, head, cwd);
    assert.deepEqual(paths.sort(), [
      "extensions/pi-subagents/new file.ts",
      "extensions/pi-todo/old file.ts",
    ]);
    assert.deepEqual(selectExtensions(workspaces, paths), [
      "extensions/pi-subagents",
      "extensions/pi-todo",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
