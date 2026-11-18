import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { initializePolicy, installBundle, installLink, launchCommand } from "./bundle.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi setup ' 雪-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

void test("bb setup installs the root, resolves the installed peer and builds the plugin in order", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "bb-plugin"));
  const log = join(root, "calls.jsonl");
  const script = `#!${process.execPath}
import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {basename,join} from 'node:path';
const tool=basename(process.argv[1]);
appendFileSync(${JSON.stringify(log)},JSON.stringify({tool,args:process.argv.slice(2),cwd:process.cwd()})+String.fromCharCode(10));
if(tool==='npm' && !process.argv.includes('--include=dev')) {
  const dir=join(${JSON.stringify(root)},'node_modules/@earendil-works/pi-coding-agent');
  mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'package.json'),JSON.stringify({bin:{pi:'pi.mjs'}}));
  writeFileSync(join(dir,'pi.mjs'),${JSON.stringify(`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(log)},JSON.stringify({tool:'pi',args:process.argv.slice(2),cwd:process.cwd()})+String.fromCharCode(10));`)});
}
if(process.env.BUNDLE_TEST_FAIL && process.argv.includes('--include=dev')) process.exit(23);
`;
  for (const tool of ["npm", "bb"]) {
    const file = join(root, "bin", tool);
    write(file, script);
    chmodSync(file, 0o755);
  }
  const previous = { PATH: process.env.PATH, BUNDLE_TEST_FAIL: process.env.BUNDLE_TEST_FAIL };
  process.env.PATH = join(root, "bin");
  delete process.env.BUNDLE_TEST_FAIL;
  try {
    assert.equal(existsSync(join(root, "node_modules")), false);
    installBundle("bb", root);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls, [
      { tool: "npm", args: ["install", "--ignore-scripts"], cwd: root },
      { tool: "pi", args: ["install", root], cwd: root },
      { tool: "npm", args: ["install", "--include=dev"], cwd: join(root, "bb-plugin") },
      { tool: "bb", args: ["plugin", "install", join(root, "bb-plugin"), "--yes"], cwd: root },
    ]);
    writeFileSync(log, "");
    process.env.BUNDLE_TEST_FAIL = "1";
    assert.throws(() => installBundle("bb", root), /status 23/);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

void test("terminal launch preserves the project cwd, literal argv and stdout", (t) => {
  const root = fixture(t),
    project = join(root, "project");
  mkdirSync(project);
  write(
    join(root, "packages/pi-isolate/bin/pi-launch.mjs"),
    "process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));",
  );
  const args = ["", "a ' quote", "$(exit 99)", "雪\n👋", "--model", "--isolate"];
  const command = launchCommand("pi:isolate", args, root, project);
  const output = execFileSync(command.file, command.args, {
    cwd: command.cwd,
    env: { PATH: "/does-not-exist" },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(output), { args: ["--isolate", ...args], cwd: project });
  const plain = launchCommand("pi", args, root, project);
  assert.deepEqual(plain.args.slice(1), args);
});

void test("launcher installation is repeatable and refuses existing files and dangling links", (t) => {
  const root = fixture(t),
    source = join(root, "source"),
    bin = join(root, "bin");
  write(source, "launcher");
  const destination = installLink(source, bin);
  assert.equal(installLink(source, bin), destination);
  assert.equal(readlinkSync(destination), source);
  rmSync(destination);
  write(destination, "keep me");
  assert.throws(() => installLink(source, bin), /already exists/);
  assert.equal(readFileSync(destination, "utf8"), "keep me");
  rmSync(destination);
  symlinkSync(join(root, "missing"), destination);
  assert.throws(() => installLink(source, bin), /already exists/);
  assert.equal(lstatSync(destination).isSymbolicLink(), true);
});

void test("policy setup creates a private example and preserves existing policies", (t) => {
  const root = fixture(t),
    home = join(root, "home");
  write(join(root, "packages/pi-isolate/isolation.example.yaml"), "example policy");
  const first = initializePolicy(root, home);
  assert.equal(first.created, true);
  assert.equal(statSync(first.path).mode & 0o777, 0o600);
  writeFileSync(first.path, "keep existing secrets and grants");
  assert.deepEqual(initializePolicy(root, home), { path: first.path, created: false });
  assert.equal(readFileSync(first.path, "utf8"), "keep existing secrets and grants");
});
