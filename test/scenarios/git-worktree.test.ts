/**
 * A subagent started in a worktree the parent created is recorded in the
 * parent's ledger (pi-git hearing pi-subagent's child-session event).
 */
import { expect, it } from "vitest";
import {
  agentId,
  capture,
  childRuns,
  customMessages,
  defineScenario,
  lastResult,
  onlyRun,
  session,
  startAgent,
  tool,
  untilMessages,
} from "../support/session.ts";
import { git, repository } from "../support/repo.ts";

it("records the subagent that ran in a worktree", async () => {
  const repo = repository();
  const pi = await session({
    cwd: repo,
    scenario: defineScenario({
      replies: [
        [
          [tool("git_worktree_create", { branch: "feat/login" })],
          // The path is only known once the worktree exists.
          (messages) => [
            startAgent({
              type: "general-purpose",
              description: "Work in the worktree",
              prompt: "Make the login change in your worktree.",
              options: { cwd: capture(lastResult(messages, "git_worktree_create"), /cwd: "(.+)"/) },
              steps: [[tool("bash", { command: "git branch --show-current && pwd" })], "Done."],
            }),
          ],
          "Started.",
        ],
        // The completion message starts the next turn.
        [[tool("git_worktree_list", {})], "Listed."],
      ],
    }),
  });

  await pi.prompt("Delegate the login change");
  const created = onlyRun(pi, "git_worktree_create");
  const path = capture(created.text, /^Created worktree (\S+) on branch feat\/login/);
  expect(git(repo, "worktree", "list")).toContain(path);
  const id = agentId(onlyRun(pi, "subagent_start").text);
  await untilMessages(pi, "subagent:completion");
  // The child ran on the worktree's branch, in the worktree.
  const [bash] = childRuns(customMessages(pi, "subagent:completion")[0]!);
  expect(bash?.text.trim().split("\n")).toEqual(["feat/login", path]);

  const list = onlyRun(pi, "git_worktree_list");
  const worktrees = (list.details as { worktrees: { path: string; agents: string[] }[] }).worktrees;
  expect(worktrees).toEqual([expect.objectContaining({ path, agents: [expect.any(String)] })]);
  expect(worktrees[0]!.agents[0]!.startsWith(id)).toBe(true);
  expect(list.text).toContain(`- ${path}`);
  expect(list.text).toMatch(/agents: \w+/);
});
