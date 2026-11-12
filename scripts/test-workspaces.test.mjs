import assert from "node:assert/strict";
import { test } from "node:test";
import { testCommands } from "./test-workspaces.mjs";
import { readWorkspaces } from "./workspaces.mjs";

const workspaces = readWorkspaces();

void test("selects one Vitest project by name or directory, without other workspaces", () => {
  const byName = testCommands(workspaces, ["pi-todo"]);
  assert.deepEqual(byName, testCommands(workspaces, ["extensions/pi-todo"]));
  assert.equal(byName.length, 1);
  assert.deepEqual(byName[0].args.slice(-2), ["--project", "pi-todo"]);
  assert.ok(byName[0].args.includes("run"));
});

void test("all tests route pi-job to Node and every other project to Vitest exactly once", () => {
  const [node, vitest] = testCommands(workspaces, []);
  assert.ok(node.cwd.endsWith("extensions/pi-job"));
  assert.ok(node.args.includes("--test-timeout=30000"));
  const projects = vitest.args.filter((_, i) => vitest.args[i - 1] === "--project");
  assert.deepEqual(
    projects.sort(),
    workspaces
      .filter((ws) => ws.runner === "vitest")
      .map((ws) => ws.name)
      .sort(),
  );
  assert.equal(new Set(projects).size, projects.length);
});

void test("watch mode uses the selected framework and requires one valid workspace", () => {
  assert.ok(testCommands(workspaces, ["pi-job", "--watch"])[0].args.includes("--watch"));
  assert.ok(testCommands(workspaces, ["test", "--watch"])[0].args.includes("watch"));
  assert.throws(() => testCommands(workspaces, ["--watch"]), /requires one workspace/);
  assert.throws(() => testCommands(workspaces, ["missing"]), /Unknown workspace/);
  assert.throws(() => testCommands(workspaces, ["pi-todo", "pi-job"]), /Usage/);
});
