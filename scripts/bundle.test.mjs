import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { installBundle } from "./bundle.mjs";

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
      { tool: "npm", args: ["ci", "--include=dev"], cwd: join(root, "bb-plugin") },
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
