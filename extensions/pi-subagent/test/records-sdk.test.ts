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
} from "./helpers/sdk.ts";
import {
  fauxSession,
  toolCall,
  toolResults,
} from "../../../packages/pi-test-helpers/src/faux-session.ts";

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

/** The last message of a request, where the card sits when it is sent. */
const tail = (context: Context | undefined) => JSON.stringify(context?.messages.at(-1));

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

  it("answers subagent_get from the record after a reload, and shows the card until a list", async () => {
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
    expect(requests.map(cards)).toEqual([1, 1, 0]);
    expect(tail(requests[0])).toContain("restored after reload");
    expect(tail(requests[0])).toContain(
      `${id} general-purpose \\"Map auth\\": idle, last run completed`,
    );
    const report = lastResult(requests[1], "subagent_get");
    expect(report).toContain("Mapped auth call sites.");
    expect(report).toContain("Full transcript available at: ");
    expect(report).toContain("Send: available.");
    expect(lastResult(requests[2], "subagent_get")).toContain(
      `- ${id} general-purpose \\"Map auth\\": idle, last run completed`,
    );
    // Context-only: the card is never written to the transcript.
    expect(JSON.stringify(h.manager.getEntries())).not.toContain(CARD);
    expect(h.errors).toEqual([]);
  }, 30_000);

  it("keeps the question a worker ended with across a reload", async () => {
    const h = await parent();
    await delegateAndFinish(h, "Pick storage", [
      toolCall("ask", {
        questions: [
          {
            question: "Which database?",
            header: "Storage",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
          },
        ],
      }),
      fauxAssistantMessage("Waiting for the storage decision."),
    ]);
    const [id] = spawnedIds(h.manager);

    await h.session.reload();

    const requests: Context[] = [];
    h.faux.setResponses([
      capture(requests, toolCall("subagent_get", { agent_id: id })),
      capture(requests, fauxAssistantMessage("Seen.")),
    ]);
    await h.session.prompt("What did it ask?");
    expect(requests).toHaveLength(2);
    expect(tail(requests[0])).toContain(
      `${id} general-purpose \\"Pick storage\\": waiting for your answer: \\"[Storage] Which database?`,
    );
    const report = lastResult(requests[1], "subagent_get");
    expect(report).toContain("This agent is waiting on an answer:");
    expect(report).toContain("Which database?");
    expect(report).toContain(`subagent_send with agent_id: \\"${id}\\"`);
  }, 30_000);

  it("follows /tree: an agent spawned after the target point is gone from the list, by ID and on the card", async () => {
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
    expect(tail(requests[0])).toContain("restored after /tree");
    expect(tail(requests[0])).toContain(kept);
    expect(tail(requests[0])).not.toContain(abandoned);
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

  it("ends each request after compaction with the card, sent once", async () => {
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
    // Still due: no list result has arrived since the compaction.
    await h.session.prompt("And again");
    expect(requests.map(cards)).toEqual([1, 1]);
    expect(tail(requests[0])).toContain("restored after compaction");
    expect(tail(requests[0])).toContain(
      `${id} general-purpose \\"Index repo\\": idle, last run completed`,
    );
    expect(JSON.stringify(h.manager.getEntries())).not.toContain(CARD);
  }, 30_000);

  it("loads a session written before records carried the new fields", async () => {
    const manager = SessionManager.inMemory(dir);
    manager.appendMessage({ role: "user", content: "earlier", timestamp: 1 });
    // As the previous release wrote it: terminal only, no question/model/cwd fields.
    manager.appendCustomEntry(SUBAGENT_RECORD_ENTRY, {
      id: "old-agent",
      type: "Explore",
      description: "Old run",
      status: "completed",
      result: "Old result.",
      startedAt: 1_000,
      completedAt: 2_000,
      outputFile: "/tasks/old-agent.jsonl",
      toolUses: 3,
    });
    // Older still: before toolUses, which readers skip.
    manager.appendCustomEntry(SUBAGENT_RECORD_ENTRY, {
      id: "ancient-agent",
      type: "Explore",
      description: "Ancient run",
      status: "completed",
      startedAt: 500,
    });
    const h = await parent(manager);
    const requests: Context[] = [];
    h.faux.setResponses([
      capture(requests, toolCall("subagent_get", { agent_id: "old-agent" })),
      capture(requests, fauxAssistantMessage("ok")),
    ]);
    await h.session.prompt("Status?");
    expect(requests).toHaveLength(2);
    expect(tail(requests[0])).toContain("restored after resume");
    expect(tail(requests[0])).toContain(
      'old-agent Explore \\"Old run\\": idle, last run completed',
    );
    expect(tail(requests[0])).not.toContain("ancient-agent");
    const report = lastResult(requests[1], "subagent_get");
    expect(report).toContain("Old result.");
    expect(report).toContain("Full transcript available at: /tasks/old-agent.jsonl");
    expect(h.errors).toEqual([]);
  }, 30_000);
});
