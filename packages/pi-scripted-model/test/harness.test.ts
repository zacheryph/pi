import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ScriptedSession, collectToolRuns, startSession } from "#src/harness.ts";
import { defineScenario, startAgent, tool } from "#src/scenario.ts";

let open: ScriptedSession | undefined;
afterEach(async () => {
  await open?.dispose();
  open = undefined;
});

const run = (session: ScriptedSession, name: string) => {
  const found = session.toolRuns().filter((r) => r.name === name);
  expect(found, `no ${name} call ran`).not.toHaveLength(0);
  return found.at(-1)!;
};

/** The text of every subagent completion message in the session, oldest first. */
const completionTexts = (session: ScriptedSession) =>
  session
    .entries()
    .flatMap((entry) =>
      entry.type === "custom_message" && entry.customType === "subagent:completion"
        ? [JSON.stringify(entry.content)]
        : [],
    );

/** Wait for a subagent's completion message, and for the turn it starts to end. */
async function untilCompleted(session: ScriptedSession) {
  await vi.waitFor(() => expect(completionTexts(session)).toHaveLength(1), { timeout: 15_000 });
  await session.session.waitForIdle();
}

describe("startSession", () => {
  it("plays the scenario against the real bundle", async () => {
    open = await startSession({
      scenario: defineScenario({
        replies: [
          [[tool("todo_upsert", { tasks: [{ key: "one", subject: "First task" }] })], "Planned."],
        ],
      }),
    });
    expect(open.extensionErrors).toEqual([]);
    expect(open.session.model?.id).toBe("scripted-model");
    await open.prompt("Plan it");
    expect(open.toolRuns().map((r) => [r.name, r.isError])).toEqual([["todo_upsert", false]]);
    expect(run(open, "todo_upsert").text).toContain("First task");
  });

  it("reports a tool's schema error as a failed run", async () => {
    open = await startSession({
      scenario: defineScenario({ replies: [[[tool("todo_upsert", { nope: 1 })], "Done."]] }),
    });
    await open.prompt("Go");
    expect(run(open, "todo_upsert").isError).toBe(true);
  });

  it("runs a subagent on its own script and announces its result in a completion message", async () => {
    open = await startSession({
      scenario: defineScenario({
        replies: [
          [
            [
              startAgent({
                type: "general-purpose",
                description: "Read the note",
                prompt: "Read note.txt and report what it says.",
                steps: [[tool("read", { path: "note.txt" })], "The note says hello."],
              }),
            ],
            "Started.",
          ],
          // The completion message starts the next turn.
          ["Noted."],
        ],
      }),
    });
    writeFileSync(join(open.cwd, "note.txt"), "hello\n");
    await open.prompt("Delegate the note");
    const spawn = run(open, "subagent_start");
    expect(spawn.isError, spawn.text).toBe(false);
    expect(spawn.text).toContain("Agent started in background.");
    expect(spawn.text).not.toContain("The note says hello.");

    await untilCompleted(open);
    const [completion] = completionTexts(open);
    expect(completion).toContain("<result>The note says hello.</result>");
  });

  it("records each request with its context cards, and compacts and resumes", async () => {
    const scripted = defineScenario({
      replies: [
        [[tool("todo_upsert", { tasks: [{ key: "one", subject: "First task" }] })], "Planned."],
      ],
      prompts: { Again: ["Still here."], "And again": ["Back."] },
      summary: "The user planned one task.",
    });
    const lifecycle: string[] = [];
    open = await startSession({
      scenario: (pi) => {
        scripted(pi);
        pi.on("session_start", (event) => {
          lifecycle.push(`start:${event.reason}`);
        });
        pi.on("session_shutdown", (event) => {
          lifecycle.push(`shutdown:${event.reason}`);
        });
      },
    });
    await open.prompt("Plan it");
    const cardTypes = (index: number) =>
      open!.requests()[index]!.messages.flatMap((m) => (m.role === "custom" ? [m.customType] : []));
    // The todo_upsert result shows the list, so pi-todo adds no card yet.
    expect(open.requests()).toHaveLength(2);
    expect(cardTypes(1)).toEqual([]);

    const compaction = await open.compact();
    expect(compaction.summary).toContain("The user planned one task.");
    await open.prompt("Again");
    // The summary replaced that result, so the list comes back as a card.
    expect(open.requests()[2]!.messages[0]).toMatchObject({ role: "compactionSummary" });
    expect(cardTypes(2)).toEqual(["todo:context"]);

    const file = open.session.sessionFile;
    await open.resume();
    expect(lifecycle).toEqual(["start:startup", "shutdown:resume", "start:resume"]);
    expect(open.session.sessionFile).toBe(file);
    expect(open.extensionErrors).toEqual([]);
    await open.prompt("And again");
    // The resumed session holds the compacted transcript, and replies by prompt.
    expect(open.requests()).toHaveLength(4);
    expect(open.requests()[3]!.messages[0]).toMatchObject({ role: "compactionSummary" });
    expect(open.session.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Back." }],
    });
  });

  it("hides credentials and HOME while open and restores them after", async () => {
    const home = process.env.HOME;
    process.env.FAKE_PROVIDER_API_KEY = "secret";
    try {
      open = await startSession({ scenario: defineScenario({ replies: [] }) });
      expect(process.env.FAKE_PROVIDER_API_KEY).toBeUndefined();
      expect(process.env.HOME).not.toBe(home);
      expect(process.env.PI_CODING_AGENT_DIR).toBe(open.agentDir);
      await open.dispose();
      open = undefined;
      expect(process.env.FAKE_PROVIDER_API_KEY).toBe("secret");
      expect(process.env.HOME).toBe(home);
      expect(process.env.PI_SCRIPTED_MODEL).toBeUndefined();
    } finally {
      delete process.env.FAKE_PROVIDER_API_KEY;
    }
  });

  it("allows one open session per process", async () => {
    open = await startSession({ scenario: defineScenario({ replies: [] }) });
    await expect(startSession({ scenario: defineScenario({ replies: [] }) })).rejects.toThrow(
      /only one session/,
    );
  });
});

describe("collectToolRuns", () => {
  it("pairs each tool call with its result, in call order", () => {
    const runs = collectToolRuns([
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "a", name: "read", arguments: { path: "x" } },
          { type: "toolCall", id: "b", name: "bash", arguments: { command: "ls" } },
        ],
      },
      { role: "toolResult", toolCallId: "b", content: [{ type: "text", text: "files" }] },
      {
        role: "toolResult",
        toolCallId: "a",
        isError: true,
        content: [{ type: "text", text: "missing" }],
        details: { code: 1 },
      },
    ]);
    expect(runs).toEqual([
      { name: "read", args: { path: "x" }, isError: true, text: "missing", details: { code: 1 } },
      { name: "bash", args: { command: "ls" }, isError: false, text: "files", details: undefined },
    ]);
  });
});
