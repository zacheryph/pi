import assert from "node:assert/strict";
import { test } from "node:test";
import { commandNameProblems, commandPrefix, extensionName } from "./command-names.mjs";

void test("the extension name comes from the entry point's directory", () => {
  assert.equal(extensionName("/repo/extensions/pi-todo/src/index.ts"), "pi-todo");
  assert.equal(extensionName("./extensions/pi-job/src/extension.ts"), "pi-job");
  assert.equal(extensionName("C:\\repo\\extensions\\pi-git\\src\\index.ts"), "pi-git");
  assert.equal(extensionName("/repo/packages/pi-ui/src/index.ts"), undefined);
});

void test("the prefix is the name less pi-, unless listed as an exception", () => {
  assert.equal(commandPrefix("pi-subagent"), "subagent");
  assert.equal(commandPrefix("pi-system-insights"), "system");
});

void test("the bare name and name:action pass", () => {
  assert.deepEqual(commandNameProblems("pi-todo", ["todo", "todo:review", "todo:add"]), []);
  assert.deepEqual(commandNameProblems("pi-git", ["git:prs"]), []);
});

void test("another prefix, an unprefixed action, or an empty action fails", () => {
  assert.deepEqual(commandNameProblems("pi-subagent", ["agents", "todo:add", "subagent:"]), [
    "pi-subagent: /agents must be /subagent or /subagent:<action>",
    "pi-subagent: /todo:add must be /subagent or /subagent:<action>",
    "pi-subagent: /subagent: must be /subagent or /subagent:<action>",
  ]);
});

void test("nested actions and uppercase fail", () => {
  assert.deepEqual(commandNameProblems("pi-stash", ["stash:gc:now", "stash:GC"]), [
    "pi-stash: /stash:gc:now must be /stash or /stash:<action>",
    "pi-stash: /stash:GC must be lowercase",
  ]);
});

void test("a prefix that only starts with the extension name fails", () => {
  assert.deepEqual(commandNameProblems("pi-job", ["jobs", "jobs:list"]), [
    "pi-job: /jobs must be /job or /job:<action>",
    "pi-job: /jobs:list must be /job or /job:<action>",
  ]);
});
