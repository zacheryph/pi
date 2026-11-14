import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import subagentExtension from "#src/index";
import {
  readPersistedRecords,
  type PersistedSubagentRecord,
  SUBAGENT_RECORD_ENTRY,
} from "#src/persisted-record";
import {
  offlineAgentDir,
  EXTENSIONS,
  scriptSides,
  spawnChild,
  capture,
  lastResult,
  agentIdIn,
} from "#test/helpers/sdk";
import { fauxSession, toolCall, toolResults } from "#test-helpers";

// A real parent session loads this extension and spawns real child sessions
// through it, all answered by one scripted faux provider. Every spawn runs in
// the background, so a test waits for the completion message it ends with.

const CARD = "Subagents started by this session";

let dir: string;

// Children read their settings (and pi-ask) from here.
beforeEach(() => {
  dir = offlineAgentDir({ extensions: [EXTENSIONS.ask] });
});

async function parent(manager = SessionManager.inMemory(dir)) {
  const h = await fauxSession({
    cleanup: onTestFinished,
    dir,
    provider: "records-test",
    models: [{ id: "worker" }],
    sessionManager: manager,
    settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
    tools: ["subagent_start", "subagent_get"],
    extensions: [subagentExtension],
  });
  return { ...h, manager };
}

/** How many roster cards this request carries (the card reaches the model as a user turn). */
const cards = (context: Context) =>
  context.messages.filter((message) => JSON.stringify(message).includes(CARD)).length;

/** The agent IDs subagent_start returned on the current branch, oldest first. */
const spawnedIds = (manager: SessionManager) =>
  toolResults(manager, "subagent_start").flatMap((result) => {
    const id = agentIdIn(JSON.stringify(result.content));
    return id ? [id] : [];
  });

/** Wait until the parent holds `count` completion messages and, woken by the last, is idle. */
async function untilCompleted(h: Awaited<ReturnType<typeof parent>>, count: number) {
  await vi.waitFor(
    () =>
      expect(
        h.manager
          .getEntries()
          .filter(
            (entry) =>
              entry.type === "custom_message" && entry.customType === "subagent:completion",
          ),
      ).toHaveLength(count),
    { timeout: 15_000 },
  );
  await h.session.waitForIdle();
}

/** Start a worker and wait for it to finish; the parent's own replies are `Started.`. */
async function delegateAndFinish(
  h: Awaited<ReturnType<typeof parent>>,
  description: string,
  reply: Parameters<typeof scriptSides>[1]["child"] = [],
  count = 1,
) {
  scriptSides(h.faux, {
    parent: [spawnChild(description), fauxAssistantMessage("Started.")],
    child: reply,
  });
  await h.session.prompt(`Delegate ${description}`);
  await untilCompleted(h, count);
}

/** The roster cards written to a session's branch. */
const writtenCards = (manager: SessionManager) =>
  manager
    .getBranch()
    .filter((entry) => entry.type === "custom_message" && entry.customType === "subagent:roster");

describe("subagent records in a real parent session (offline faux provider)", () => {
  it("restores a transcript path from a record captured before the child finishes", async () => {
    const h = await parent();
    let running: PersistedSubagentRecord | undefined;
    await delegateAndFinish(h, "Interrupted work", [
      () => {
        running = readPersistedRecords(h.manager.getBranch())[0];
        return fauxAssistantMessage("finished later");
      },
    ]);
    expect(running).toMatchObject({ status: "running", model: "records-test/worker", cwd: dir });
    expect(running?.outputFile).toBeTruthy();
    const saved = SessionManager.inMemory(dir);
    saved.appendCustomEntry(SUBAGENT_RECORD_ENTRY, running);
    const restored = await parent(saved);
    const requests: Context[] = [];
    restored.faux.setResponses([
      toolCall("subagent_get", { agent_id: running!.id }),
      capture(requests, fauxAssistantMessage("recovered")),
    ]);
    await restored.session.prompt("Recover interrupted work");
    const report = lastResult(requests[0], "subagent_get");
    expect(report).toContain("Status: interrupted");
    expect(report).toContain(`Full transcript available at: ${running!.outputFile}`);
  }, 30_000);

  it("answers subagent_get from the record after a reload, which writes no card", async () => {
    const h = await parent();
    await delegateAndFinish(h, "Map auth", [fauxAssistantMessage("Mapped auth call sites.")]);
    const [id] = spawnedIds(h.manager);
    expect(id).toBeTruthy();
    const statuses = h.manager
      .getBranch()
      .flatMap((entry) =>
        entry.type === "custom" && entry.customType === SUBAGENT_RECORD_ENTRY
          ? [(entry.data as { status: string }).status]
          : [],
      );
    // Every agent is admitted through the queue, so its first step is the queued one.
    expect(statuses).toEqual(["queued", "running", "running", "idle"]);

    await h.session.reload();

    const requests: Context[] = [];
    h.faux.setResponses([
      capture(requests, toolCall("subagent_get", { agent_id: id })),
      capture(requests, toolCall("subagent_get", {})),
      capture(requests, fauxAssistantMessage("Checked.")),
    ]);
    await h.session.prompt("Check on the worker");
    expect(h.faux.getPendingResponseCount()).toBe(0);
    // No compaction: the subagent_start result still names the agent.
    expect(requests.map(cards)).toEqual([0, 0, 0]);
    expect(JSON.stringify(requests[0].messages)).toContain(id!);
    const report = lastResult(requests[1], "subagent_get");
    expect(report).toContain("Mapped auth call sites.");
    expect(report).toContain("Full transcript available at: ");
    expect(report).toContain("Send: available.");
    expect(lastResult(requests[2], "subagent_get")).toContain(
      `- ${id} general-purpose \\"Map auth\\": idle, last run completed`,
    );
    expect(writtenCards(h.manager)).toEqual([]);
    expect(h.errors).toEqual([]);
  }, 30_000);

  // Rewritten by roadmap step 10 (was: "keeps the question a worker ended with across a reload":
  // the question was a field of the saved record, and the roster and `subagent_get` quoted it as
  // "waiting for your answer" after the reload). The question is now a message the parent
  // received when it was asked, so it is in the parent's transcript, and an open item in the
  // worker's own transcript; the saved record carries no question.
  // Rewritten again by roadmap step 12: a reload keeps a waiting agent waiting. The reloaded roster
  // names it `waiting: answer` (it was `idle, last run completed` while a reload still stopped it).
  it("keeps what a worker asked across a reload: in the parent's transcript, still open, and still answerable", async () => {
    const h = await parent();
    scriptSides(h.faux, {
      parent: [
        spawnChild("Pick storage"),
        fauxAssistantMessage("Started."),
        fauxAssistantMessage("Noted the question."),
      ],
      child: [
        toolCall("ask", {
          questions: [
            {
              question: "Which database?",
              header: "Storage",
              options: [{ label: "Postgres" }, { label: "SQLite" }],
            },
          ],
        }),
      ],
    });
    await h.session.prompt("Delegate Pick storage");
    const asked = () =>
      h.manager
        .getEntries()
        .filter(
          (entry) => entry.type === "custom_message" && entry.customType === "subagent:question",
        );
    await vi.waitFor(() => expect(asked()).toHaveLength(1), { timeout: 15_000 });
    await h.session.waitForIdle();
    const [id] = spawnedIds(h.manager);
    expect(JSON.stringify(asked()[0])).toContain("[Storage] Which database?");

    await h.session.reload();

    const requests: Context[] = [];
    h.faux.setResponses([
      capture(requests, toolCall("subagent_get", { agent_id: id })),
      capture(requests, fauxAssistantMessage("Seen.")),
    ]);
    await h.session.prompt("What did it ask?");
    expect(requests).toHaveLength(2);
    // The question the parent was told once is still in its conversation.
    expect(JSON.stringify(requests[0].messages)).toContain("[Storage] Which database?");
    expect(cards(requests[0])).toBe(0);
    const report = lastResult(requests[1], "subagent_get");
    expect(report).not.toContain("waiting on an answer");
    // A live, waiting agent takes a message: the report says it is idle and what it waits on.
    expect(report).toContain("Status: waiting: answer (idle; it wakes when the work reports back");
    expect(readPersistedRecords(h.manager.getBranch())[0]).not.toHaveProperty("pendingQuestion");
  }, 30_000);

  it("follows /tree: an agent spawned after the target point is gone, by ID and from the list", async () => {
    const h = await parent();
    await delegateAndFinish(h, "Kept work", [fauxAssistantMessage("kept")]);
    const target = h.manager.getLeafId()!;
    await delegateAndFinish(h, "Abandoned work", [fauxAssistantMessage("abandoned")], 2);
    const [kept, abandoned] = spawnedIds(h.manager);
    expect(abandoned).toBeTruthy();

    await h.session.navigateTree(target, { summarize: false });

    const requests: Context[] = [];
    h.faux.setResponses([
      capture(requests, toolCall("subagent_get", { agent_id: abandoned })),
      capture(requests, toolCall("subagent_get", {})),
      capture(requests, fauxAssistantMessage("done")),
    ]);
    await h.session.prompt("Where are we?");
    expect(requests).toHaveLength(3);
    // No compaction on the branch: no card, and the kept agent's start result is in context.
    expect(cards(requests[0])).toBe(0);
    expect(JSON.stringify(requests[0].messages)).toContain(kept!);
    // The abandoned agent is still alive in this runtime, but not on this branch.
    expect(lastResult(requests[1], "subagent_get")).toContain(
      `Agent not found: \\"${abandoned}\\"`,
    );
    const listed = lastResult(requests[2], "subagent_get");
    expect(listed).toContain(kept);
    expect(listed).not.toContain(abandoned);
    expect(cards(requests[2])).toBe(0);
  }, 30_000);

  it("shows no card after /tree to before the first spawn", async () => {
    const h = await parent();
    h.faux.setResponses([fauxAssistantMessage("hello")]);
    await h.session.prompt("Hi");
    const target = h.manager.getLeafId()!;
    await delegateAndFinish(h, "Later", [fauxAssistantMessage("done")]);
    await h.session.navigateTree(target, { summarize: false });
    const requests: Context[] = [];
    h.faux.setResponses([capture(requests, fauxAssistantMessage("fine"))]);
    await h.session.prompt("Again");
    expect(requests).toHaveLength(1);
    expect(cards(requests[0])).toBe(0);
  }, 30_000);

  it("writes the card into the transcript once after compaction, before the next prompt", async () => {
    const h = await parent();
    await delegateAndFinish(h, "Index repo", [fauxAssistantMessage("indexed")]);
    h.faux.setResponses([fauxAssistantMessage("more")]);
    await h.session.prompt("More work");
    const [id] = spawnedIds(h.manager);
    h.faux.setResponses([
      fauxAssistantMessage("Compacted summary"),
      fauxAssistantMessage("Prefix"),
    ]);
    await h.session.compact();

    const requests: Context[] = [];
    h.faux.setResponses([
      capture(requests, fauxAssistantMessage("Noted.")),
      capture(requests, fauxAssistantMessage("Still noted.")),
    ]);
    await h.session.prompt("After compaction");
    await h.session.prompt("And again");
    // One card, in the same place in both requests: before the first prompt, not at the end.
    expect(requests.map(cards)).toEqual([1, 1]);
    for (const request of requests) {
      const texts = request.messages.map((message) => JSON.stringify(message));
      const at = texts.findIndex((text) => text.includes(CARD));
      expect(texts[at]).toContain("restored after compaction");
      expect(texts[at]).toContain(
        `${id} general-purpose \\"Index repo\\": idle, last run completed`,
      );
      expect(texts.slice(at + 1).find((text) => text.includes('"role":"user"'))).toContain(
        "After compaction",
      );
    }
    expect(writtenCards(h.manager)).toEqual([expect.objectContaining({ display: false })]);
  }, 30_000);
});
