import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { foreignToolProblem } from "./tool-guard.mjs";

const blocked = (command) => foreignToolProblem(command) !== undefined;

void test("foreign formatters and linters are blocked however they are started", () => {
  for (const command of [
    "prettier --write .",
    "npx prettier --write src/index.ts",
    "npx --yes prettier@3.3.3 --check .",
    "npx -y @biomejs/biome format --write .",
    "pnpm dlx prettier --write .",
    "pnpm exec eslint .",
    "npm exec -- eslint --fix .",
    "yarn prettier --write .",
    "bunx biome check .",
    "./node_modules/.bin/prettier --write a.ts",
    "CI=1 eslint .",
    "env FORCE_COLOR=0 npx dprint fmt",
    "cd extensions/pi-todo && npx prettier --write src",
    "git diff --name-only | xargs npx prettier --write",
    "echo $(prettier --version)",
    "npm install --save-dev prettier",
    "npm i -D eslint @eslint/js",
    "yarn add --dev @biomejs/biome",
  ]) {
    assert.ok(blocked(command), command);
  }
});

void test("the repository's own tools and prose about others pass", () => {
  for (const command of [
    "npm run fix",
    "npm run check",
    "npx oxfmt --write extensions/pi-todo/src/index.ts",
    "npx oxlint --deny-warnings .",
    "npm install --ignore-scripts",
    "grep -rn prettier .",
    "rg eslint-disable extensions",
    'git -c commit.gpgsign=false commit -m "Stop agents running prettier; use oxfmt"',
    "echo 'run prettier && eslint'",
    "cat <<'EOF' > notes.md\nprettier --write .\nEOF\nnpm run check",
    "ls node_modules/prettier",
  ]) {
    assert.equal(foreignToolProblem(command), undefined, command);
  }
});

void test("the reason names the replacement and how to undo the damage", () => {
  const reason = foreignToolProblem("npx prettier --write .");
  assert.match(reason, /does not use prettier; it uses oxfmt/);
  assert.match(reason, /npm run fix/);
  assert.match(reason, /git checkout -- <paths>/);
  assert.match(foreignToolProblem("eslint ."), /it uses oxlint/);
});

void test("as a Claude Code hook it exits 2 with the reason, or 0", () => {
  const script = fileURLToPath(new URL("./tool-guard.mjs", import.meta.url));
  const run = (input) => spawnSync(process.execPath, [script], { input, encoding: "utf8" });

  const denied = run(
    JSON.stringify({ tool_name: "Bash", tool_input: { command: "npx prettier -w ." } }),
  );
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /it uses oxfmt/);

  const allowed = run(
    JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm run fix" } }),
  );
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stderr, "");

  assert.equal(run("not json").status, 0);
});
