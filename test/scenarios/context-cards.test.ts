/**
 * After a compaction, and again after a resume, the next request carries one
 * card per extension with state: tasks, stash entries, worktrees and the
 * subagents this session started. None is duplicated.
 *
 * The stash, git and roster cards are written into the transcript once after
 * the compaction, so they keep their place before the prompt that followed it;
 * pi-todo's card is context-only and comes last.
 */
import { expect, it } from "vitest";
import {
  agentId,
  capture,
  cards,
  defineScenario,
  lastResult,
  onlyRun,
  type ScriptedSession,
  session,
  startAgent,
  tool,
  untilMessages,
} from "#test/support/session";
import { repository } from "#test/support/repo";

const CARDS = ["git:context", "stash:context", "subagent:roster", "todo:context"];
/** The cards written into the transcript after a compaction. */
const WRITTEN = ["git:context", "stash:context", "subagent:roster"];

/** The cards of the first request the model received after `since` requests. */
function cardsAfter(pi: ScriptedSession, since: number) {
  const request = pi.requests()[since];
  expect(request, "no request after the restore").toBeDefined();
  return cards(request!);
}

it("restores each card once after compaction and after resume", async () => {
  const pi = await session({
    cwd: repository(),
    scenario: defineScenario({
      replies: [
        [
          [tool("todo_upsert", { tasks: [{ key: "ship", subject: "Ship the login change" }] })],
          [tool("stash_put", { name: "plan", content: "1. change login\n2. ship\n" })],
          [tool("git_worktree_create", { branch: "feat/login" })],
          (messages) => [
            startAgent({
              type: "general-purpose",
              description: "Change login",
              prompt: "Change the login form in your worktree.",
              options: { cwd: capture(lastResult(messages, "git_worktree_create"), /cwd: "(.+)"/) },
              steps: ["Changed it."],
            }),
          ],
          "Started.",
        ],
        // The completion message starts the next turn.
        ["Noted."],
      ],
      // Compaction drops earlier turns, so later replies are keyed by prompt.
      prompts: {
        "After compaction": ["Carry on."],
        "After resume": ["Carried on."],
      },
    }),
  });

  await pi.prompt("Start the login change");
  const id = agentId(onlyRun(pi, "subagent_start").text);
  const worktree = capture(onlyRun(pi, "git_worktree_create").text, /^Created worktree (\S+)/);
  await untilMessages(pi, "subagent:completion");

  for (const restore of ["compaction", "resume"] as const) {
    const since = pi.requests().length;
    if (restore === "compaction") await pi.compact();
    else await pi.resume();
    await pi.prompt(restore === "compaction" ? "After compaction" : "After resume");

    const found = cardsAfter(pi, since);
    expect([...found.keys()].sort(), restore).toEqual(CARDS);
    for (const type of CARDS) expect(found.get(type), `${restore}: ${type}`).toHaveLength(1);
    expect(found.get("todo:context")![0]).toContain("Ship the login change");
    expect(found.get("stash:context")![0]).toContain("stash:plan@");
    expect(found.get("git:context")![0]).toContain(worktree);
    expect(found.get("subagent:roster")![0]).toContain(id);
    // Every restore finds the cards the compaction wrote: none is written again.
    expect(found.get("subagent:roster")![0]).toContain("restored after compaction");
    const messages = pi.requests()[since]!.messages;
    const prompt = messages.findIndex(
      (message) => message.role === "user" && JSON.stringify(message).includes("After compaction"),
    );
    for (const type of WRITTEN) {
      const at = messages.findIndex(
        (message) => message.role === "custom" && message.customType === type,
      );
      expect(at, `${restore}: ${type}`).toBeLessThan(prompt);
    }
    expect(messages.at(-1)).toMatchObject({ role: "custom", customType: "todo:context" });
  }
});
