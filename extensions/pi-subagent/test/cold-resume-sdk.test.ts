import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi, onTestFinished } from "vitest";
import subagentExtension from "#src/index";
import { readPersistedRecords, SUBAGENT_RECORD_ENTRY } from "#src/persisted-record";
import { offlineAgentDir, scriptSides, spawnChild, capture, lastResult } from "./helpers/sdk.ts";
import { fauxSession, toolCall } from "../../../packages/pi-test-helpers/src/faux-session.ts";

// A real parent session spawns real child sessions through the extension, all
// answered by one scripted faux provider. Every spawn and resume runs in the
// background, so a test waits for the completion message it ends with.

const SWEEP_INTERVAL_MS = 60_000;

let dir: string;
let sweeps: Array<() => void>;

beforeEach(() => {
  dir = offlineAgentDir();
  // Catch the manager's retention sweep, so a test can run it without waiting.
  sweeps = [];
  const realSetInterval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((
    fn: () => void,
    ms: number,
    ...rest: unknown[]
  ) => {
    if (ms === SWEEP_INTERVAL_MS) sweeps.push(fn);
    return realSetInterval(fn, ms, ...rest);
  }) as typeof setInterval);
});

afterEach(() => vi.restoreAllMocks());

async function parent(manager = SessionManager.inMemory(dir)) {
  const events: Array<{ channel: string; data: unknown }> = [];
  const h = await fauxSession({
    cleanup: onTestFinished,
    dir,
    provider: "cold-test",
    models: [{ id: "worker" }],
    sessionManager: manager,
    tools: ["subagent_start", "subagent_get", "subagent_steer"],
    extensions: [
      subagentExtension,
      (pi) => {
        for (const channel of ["subagent:session:disposed", "subagent:resumed"]) {
          pi.events.on(channel, (data) => events.push({ channel, data }));
        }
      },
    ],
  });
  return { ...h, manager, events };
}

const resume = (id: string, prompt: string, extra: Record<string, unknown> = {}) =>
  toolCall("subagent_start", {
    subagent_type: "general-purpose",
    description: "resume",
    prompt: `[child] ${prompt}`,
    resume: id,
    ...extra,
  });

const latestRecord = (manager: SessionManager) => readPersistedRecords(manager.getBranch())[0];

type Harness = Awaited<ReturnType<typeof parent>>;

/**
 * Wait until `count` completion messages are in the parent's transcript and the
 * parent, woken by the last, is idle again.
 */
async function untilAnnounced(h: Harness, count: number) {
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

/** How many completion messages the parent's transcript holds. */
const announcedCount = (h: Harness) =>
  h.manager
    .getEntries()
    .filter(
      (entry) => entry.type === "custom_message" && entry.customType === "subagent:completion",
    ).length;

/** Run a worker to completion; it learns a fact only its transcript can remember. */
async function finishedWorker(h: Harness, extra: Record<string, unknown> = {}) {
  scriptSides(h.faux, {
    parent: [spawnChild("Remember the codeword", extra), fauxAssistantMessage("Started.")],
    child: [fauxAssistantMessage("The codeword is PLOVER.")],
  });
  await h.session.prompt("Delegate");
  await untilAnnounced(h, announcedCount(h) + 1);
  const record = latestRecord(h.manager);
  expect(record).toMatchObject({ status: "idle", outcome: "completed" });
  expect(record.outputFile).toBeTruthy();
  return { id: record.id, transcript: record.outputFile!, record };
}

/** Run the retention sweep past the longest window (nobody read the result) and wait for the release. */
async function forceRelease(h: Harness) {
  const later = Date.now() + 13 * 60 * 60_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(later);
  for (const sweep of sweeps) sweep();
  clock.mockRestore();
  await vi.waitFor(() =>
    expect(h.events.some(({ channel }) => channel === "subagent:session:disposed")).toBe(true),
  );
}

/** Resume in the background and wait for its completion message; returns the child's request and that message. */
async function resumeAndAwait(h: Harness, id: string) {
  const child: Context[] = [];
  const before = announcedCount(h);
  scriptSides(h.faux, {
    parent: [resume(id, "What was the codeword?"), fauxAssistantMessage("Asked.")],
    child: [capture(child, fauxAssistantMessage("It was PLOVER."))],
  });
  await h.session.prompt("Ask the worker");
  await untilAnnounced(h, before + 1);
  const message = h.manager
    .getEntries()
    .filter(
      (entry) => entry.type === "custom_message" && entry.customType === "subagent:completion",
    )
    .at(-1);
  return { child: child[0], result: JSON.stringify(message) };
}

describe("cold resume in a real parent session (offline faux provider)", () => {
  it("continues with earlier context after its session was released", async () => {
    const h = await parent();
    const { id } = await finishedWorker(h);

    await forceRelease(h);
    const { child, result } = await resumeAndAwait(h, id);

    const conversation = JSON.stringify(child.messages);
    expect(conversation).toContain("Remember the codeword.");
    expect(conversation).toContain("The codeword is PLOVER.");
    expect(conversation).toContain("What was the codeword?");
    expect(result).toContain("It was PLOVER.");
    expect(latestRecord(h.manager)).toMatchObject({ id, status: "idle", outcome: "completed" });
    expect(h.errors).toEqual([]);
  }, 30_000);

  it("continues with earlier context after a full reload", async () => {
    const h = await parent();
    const { id, record } = await finishedWorker(h);

    await h.session.reload();
    const { child, result } = await resumeAndAwait(h, id);

    const conversation = JSON.stringify(child.messages);
    expect(conversation).toContain("Remember the codeword.");
    expect(conversation).toContain("The codeword is PLOVER.");
    expect(result).toContain("It was PLOVER.");
    expect(latestRecord(h.manager)).toMatchObject({
      id,
      status: "idle",
      outcome: "completed",
      result: "It was PLOVER.",
      description: record.description,
      model: record.model,
      thinkingLevel: record.thinkingLevel,
      cwd: record.cwd,
      outputFile: record.outputFile,
    });
    expect(h.errors).toEqual([]);
  }, 30_000);

  it("appends to the agent's existing transcript rather than starting a new one", async () => {
    const h = await parent();
    const { id, transcript } = await finishedWorker(h);
    const before = readFileSync(transcript, "utf8");
    const filesBefore = readdirSync(dirname(transcript));

    await h.session.reload();
    await resumeAndAwait(h, id);

    const after = readFileSync(transcript, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toContain("It was PLOVER.");
    expect(readdirSync(dirname(transcript))).toEqual(filesBefore);
    expect(latestRecord(h.manager).outputFile).toBe(transcript);
  }, 30_000);

  it.each([3, 0])(
    "keeps a resolved turn limit of %s after a reload changes the default",
    async (maxTurns) => {
      const settings = join(dir, "subagent.json");
      writeFileSync(settings, JSON.stringify({ defaultMaxTurns: maxTurns }));
      const h = await parent();
      const { id, record } = await finishedWorker(h);
      expect(record.maxTurns).toBe(maxTurns || undefined);
      expect(record.turnBudget?.maxTurns).toBe(maxTurns || undefined);

      writeFileSync(settings, JSON.stringify({ defaultMaxTurns: 20 }));
      await h.session.reload();
      await resumeAndAwait(h, id);

      expect(latestRecord(h.manager).turnBudget?.maxTurns).toBe(maxTurns || undefined);
    },
    30_000,
  );

  it("stays refused when its directory was removed, and names the transcript", async () => {
    const worktree = join(dir, "worktree");
    mkdirSync(worktree);
    const h = await parent();
    const { id, transcript, record } = await finishedWorker(h, { cwd: worktree });
    expect(record.cwd).toBe(worktree);

    rmSync(worktree, { recursive: true });
    await h.session.reload();

    const requests: Context[] = [];
    h.faux.setResponses([
      resume(id, "Keep going"),
      capture(requests, toolCall("subagent_get", { agent_id: id })),
      capture(requests, fauxAssistantMessage("Refused.")),
    ]);
    await h.session.prompt("Ask the worker");

    expect(h.faux.getPendingResponseCount()).toBe(0);
    const refusal = lastResult(requests[0], "subagent_start");
    expect(refusal).toContain("the directory it ran in no longer exists");
    expect(refusal).toContain(transcript);
    // subagent_get reports the same answer, from the same check.
    const report = lastResult(requests[1], "subagent_get");
    expect(report).toContain("Resume: not available, because the directory it ran in");
    expect(report).toContain(`Full transcript available at: ${transcript}`);
    expect(latestRecord(h.manager)).toMatchObject({ id, status: "idle", outcome: "completed" });
  }, 30_000);

  it("reports it resumable from subagent_get and the list once its session is gone", async () => {
    const h = await parent();
    const { id } = await finishedWorker(h);
    await h.session.reload();

    const requests: Context[] = [];
    h.faux.setResponses([
      capture(requests, toolCall("subagent_get", { agent_id: id })),
      capture(requests, toolCall("subagent_get", {})),
      capture(requests, fauxAssistantMessage("Checked.")),
    ]);
    await h.session.prompt("Check on the worker");

    // The roster card, restored after the reload, already says so.
    expect(JSON.stringify(requests[0].messages.at(-1))).toMatch(/completed \d\d:\d\d, resumable/);
    expect(lastResult(requests[1], "subagent_get")).toContain(
      `Resume: available. Call subagent_start with resume: \\"${id}\\"`,
    );
    expect(lastResult(requests[2], "subagent_get")).toMatch(/completed \d\d:\d\d, resumable/);
  }, 30_000);

  it("resumes an agent whose run a reload interrupted", async () => {
    const h = await parent();
    const { transcript, record } = await finishedWorker(h);
    // As the parent saved it while the run was still under way.
    const saved = SessionManager.inMemory(dir);
    saved.appendCustomEntry(SUBAGENT_RECORD_ENTRY, {
      ...record,
      id: "interrupted-1",
      status: "running",
      result: undefined,
      completedAt: undefined,
    });
    const restored = await parent(saved);

    const { child, result } = await resumeAndAwait(restored, "interrupted-1");

    expect(JSON.stringify(child.messages)).toContain("The codeword is PLOVER.");
    expect(result).toContain("It was PLOVER.");
    expect(readFileSync(transcript, "utf8")).toContain("It was PLOVER.");
  }, 30_000);

  it("refuses a live run with still-running, and works as usual once rebuilt", async () => {
    const h = await parent();
    const { id } = await finishedWorker(h);
    await h.session.reload();

    let releaseChild = () => {};
    const childGate = new Promise<void>((done) => {
      releaseChild = done;
    });
    let childAsked = () => {};
    const childRunning = new Promise<void>((done) => {
      childAsked = done;
    });
    const requests: Context[] = [];
    const parentReplies = [
      resume(id, "Keep going"),
      async (context: Context) => {
        await childRunning;
        requests.push(structuredClone(context));
        return resume(id, "And again");
      },
      (context: Context) => {
        requests.push(structuredClone(context));
        return toolCall("subagent_steer", { agent_id: id, message: "Also check the tests." });
      },
      (context: Context) => {
        requests.push(structuredClone(context));
        releaseChild();
        return fauxAssistantMessage("Waiting on the worker.");
      },
    ];
    const childContexts: Context[] = [];
    // Parent and child share one provider and race for its queue, so each step
    // answers whichever of them is asking.
    const answer = async (context: Context) => {
      const isChild = context.messages.some(
        (message) =>
          message.role === "user" && JSON.stringify(message).includes("Remember the codeword."),
      );
      if (isChild) {
        childContexts.push(structuredClone(context));
        childAsked();
        await childGate;
        return fauxAssistantMessage("Picked it back up.");
      }
      const reply = parentReplies.shift() ?? fauxAssistantMessage("Noted.");
      return typeof reply === "function" ? reply(context) : reply;
    };
    h.faux.setResponses(Array.from({ length: 12 }, () => answer));

    await h.session.prompt("Continue the worker");
    await vi.waitFor(() =>
      expect(h.events.some(({ channel }) => channel === "subagent:resumed")).toBe(true),
    );

    expect(lastResult(requests[0], "subagent_start")).toContain("Agent resumed in background.");
    expect(lastResult(requests[1], "subagent_start")).toContain(
      `Agent \\"${id}\\" is still running`,
    );
    expect(lastResult(requests[2], "subagent_steer")).not.toContain("Agent not found");
    // The completion notification reached the parent, as for any background run.
    await vi.waitFor(() =>
      expect(JSON.stringify(h.manager.getEntries())).toContain("subagent:completion"),
    );
    expect(JSON.stringify(childContexts[0].messages)).toContain("The codeword is PLOVER.");
    expect(latestRecord(h.manager)).toMatchObject({ id, result: "Picked it back up." });
  }, 30_000);
});
