import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {Array<[string, string[]]>} */
const scenarios = [
  ["pi-scaffold-tools", ["--tool", "scaffold_probe", "--command", "scaffold-probe"]],
  ["pi-scaffold-minimal", ["--no-tui"]],
];

for (const [name, args] of scenarios) {
  void test(`scaffolded ${name} passes shared checks and its generated tests`, (t) => {
    const fixture = mkdtempSync(join(tmpdir(), "pi-scaffold-test-"));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    mkdirSync(join(fixture, ".agents/skills"), { recursive: true });
    mkdirSync(join(fixture, "scripts"));
    cpSync(
      join(root, ".agents/skills/new-extension"),
      join(fixture, ".agents/skills/new-extension"),
      { recursive: true },
    );
    for (const path of [
      ".oxfmtrc.json",
      ".oxlintrc.json",
      "tsconfig.base.json",
      "scripts/verify-bundle.mjs",
    ]) {
      cpSync(join(root, path), join(fixture, path));
    }
    symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    manifest.workspaces = [];
    manifest.pi.extensions = [];
    writeFileSync(join(fixture, "package.json"), JSON.stringify(manifest));
    const run = (command, commandArgs) => {
      try {
        return execFileSync(command, commandArgs, {
          cwd: fixture,
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch (error) {
        assert.fail(`${command} ${commandArgs.join(" ")}\n${error.stdout}\n${error.stderr}`);
      }
    };
    run(process.execPath, [
      ".agents/skills/new-extension/scripts/scaffold.mjs",
      name,
      "--description",
      "Scaffold integration test",
      "--no-install",
      ...args,
    ]);
    const workspace = `extensions/${name}`;
    const generated = JSON.parse(readFileSync(join(fixture, workspace, "package.json"), "utf8"));
    assert.equal(generated.devDependencies, undefined, "workspaces use the shared root tools");
    const updated = JSON.parse(readFileSync(join(fixture, "package.json"), "utf8"));
    assert.deepEqual(updated.workspaces, [workspace]);
    assert.deepEqual(updated.pi.extensions, [`./${workspace}/src/index.ts`]);
    run("npm", ["run", "check", "-w", workspace]);
    run("npm", ["test", "-w", workspace]);
  });
}
