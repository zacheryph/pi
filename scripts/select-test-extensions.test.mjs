import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changedFiles, selectExtensions } from "./select-test-extensions.mjs";

const workspaces = [
  "extensions/pi-todo",
  "extensions/pi-subagent",
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
      "extensions/pi-subagent/README.md",
    ]),
    ["extensions/pi-subagent", "extensions/pi-todo"],
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

void test("any selected extension or package also selects the bundle tests", () => {
  const withBundle = [...workspaces, "packages/pi-scripted-model", "test"];
  assert.deepEqual(selectExtensions(withBundle, ["extensions/pi-todo/src/index.ts"]), [
    "extensions/pi-todo",
    "test",
  ]);
  assert.deepEqual(selectExtensions(withBundle, ["README.md"]), []);
  assert.deepEqual(
    selectExtensions(withBundle, ["packages/pi-scripted-model/src/harness.ts"]),
    [...withBundle].sort(),
  );
});

void test("a change to the bundle tests selects only them", () => {
  const withBundle = [...workspaces, "test"];
  assert.deepEqual(selectExtensions(withBundle, ["test/scenarios/job-wake.test.ts"]), ["test"]);
  assert.deepEqual(selectExtensions(withBundle, ["tests/other.ts", "testing.md"]), []);
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
    mkdirSync(join(cwd, "extensions/pi-subagent"), { recursive: true });
    writeFileSync(join(cwd, "extensions/pi-todo/old file.ts"), "example");
    const start = commit();
    writeFileSync(join(cwd, "package.json"), "{}");
    const base = commit();
    git("checkout", "-b", "pr", start);
    git("mv", "extensions/pi-todo/old file.ts", "extensions/pi-subagent/new file.ts");
    const head = commit();
    const paths = changedFiles(base, head, cwd);
    assert.deepEqual(paths.sort(), [
      "extensions/pi-subagent/new file.ts",
      "extensions/pi-todo/old file.ts",
    ]);
    assert.deepEqual(selectExtensions(workspaces, paths), [
      "extensions/pi-subagent",
      "extensions/pi-todo",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

void test("producer source changes also select their dashboard consumer", () => {
  const candidates = [
    "extensions/pi-dashboard",
    "extensions/pi-todo",
    "extensions/pi-stash",
    "extensions/pi-git",
    "extensions/pi-subagent",
    "extensions/pi-ask",
    "test",
  ];
  for (const producer of ["pi-todo", "pi-stash", "pi-git", "pi-subagent"]) {
    assert.deepEqual(
      selectExtensions(candidates, [
        `extensions/${producer}/src/events.ts`,
        `extensions/${producer}/src/state.ts`,
      ]),
      ["extensions/pi-dashboard", `extensions/${producer}`, "test"].sort(),
    );
  }
  assert.deepEqual(selectExtensions(candidates, ["extensions/pi-todo/test/events.test.ts"]), [
    "extensions/pi-todo",
    "test",
  ]);
  assert.deepEqual(selectExtensions(candidates, ["extensions/pi-ask/src/index.ts"]), [
    "extensions/pi-ask",
    "test",
  ]);
  assert.deepEqual(
    selectExtensions(candidates, [
      "extensions/pi-dashboard/src/index.ts",
      "extensions/pi-todo/src/events.ts",
    ]),
    ["extensions/pi-dashboard", "extensions/pi-todo", "test"],
  );
});
