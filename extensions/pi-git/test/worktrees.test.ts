import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { worktreeStatus } from "../src/git.ts";
import {
  atRisk,
  branchSlug,
  describeStatus,
  createWorktree,
  findWorktrees,
  isLive,
  removeWorktree,
  within,
  worktreePath,
} from "../src/worktrees.ts";
import { addRemote, commit, run, sandbox, type Sandbox } from "./support/repos.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox(onTestFinished);
});

const create = (options: {
  repo?: string;
  branch: string;
  base?: string;
  workspace?: string;
  cwd?: string;
}) =>
  createWorktree({
    cwd: options.cwd ?? box.dir,
    root: box.root,
    repo: options.repo,
    branch: options.branch,
    base: options.base,
    workspace: options.workspace,
    now: 1_000,
  });

const branches = (repo: string) =>
  run(repo, "branch", "--format=%(refname:short)").trim().split("\n");

describe("paths", () => {
  it("names a worktree <repo>/<branch slug>, or <workspace>/<repo>", () => {
    expect(branchSlug("feat/login/v2")).toBe("feat-login-v2");
    expect(worktreePath("/root", "api", "feat/login")).toBe("/root/api/feat-login");
    expect(worktreePath("/root", "api", "feat/login", "auth")).toBe("/root/auth/api");
  });

  it("tells whether a path is inside another", () => {
    expect(within("/a/b", "/a/b")).toBe(true);
    expect(within("/a/b", "/a/b/c")).toBe(true);
    expect(within("/a/b", "/a/bc")).toBe(false);
    expect(within("/a/b", "/a")).toBe(false);
    expect(within("/a/b", "/a/b/..c")).toBe(true);
  });
});

describe("createWorktree", () => {
  it("creates a new branch from the repository's HEAD", async () => {
    const head = run(box.api, "rev-parse", "HEAD").trim();
    const record = await create({ repo: "src/api", branch: "feat/login" });
    expect(record).toEqual({
      v: 1,
      kind: "worktree",
      path: join(box.root, "api", "feat-login"),
      repo: box.api,
      branch: "feat/login",
      base: { ref: "main", sha: head },
      agents: [],
      state: "active",
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(run(record.path, "branch", "--show-current").trim()).toBe("feat/login");
    expect(branches(box.api)).toContain("feat/login");
  });

  it("defaults to the repository the session is in, even from a subdirectory", async () => {
    mkdirSync(join(box.api, "lib"));
    const record = await create({ cwd: join(box.api, "lib"), branch: "fix" });
    expect(record.repo).toBe(box.api);
  });

  it("resolves a linked worktree to its main repository", async () => {
    const first = await create({ repo: "src/api", branch: "one" });
    const second = await create({ cwd: first.path, branch: "two" });
    expect(second.repo).toBe(box.api);
    expect(second.path).toBe(join(box.root, "api", "two"));
  });

  it("checks out an existing branch as it is, protecting only later work", async () => {
    run(box.api, "branch", "existing");
    run(box.api, "checkout", "-q", "existing");
    const tip = commit(box.api, "a.txt", "a");
    run(box.api, "checkout", "-q", "main");
    const record = await create({ repo: "src/api", branch: "existing" });
    expect(record.base).toEqual({ ref: "main", sha: tip });
    expect(run(record.path, "rev-parse", "HEAD").trim()).toBe(tip);
  });

  it("starts a new branch from base", async () => {
    const first = run(box.api, "rev-parse", "HEAD").trim();
    commit(box.api, "b.txt", "b");
    const record = await create({ repo: "src/api", branch: "from-old", base: first });
    expect(record.base).toEqual({ ref: first, sha: first });
    expect(run(record.path, "rev-parse", "HEAD").trim()).toBe(first);
  });

  it("checks out a branch that exists on exactly one remote", async () => {
    addRemote(box.api, box.dir);
    run(box.api, "checkout", "-q", "-b", "shared");
    const tip = commit(box.api, "s.txt", "s");
    run(box.api, "push", "-q", "origin", "shared");
    run(box.api, "checkout", "-q", "main");
    run(box.api, "branch", "-D", "shared");
    const record = await create({ repo: "src/api", branch: "shared" });
    expect(run(record.path, "rev-parse", "HEAD").trim()).toBe(tip);
  });

  it("refuses base for a branch that already exists", async () => {
    run(box.api, "branch", "taken");
    await expect(create({ repo: "src/api", branch: "taken", base: "main" })).rejects.toThrow(
      /already exists; omit base/,
    );
  });

  it("refuses a base that names no commit, an invalid branch, and a non-repository", async () => {
    await expect(create({ repo: "src/api", branch: "x", base: "nope" })).rejects.toThrow(
      /names no commit/,
    );
    await expect(create({ repo: "src/api", branch: "bad..name" })).rejects.toThrow(
      /not a valid branch name/,
    );
    await expect(create({ repo: ".", branch: "x" })).rejects.toThrow(/not inside a git repository/);
  });

  it("refuses a branch already checked out elsewhere and leaves no empty directory", async () => {
    await expect(create({ repo: "src/api", branch: "main" })).rejects.toThrow();
    expect(existsSync(join(box.root, "api"))).toBe(false);
  });

  it("groups worktrees of several repositories in one workspace", async () => {
    const api = await create({ repo: "src/api", branch: "feat/auth", workspace: "auth" });
    const web = await create({ repo: "src/web", branch: "feat/auth", workspace: "auth" });
    expect(api.path).toBe(join(box.root, "auth", "api"));
    expect(web.path).toBe(join(box.root, "auth", "web"));
    expect(api.workspacePath).toBe(join(box.root, "auth"));
    expect(web.workspacePath).toBe(join(box.root, "auth"));
    expect(api.workspace).toBe("auth");
    expect(run(web.path, "branch", "--show-current").trim()).toBe("feat/auth");
  });

  it("refuses a second worktree of the same repository in a workspace, and a bad workspace name", async () => {
    await create({ repo: "src/api", branch: "one", workspace: "auth" });
    await expect(create({ repo: "src/api", branch: "two", workspace: "auth" })).rejects.toThrow(
      /already has a worktree of api/,
    );
    await expect(create({ repo: "src/api", branch: "x", workspace: "../escape" })).rejects.toThrow(
      /single directory name/,
    );
  });
});

describe("status", () => {
  it("counts uncommitted changes, commits on no remote, and merges into the base", async () => {
    const record = await create({ repo: "src/api", branch: "work" });
    expect(await worktreeStatus(record.path, record.base)).toEqual({
      dirty: false,
      detached: 0,
      unpushed: 0,
      merged: false,
    });

    writeFileSync(join(record.path, "new.txt"), "x");
    const dirty = await worktreeStatus(record.path, record.base);
    expect(dirty.dirty).toBe(true);
    expect(atRisk(dirty)).toBe("uncommitted changes");

    commit(record.path, "new.txt", "x");
    commit(record.path, "more.txt", "y");
    const status = await worktreeStatus(record.path, record.base);
    expect(status).toEqual({ dirty: false, detached: 0, unpushed: 2, merged: false });
    // The branch is kept on removal, so committed work is never at risk.
    expect(atRisk(status)).toBeUndefined();
    expect(describeStatus(status, "main")).toBe("2 commits on no remote");

    addRemote(box.api, box.dir);
    run(record.path, "push", "-q", "origin", "work");
    expect((await worktreeStatus(record.path, record.base)).unpushed).toBe(0);

    run(box.api, "merge", "-q", "--ff-only", "work");
    const merged = await worktreeStatus(record.path, record.base);
    expect(merged.merged).toBe(true);
    expect(describeStatus(merged, "main")).toBe("merged into main");
  });

  it("counts commits only a detached HEAD holds as at risk", async () => {
    const record = await create({ repo: "src/api", branch: "work" });
    run(record.path, "checkout", "-q", "--detach");
    commit(record.path, "loose.txt", "x");
    const status = await worktreeStatus(record.path, record.base);
    expect(status.detached).toBe(1);
    expect(atRisk(status)).toBe("1 commit on no branch");
  });

  it("without a base, counts every commit no remote has", async () => {
    const record = await create({ repo: "src/api", branch: "work" });
    expect((await worktreeStatus(record.path, {})).unpushed).toBe(1);
    expect(atRisk({ dirty: true, detached: 2, unpushed: 1, merged: false })).toBe(
      "uncommitted changes and 2 commits on no branch",
    );
    expect(describeStatus({ dirty: false, detached: 0, unpushed: 0, merged: false })).toBe("clean");
  });
});

describe("removeWorktree", () => {
  const remove = (record: Awaited<ReturnType<typeof create>>, force?: boolean) =>
    removeWorktree({
      path: record.path,
      repo: record.repo,
      base: record.base,
      root: box.root,
      force,
    });

  it("removes a clean worktree, keeps its branch, and drops empty directories", async () => {
    const record = await create({ repo: "src/api", branch: "done" });
    await remove(record);
    expect(existsSync(record.path)).toBe(false);
    expect(existsSync(join(box.root, "api"))).toBe(false);
    expect(branches(box.api)).toContain("done");
  });

  it("refuses to lose uncommitted changes unless forced", async () => {
    const record = await create({ repo: "src/api", branch: "wip" });
    writeFileSync(join(record.path, "wip.txt"), "x");
    await expect(remove(record)).rejects.toThrow(
      /has uncommitted changes, which removing it would lose/,
    );
    expect(existsSync(record.path)).toBe(true);
    const status = await remove(record, true);
    expect(status?.dirty).toBe(true);
    expect(existsSync(record.path)).toBe(false);
    expect(branches(box.api)).toContain("wip");
  });

  it("counts untracked files even when the repository hides them from status", async () => {
    const record = await create({ repo: "src/api", branch: "hidden" });
    run(box.api, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(record.path, "important.txt"), "keep me");
    expect((await worktreeStatus(record.path, record.base)).dirty).toBe(true);
    await expect(remove(record)).rejects.toThrow(/has uncommitted changes/);
    expect(existsSync(join(record.path, "important.txt"))).toBe(true);
  });

  it("removes a worktree whose work is committed but unpushed, keeping it on the branch", async () => {
    const record = await create({ repo: "src/api", branch: "committed" });
    const tip = commit(record.path, "c.txt", "c");
    const status = await remove(record);
    expect(status?.unpushed).toBe(1);
    expect(run(box.api, "rev-parse", "committed").trim()).toBe(tip);
  });

  it("keeps a workspace directory while another repository's worktree is in it", async () => {
    const api = await create({ repo: "src/api", branch: "ws", workspace: "auth" });
    const web = await create({ repo: "src/web", branch: "ws", workspace: "auth" });
    await remove(api);
    expect(existsSync(join(box.root, "auth"))).toBe(true);
    await remove(web);
    expect(existsSync(join(box.root, "auth"))).toBe(false);
  });

  it("prunes a worktree deleted outside Pi", async () => {
    const { rmSync } = await import("node:fs");
    const record = await create({ repo: "src/api", branch: "gone" });
    rmSync(record.path, { recursive: true, force: true });
    expect(await isLive(record.path)).toBe(false);
    await remove(record);
    expect(run(box.api, "worktree", "list")).not.toContain(record.path);
  });
});

describe("findWorktrees", () => {
  it("finds worktrees under the root that the ledger does not name", async () => {
    const known = await create({ repo: "src/api", branch: "known" });
    const other = await create({ repo: "src/web", branch: "other", workspace: "ws" });
    mkdirSync(join(box.root, "plain", "dir"), { recursive: true });
    const found = await findWorktrees(box.root, new Set([known.path]));
    expect(found).toEqual([{ path: other.path, repo: box.web, branch: "other" }]);
    expect(await findWorktrees(join(box.dir, "missing"), new Set())).toEqual([]);
  });
});
