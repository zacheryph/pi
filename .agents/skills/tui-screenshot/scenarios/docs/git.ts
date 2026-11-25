/** pi-git: worktrees an orchestrator made for its workers, in /git:worktrees. */
import { defineScenario, text, tool } from "#scripted-model/scenario";

export default defineScenario({
  title: "queue-retries",
  replies: [
    [
      [
        text("One worktree per task, so the workers never share a checkout."),
        tool("git_worktree_create", { branch: "feat/queue-backoff" }),
        tool("git_worktree_create", { branch: "feat/dead-letter" }),
      ],
      "Two worktrees are ready for the workers.",
    ],
  ],
});
