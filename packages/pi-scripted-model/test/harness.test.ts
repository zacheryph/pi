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

  it("hands a todo to a subagent, then accepts its outcome in the parent's list", async () => {
    open = await startSession({
      scenario: defineScenario({
        replies: [
          [
            [tool("todo_upsert", { tasks: [{ key: "impl", subject: "Implement it" }] })],
            [
              startAgent({
                type: "general-purpose",
                description: "Implement it",
                prompt: "Implement the impl task and report the outcome for parent acceptance.",
                steps: [
                  [
                    tool("todo_upsert", {
                      tasks: [{ key: "impl", status: "in_progress", message: "Implemented." }],
                    }),
                  ],
                  "Implemented.",
                ],
                options: { handoff: { todo: { keys: ["impl"] } } },
              }),
            ],
            "Started.",
          ],
          // The completion message starts the next turn.
          [
            [tool("todo_list", { key: "impl" })],
            [
              tool("todo_upsert", {
                tasks: [{ key: "impl", status: "completed", message: "Verified and accepted." }],
              }),
            ],
            [tool("todo_list", {})],
            "All done.",
          ],
        ],
      }),
    });
    await open.prompt("Do the work");
    const spawn = run(open, "subagent_start");
    expect(spawn.isError, spawn.text).toBe(false);

    await untilCompleted(open);
    expect(completionTexts(open)[0]).toContain("Implemented.");
    const lists = open.toolRuns().filter((result) => result.name === "todo_list");
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(list.isError, list.text).toBe(false);
    expect(JSON.parse(lists[0].text).tasks).toMatchObject([
      {
        key: "impl",
        subject: "Implement it",
        status: "in_progress",
        updates: expect.arrayContaining([
          expect.objectContaining({
            status: "in_progress",
            message: "Implemented.",
            agent: expect.any(String),
          }),
        ]),
      },
    ]);
    expect(JSON.parse(lists[1].text).tasks).toEqual([
      {
        key: "impl",
        subject: "Implement it",
        status: "completed",
        lastMessage: "Verified and accepted.",
      },
    ]);
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
