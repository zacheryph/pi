import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { findPullRequest, generateChangelogs } from "./update-changelogs.mjs";

const repository = "owner/pi";
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_AUTHOR_DATE: "2026-11-14T23:30:00-06:00",
  GIT_COMMITTER_DATE: "2026-11-14T23:30:00-06:00",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

function write(cwd, path, content) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content);
}

function commit(cwd, files, message, date = env.GIT_COMMITTER_DATE) {
  for (const [path, content] of Object.entries(files)) write(cwd, path, content);
  git(cwd, "add", "-A");
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", message], {
    cwd,
    env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  return git(cwd, "rev-parse", "HEAD");
}

function fixture(t, files = {}, workspaces = ["extensions/a", "packages/b", "test"]) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-changelogs-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-q", "-b", "main");
  commit(cwd, { "package.json": JSON.stringify({ workspaces }), ...files }, "initial");
  return cwd;
}

const generate = (cwd, lookup = () => []) => generateChangelogs({ cwd, repository, lookup });

function apply(cwd, updates) {
  for (const { path, content } of updates) write(cwd, path, content);
}

void test("rebuilds entries while preserving complete dated or undated initial imports", (t) => {
  const legacy = "# Changelog\n\nIntroduction.\n\n## 2026-02-01: Old verbose entry\n\nDetails.\n\n";
  const cwd = fixture(t, {
    "extensions/a/CHANGELOG.md": `${legacy}## Initial import\n\nImported on 2026-01-01.\n\n### Source\n\nPinned revision: abc123.\n`,
    "extensions/a/src.ts": "old",
    "packages/b/CHANGELOG.md": `${legacy}## Initial import\n\nImport date unknown; pinned revision: def456.\n`,
    "packages/b/src.ts": "old",
  });
  commit(cwd, { "extensions/a/src.ts": "new", "packages/b/src.ts": "new" }, "shared change");
  const calls = [];
  const updates = generate(cwd, (id) => {
    calls.push(id);
    return [];
  });
  assert.deepEqual(
    updates.map(({ path }) => path),
    ["extensions/a/CHANGELOG.md", "packages/b/CHANGELOG.md"],
  );
  assert.equal(calls.length, 2);
  assert.match(updates[0].content, /- 2026-11-15: shared change/);
  assert.match(updates[0].content, /- 2026-11-15: initial/);
  assert.match(updates[0].content, /## Initial import\n\nImported on 2026-01-01\./);
  assert.match(updates[1].content, /Import date unknown; pinned revision: def456/);
  assert.match(updates[0].content, /### Source\n\nPinned revision: abc123\./);
  for (const update of updates)
    assert.doesNotMatch(update.content, /Introduction|Old verbose entry|Details\./);
  apply(cwd, updates);
  assert.deepEqual(generateChangelogs({ cwd, repository, rebuild: true, lookup: () => [] }), []);
});

void test("rebuilds through directory renames and retains provenance without an import date", (t) => {
  const cwd = fixture(
    t,
    {
      "extensions/old/package.json": '{"name":"example"}',
      "extensions/old/src.ts": "old",
      "extensions/old/CHANGELOG.md":
        "# Changelog\n\n## Old details\n\nDiscard me.\n\n## Initial import\n\nSource and commit; import date unknown.\n",
    },
    ["extensions/new"],
  );
  commit(cwd, { "extensions/old/src.ts": "new" }, "before rename");
  git(cwd, "mv", "extensions/old", "extensions/new");
  commit(cwd, {}, "rename extension");
  const updates = generate(cwd);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].count, 3);
  assert.match(updates[0].content, /before rename/);
  assert.match(updates[0].content, /rename extension/);
  assert.match(updates[0].content, /## Initial import\n\nSource and commit; import date unknown\./);
  assert.doesNotMatch(updates[0].content, /Imported on|Discard me/);
});

void test("copied manifests do not attribute another workspace's history", (t) => {
  const manifest = '{"name":"example","private":true,"version":"1.0.0"}\n';
  const cwd = fixture(
    t,
    {
      "extensions/old/package.json": manifest,
      "extensions/old/src.ts": "old source",
    },
    ["extensions/old", "extensions/new"],
  );
  commit(
    cwd,
    { "extensions/new/package.json": manifest, "extensions/new/src.ts": "different" },
    "create new workspace",
  );
  commit(cwd, { "extensions/old/src.ts": "changed" }, "only old workspace");
  const update = generate(cwd).find(({ path }) => path === "extensions/new/CHANGELOG.md");
  assert.equal(update.count, 1);
  assert.match(update.content, /create new workspace/);
  assert.doesNotMatch(update.content, /initial|only old workspace/);
});

void test("backfills new logs, shares PR lookups, escapes subjects, and ignores non-workspaces", (t) => {
  const cwd = fixture(t);
  const sha = commit(
    cwd,
    {
      "extensions/a/src.ts": "new",
      "packages/b/src.ts": "new",
      "test/scenario.ts": "new",
    },
    "feat: <tag> [text] *stars* (#42)\ncontinuation\n\nBody is omitted.",
  );
  const calls = [];
  const updates = generate(cwd, (id) => {
    calls.push(id);
    return [
      {
        number: 42,
        merged_at: "today",
        merge_commit_sha: sha,
        base: { ref: "main", repo: { full_name: repository } },
      },
    ];
  });
  assert.deepEqual(
    updates.map(({ path }) => path),
    ["extensions/a/CHANGELOG.md", "packages/b/CHANGELOG.md"],
  );
  assert.deepEqual(calls, [sha]);
  for (const update of updates) {
    assert.equal(update.count, 1);
    assert.ok(
      update.content.includes(
        "feat: &lt;tag\\> \\[text\\] \\*stars\\* ([#42](https://github.com/owner/pi/pull/42))",
      ),
    );
    assert.doesNotMatch(update.content, /continuation|Body is omitted/);
  }
});

void test("retries and later merges do not duplicate entries or skip intervening commits", (t) => {
  const cwd = fixture(t);
  const first = commit(cwd, { "extensions/a/src.ts": "one" }, "first");
  const initial = generate(cwd);
  assert.match(initial[0].content, new RegExp(`/commit/${first}`));
  apply(cwd, initial);
  assert.deepEqual(generate(cwd), []);
  // Simulate code merged after generation but before the changelog PR merges.
  const second = commit(cwd, { "extensions/a/src.ts": "two" }, "second");
  const pending = generate(cwd);
  assert.equal(pending[0].count, 1);
  assert.match(pending[0].content, new RegExp(`/commit/${second}`));
  assert.equal(pending[0].content.match(/: first /g).length, 1);
  assert.match(pending[0].content, /^- [^\n]*: second [^\n]*\n- [^\n]*: first /m);
  apply(cwd, pending);
  commit(cwd, {}, "docs: update weekly changelogs");
  assert.deepEqual(generate(cwd), []);
  commit(cwd, { "extensions/a/src.ts": "three" }, "third");
  const next = generate(cwd);
  assert.equal(next[0].count, 1);
  assert.ok(next[0].content.indexOf(": third ") < next[0].content.indexOf(": second "));
  assert.match(next[0].content, /^- [^\n]*: third [^\n]*\n- [^\n]*: second /m);
  assert.doesNotMatch(next[0].content, /docs: update weekly/);
});

void test("includes each original commit from a normal merge, including old-dated branches", (t) => {
  const cwd = fixture(t);
  commit(cwd, { "extensions/a/src.ts": "base" }, "base");
  apply(cwd, generate(cwd));
  commit(cwd, {}, "changelog");
  git(cwd, "switch", "-qc", "feature");
  commit(cwd, { "extensions/a/src.ts": "feature" }, "feature one", "2026-01-01T00:00:00Z");
  commit(cwd, { "extensions/a/README.md": "docs" }, "feature two", "2026-01-02T00:00:00Z");
  git(cwd, "switch", "-q", "main");
  commit(cwd, { "root.txt": "unrelated" }, "main change");
  git(
    cwd,
    "-c",
    "commit.gpgsign=false",
    "merge",
    "--no-ff",
    "feature",
    "-qm",
    "Merge pull request #9",
  );
  const updates = generate(cwd);
  assert.equal(updates[0].count, 2);
  assert.match(updates[0].content, /feature one/);
  assert.match(updates[0].content, /feature two/);
  assert.doesNotMatch(updates[0].content, /Merge pull request|main change/);
});

void test("deletions and moves affect both workspaces without logging changelog-only commits", (t) => {
  const cwd = fixture(t, { "extensions/a/src.ts": "move me" });
  apply(cwd, generate(cwd));
  commit(cwd, {}, "record baseline");
  mkdirSync(join(cwd, "packages/b"), { recursive: true });
  git(cwd, "mv", "extensions/a/src.ts", "packages/b/src.ts");
  commit(cwd, {}, "move source");
  const updates = generate(cwd);
  assert.deepEqual(
    updates.map(({ path, count }) => ({ path, count })),
    [
      { path: "extensions/a/CHANGELOG.md", count: 1 },
      { path: "packages/b/CHANGELOG.md", count: 1 },
    ],
  );
});

void test("does not skip code when someone manually edits an automated log", (t) => {
  const cwd = fixture(t);
  commit(cwd, { "extensions/a/src.ts": "one" }, "first");
  apply(cwd, generate(cwd));
  commit(cwd, {}, "changelog");
  commit(cwd, { "extensions/a/src.ts": "two" }, "second");
  const path = "extensions/a/CHANGELOG.md";
  const previous = readFileSync(join(cwd, path), "utf8");
  commit(cwd, { [path]: `${previous}\nManual clarification.\n` }, "clarify changelog");
  const updates = generate(cwd);
  assert.equal(updates[0].count, 1);
  assert.match(updates[0].content, /second/);
  assert.match(updates[0].content, /Manual clarification/);
  assert.doesNotMatch(updates[0].content, /clarify changelog/);
});

void test("rejects broken checkpoints and failed lookups without writing files", (t) => {
  const cwd = fixture(t);
  commit(cwd, { "extensions/a/src.ts": "one" }, "first");
  assert.throws(
    () =>
      generate(cwd, () => {
        throw new Error("API failed");
      }),
    /API failed/,
  );
  assert.equal(git(cwd, "status", "--porcelain"), "");
  for (const value of ["bad", "0".repeat(40)]) {
    write(
      cwd,
      "extensions/a/CHANGELOG.md",
      `# Changelog\n\n<!-- changelog:through ${value} -->\n\n`,
    );
    assert.throws(() => generate(cwd));
  }
});

void test("only links merged PRs targeting this repository's default branch", () => {
  const pr = (number, overrides = {}) => ({
    number,
    merged_at: "today",
    merge_commit_sha: "other",
    base: { ref: "main", repo: { full_name: repository } },
    ...overrides,
  });
  const pulls = [
    pr(1, { merged_at: null }),
    pr(2, { base: { ref: "release", repo: { full_name: repository } } }),
    pr(3, { base: { ref: "main", repo: { full_name: "someone/fork" } } }),
    pr(4),
    pr(5, { merge_commit_sha: "sha" }),
  ];
  assert.equal(findPullRequest(pulls, "sha", repository, "main").number, 5);
  assert.equal(findPullRequest(pulls, "old-sha", repository, "main").number, 4);
  assert.equal(findPullRequest(pulls.slice(0, 3), "sha", repository, "main"), undefined);
});
