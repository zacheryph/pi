import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
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
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd, args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

/** Write files (path → content) under dir. */
function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** An upstream repository holding a Pi extension package at `prefix`. */
function upstreamRepo(base, prefix, { license = "MIT", licenseAtRoot = false } = {}) {
  const repo = join(base, "upstream");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  const p = prefix ? `${prefix}/` : "";
  write(repo, {
    ".gitignore": "dist\n",
    [licenseAtRoot ? "LICENSE" : `${p}LICENSE`]: "MIT License\n",
    [`${p}package.json`]: JSON.stringify({
      name: "@upstream/pi-fixture",
      version: "1.2.3",
      description: "A fixture extension.",
      license,
      files: ["src"],
      publishConfig: { access: "public" },
      scripts: { check: "true", test: "true" },
      pi: { extensions: ["./src/index.ts"] },
    }),
    [`${p}src/index.ts`]: "export default function () {}\n",
    [`${p}bin/run.sh`]: "#!/bin/sh\necho hi\n",
    [`${p}dist/out.js`]: "// tracked although ignored\n",
    [`${p}.github/workflows/ci.yml`]: "on: push\n",
    [`${p}CHANGELOG.md`]: "# Upstream changelog\n",
    [`${p}package-lock.json`]: "{}\n",
  });
  chmodSync(join(repo, p, "bin/run.sh"), 0o755);
  symlinkSync("src/index.ts", join(repo, p, "entry.ts"));
  git(repo, ["add", "-A"]);
  git(repo, ["add", "-f", `${p}dist/out.js`]);
  git(repo, ["commit", "-q", "-m", "upstream"]);
  return repo;
}

/** A copy of this repository's root wiring with no extensions registered. */
function targetRepo(base) {
  const repo = join(base, "target");
  mkdirSync(join(repo, ".agents/skills"), { recursive: true });
  cpSync(
    join(root, ".agents/skills/import-extension"),
    join(repo, ".agents/skills/import-extension"),
    {
      recursive: true,
    },
  );
  cpSync(join(root, ".oxfmtrc.json"), join(repo, ".oxfmtrc.json"));
  symlinkSync(join(root, "node_modules"), join(repo, "node_modules"), "dir");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  manifest.workspaces = [];
  manifest.pi.extensions = ["./extensions/pi-first/src/index.ts"];
  write(repo, {
    "package.json": JSON.stringify(manifest),
    ".gitignore": "node_modules\ndist\n",
  });
  git(repo, ["init", "-q"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
}

function runImport(repo, args) {
  return spawnSync(
    process.execPath,
    [".agents/skills/import-extension/scripts/import.mjs", "pi-fixture", "--no-install", ...args],
    { cwd: repo, env, encoding: "utf8" },
  );
}

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "pi-import-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

void test("imports a repository verbatim, then prepares the integration", (t) => {
  const base = fixture(t);
  const upstream = upstreamRepo(base, "");
  const repo = targetRepo(base);
  const result = runImport(repo, ["--source", upstream, "--trailer", "Co-Authored-By: Test <t@t>"]);
  assert.equal(result.status, 0, result.stderr);

  // The import commit holds exactly upstream's tree, ignored and executable files included.
  assert.equal(
    git(repo, ["rev-parse", "HEAD:extensions/pi-fixture"]),
    git(upstream, ["rev-parse", "HEAD^{tree}"]),
  );
  const message = git(repo, ["log", "-1", "--format=%B"]);
  assert.match(message, /^chore\(pi-fixture\): import .+@[0-9a-f]{7} verbatim/);
  assert.match(message, /Co-Authored-By: Test <t@t>$/);
  assert.deepEqual(git(repo, ["show", "--name-only", "--format=", "HEAD"]).split("\n").sort(), [
    "extensions/pi-fixture/.github/workflows/ci.yml",
    "extensions/pi-fixture/.gitignore",
    "extensions/pi-fixture/CHANGELOG.md",
    "extensions/pi-fixture/LICENSE",
    "extensions/pi-fixture/bin/run.sh",
    "extensions/pi-fixture/dist/out.js",
    "extensions/pi-fixture/entry.ts",
    "extensions/pi-fixture/package-lock.json",
    "extensions/pi-fixture/package.json",
    "extensions/pi-fixture/src/index.ts",
  ]);
  assert.ok(lstatSync(join(repo, "extensions/pi-fixture/entry.ts")).isSymbolicLink());

  // Integration changes are left in the working tree, uncommitted.
  const dir = join(repo, "extensions/pi-fixture");
  assert.equal(existsSync(join(dir, ".github")), false);
  assert.equal(existsSync(join(dir, "package-lock.json")), false);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.publishConfig, undefined);
  assert.deepEqual(pkg.files, ["src", "UPSTREAM.md", "CHANGELOG.md"]);
  const sha = git(upstream, ["rev-parse", "HEAD"]);
  const upstreamMd = readFileSync(join(dir, "UPSTREAM.md"), "utf8");
  assert.ok(upstreamMd.includes(sha));
  assert.ok(upstreamMd.includes(git(upstream, ["rev-parse", "HEAD^{tree}"])));
  const changelog = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /^# Changelog/);
  assert.doesNotMatch(changelog, /Upstream changelog/);
  const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  assert.deepEqual(manifest.workspaces, ["extensions/pi-fixture"]);
  assert.deepEqual(manifest.pi.extensions, [
    "./extensions/pi-first/src/index.ts",
    "./extensions/pi-fixture/src/index.ts",
  ]);
  assert.match(git(repo, ["status", "--porcelain"]), / M package\.json/);
});

void test("imports a monorepo package and copies the repository license", (t) => {
  const base = fixture(t);
  const upstream = upstreamRepo(base, "packages/fixture", { licenseAtRoot: true });
  const repo = targetRepo(base);
  const result = runImport(repo, ["--source", upstream, "--subdir", "packages/fixture"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    git(repo, ["rev-parse", "HEAD:extensions/pi-fixture"]),
    git(upstream, ["rev-parse", "HEAD:packages/fixture"]),
  );
  // The license is not in the package's tree, so it arrives with the integration.
  assert.equal(readFileSync(join(repo, "extensions/pi-fixture/LICENSE"), "utf8"), "MIT License\n");
  assert.match(git(repo, ["status", "--porcelain"]), /\?\? extensions\/pi-fixture\/LICENSE/);
});

void test("refuses an unreviewed license and staged changes without writing anything", (t) => {
  const base = fixture(t);
  const upstream = upstreamRepo(base, "", { license: "GPL-3.0" });
  const repo = targetRepo(base);
  const license = runImport(repo, ["--source", upstream]);
  assert.notEqual(license.status, 0);
  assert.match(license.stderr, /license is GPL-3\.0/);
  assert.equal(existsSync(join(repo, "extensions/pi-fixture")), false);

  write(repo, { "notes.md": "staged\n" });
  git(repo, ["add", "notes.md"]);
  const staged = runImport(repo, ["--source", upstream, "--allow-license"]);
  assert.notEqual(staged.status, 0);
  assert.match(staged.stderr, /something is staged/);
  assert.equal(existsSync(join(repo, "extensions/pi-fixture")), false);
});
