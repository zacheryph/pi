import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORK_WAKE_PROMPT } from "#src/lifecycle/run";
import { toolCall } from "../../../packages/pi-test-helpers/src/faux-session.ts";
import { resetSessionTree } from "../../../packages/pi-test-helpers/src/globals.ts";
import { createJobsExtension } from "../../pi-job/src/extension.ts";
import { sessionOwners } from "../../pi-job/src/ownership.ts";
import {
  delegate,
  gated,
  sendCall,
  startParent,
  untilAnnounced,
  type Parent,
  type Step,
} from "./characterization/harness.ts";
import { expectNoUnmanagedRuns, trackChildRuns, type RunLog } from "./helpers/managed-runs.ts";
import { RESTORE_TIMEOUT_MS } from "#src/lifecycle/subagent-manager";
import { HANG, type Hang } from "./fixtures/hang-on-reopen.ts";
import workProbe from "./fixtures/work-probe.ts";
import { EXTENSIONS, isChildRequest, offlineAgentDir } from "./helpers/sdk.ts";
import { widgetUi } from "./helpers/widget-ui.ts";

// Roadmap step 12 on real sessions: a parent reload or restart keeps its agents. At the parent's
// `session_start` the agents that held work are reopened without a model run, so the producers of
// that work can take it over: pi-job within its reload handoff, pi-ask always. What nobody can
// take over is lost and reported: in the agent's own transcript, and to the parent in ONE message.
// A restart is simulated the way question-sdk.test.ts does: copy the session files as a kill -9
// leaves them and start a new parent over the copy, with the process-wide pi-job registry emptied.

afterEach(() => {
  resetSessionTree();
  // pi-job's registry is process-wide: one test's owners are not the next one's.
  sessionOwners().clear();
});

const parentJobs = createJobsExtension({
  logRoot: join(tmpdir(), "pi-subagent-test-jobs"),
  minIntervalSeconds: 0.1,
});

const QUESTION = {
  questions: [
    {
      question: "Which database?",
      header: "Storage",
      options: [{ label: "Postgres" }, { label: "SQLite" }],
    },
  ],
};
const ask = () => toolCall("ask", QUESTION);

/** A child's `job_watch` call: runs until `gate` exists. */
const watch = (gate: string, label = "CI") =>
  toolCall("job_watch", {
    check: `test -f '${gate}'`,
    intervalSeconds: 0.1,
    timeoutSeconds: 30,
    label,
  });

const text = (request: Context) => JSON.stringify(request.messages);
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

type Reply = (
  context: Context,
  options?: SimpleStreamOptions,
) => ReturnType<Extract<Step, (...args: never[]) => unknown>> | ReturnType<typeof toolCall>;

/**
 * Answer the parent from `parent`, one step per request, and every child from `child`, which sees
 * the request. Children run concurrently on one provider, so a child's reply is chosen by what its
 * own conversation says, not by the order requests arrive in.
 */
function answer(h: Parent, parent: Step[], child: Reply) {
  h.requests.parent.length = 0;
  h.requests.child.length = 0;
  const steps = [...parent];
  h.faux.setResponses(
    Array.from({ length: 120 }, () => async (context: Context, options?: SimpleStreamOptions) => {
      if (!isChildRequest(context)) {
        h.requests.parent.push(structuredClone(context));
        const step = steps.shift();
        if (!step) return fauxAssistantMessage("Noted.");
        return typeof step === "function" ? step(context, options) : step;
      }
      h.requests.child.push(structuredClone(context));
      return child(context, options);
    }),
  );
}

/** A child that has already made a tool call this run (its conversation holds a tool result). */
const hasToolResult = (context: Context) => context.messages.some((m) => m.role === "toolResult");

async function parentOf(
  options: {
    files?: Record<string, string | object>;
    childExtensions?: string[];
    /** Offer `probe_open` (an item nobody adopts) to the parent and its children. */
    probe?: boolean;
  } = {},
) {
  const runs = trackChildRuns();
  const dir = offlineAgentDir({
    extensions: [
      EXTENSIONS.ask,
      EXTENSIONS.fastJobs,
      EXTENSIONS.subagent,
      ...(options.probe ? [EXTENSIONS.workProbe] : []),
      ...(options.childExtensions ?? []),
    ],
    files: options.files,
  });
  const ui = widgetUi();
  const manager = SessionManager.create(dir, dir);
  const h = await startParent({
    dir,
    manager,
    extensions: [parentJobs, ...(options.probe ? [workProbe] : [])],
    tools: ["job_start", "job_watch", ...(options.probe ? ["probe_open"] : [])],
    bind: { uiContext: ui.uiContext },
  });
  return { h, dir, ui, runs, manager, gate: join(dir, "ci-finished") };
}

/** The process dies: what is on disk now is all the next one has. Returns the copy to start over. */
function crash(p: { manager: SessionManager }): string {
  const file = p.manager.getSessionFile()!;
  const copy = `${file}.crashed-${Date.now()}`;
  copyFileSync(file, copy);
  return copy;
}

/** What the old process leaves behind is gone with it: its sessions, its registry of jobs. */
function afterCrash(p: { h: Parent }) {
  p.h.session.dispose();
  resetSessionTree();
  sessionOwners().clear();
}

/** A new parent process over the copy of the crashed session file. */
async function restart(dir: string, copy: string, runs: RunLog) {
  const ui = widgetUi();
  const manager = SessionManager.open(copy, undefined, dir);
  const h = await startParent({
    dir,
    manager,
    extensions: [parentJobs],
    tools: ["job_start", "job_watch"],
    bind: { uiContext: ui.uiContext },
  });
  return { h, ui, runs, manager };
}

/** The work host records and messages of a transcript file, oldest first. */
function trace(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const entry = JSON.parse(line) as {
        type: string;
        customType?: string;
        data?: { op?: string; reason?: string; label?: string; kind?: string };
      };
      if (entry.type === "custom_message") return [`message:${entry.customType}`];
      if (entry.type === "custom" && entry.customType === "work:item")
        return [
          entry.data?.op === "open"
            ? `open:${entry.data.kind}:${entry.data.label}`
            : `close:${entry.data?.reason}`,
        ];
      return [];
    });
}

const lostMessages = (h: Parent) => h.announcements("subagent:lost");
const hostLost = (h: Parent) =>
  h.manager.getBranch().filter((e) => e.type === "custom_message" && e.customType === "work:lost");

/** Two children: one watches CI, one asks a question; each ends its turn waiting. */
function twoWaiting(p: Awaited<ReturnType<typeof parentOf>>) {
  answer(
    p.h,
    [delegate("Review CI"), delegate("Pick storage"), fauxAssistantMessage("Started both.")],
    (context) => {
      if (JSON.stringify(context.messages).includes("Pick storage"))
        return hasToolResult(context) ? fauxAssistantMessage("(asked)") : ask();
      return hasToolResult(context) ? fauxAssistantMessage("Watching CI.") : watch(p.gate);
    },
  );
}

describe("a parent reload", () => {
  it("keeps a child waiting on a job: still waiting, no model run, and the job's completion wakes it through the limiter", async () => {
    const { h, ui, gate, runs } = await parentOf();
    const childRequests: Context[] = [];
    h.script({
      parent: [
        delegate("Review CI"),
        fauxAssistantMessage("Started."),
        fauxAssistantMessage("Noted."),
      ],
      child: [
        watch(gate),
        fauxAssistantMessage("Watching CI."),
        (context) => {
          childRequests.push(structuredClone(context));
          return fauxAssistantMessage("CI passed; review complete.");
        },
      ],
    });
    await h.session.prompt("Delegate");
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: CI"), { timeout: 15_000 });
    const [id] = h.agentIds();
    expect(h.savedRecord(id)).toMatchObject({
      status: "idle",
      outcome: "completed",
      waitingOn: ["CI"],
    });
    const parentRequests = h.requests.parent.length;
    const childCount = h.requests.child.length;
    const managed = runs.managed;

    await h.session.reload();

    // Still waiting: the same agent and the same watch, and not one model request.
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: CI"), { timeout: 15_000 });
    expect(ui.status()).toBe("1 waiting agent");
    expect(h.requests.child).toHaveLength(childCount);
    expect(h.requests.parent).toHaveLength(parentRequests);
    expect(runs.managed).toBe(managed);
    expect(h.announcements()).toEqual([]);
    expect(lostMessages(h)).toEqual([]); // nothing was lost: nothing is reported
    expect(hostLost(h)).toEqual([]); // the parent's own item for the agent was adopted
    expect(h.savedRecord(id)).toMatchObject({ status: "idle", waitingOn: ["CI"] });

    // The job completes: it wakes the reopened child, which answers and is done. The parent hears once.
    writeFileSync(gate, "");
    await untilAnnounced(h);
    expect(childRequests).toHaveLength(1);
    expect(text(childRequests[0])).toContain("Watch j1 matched: CI");
    expect(text(childRequests[0])).toContain(WORK_WAKE_PROMPT);
    expect(h.announcements()).toHaveLength(1);
    expect(h.announcements()[0].text).toContain("CI passed; review complete.");
    await vi.waitFor(() => expect(h.requests.parent).toHaveLength(parentRequests + 1), {
      timeout: 15_000,
    });
    await settle();
    expect(h.announcements()).toHaveLength(1);
    expect(h.savedRecord(id)).toMatchObject({
      status: "idle",
      outcome: "completed",
      result: "CI passed; review complete.",
    });
    expect(h.savedRecord(id)).not.toHaveProperty("waitingOn");
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs);
    expect(runs.managed).toBe(managed + 1); // the one wake, through the agent and its limiter
  }, 40_000);

  it("wakes the child when its job ended in the gap of the reload, through the limiter", async () => {
    const { h, ui, gate, runs } = await parentOf();
    const childRequests: Context[] = [];
    h.script({
      parent: [
        delegate("Review CI"),
        fauxAssistantMessage("Started."),
        fauxAssistantMessage("Noted."),
      ],
      child: [
        watch(gate),
        fauxAssistantMessage("Watching CI."),
        (context) => {
          childRequests.push(structuredClone(context));
          return fauxAssistantMessage("CI passed in the gap.");
        },
      ],
    });
    await h.session.prompt("Delegate");
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: CI"), { timeout: 15_000 });

    await h.session.reload({
      // Between the old extensions' shutdown and the new ones' session_start.
      beforeSessionStart: async () => {
        writeFileSync(gate, "");
        await settle(400);
      },
    });

    await untilAnnounced(h);
    expect(childRequests).toHaveLength(1);
    expect(text(childRequests[0])).toContain("Watch j1 matched: CI");
    expect(h.announcements()).toHaveLength(1);
    expect(lostMessages(h)).toEqual([]);
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs);
  }, 40_000);

  it("keeps a child waiting on a question: still open, and subagent_send answers it", async () => {
    const { h, ui, runs } = await parentOf();
    const childRequests: Context[] = [];
    h.script({
      parent: [
        delegate("Pick storage"),
        fauxAssistantMessage("Started."),
        fauxAssistantMessage("Noted the question."),
      ],
      child: [ask()],
    });
    await h.session.prompt("Delegate");
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: answer"), { timeout: 15_000 });
    await vi.waitFor(() => expect(h.announcements("subagent:question")).toHaveLength(1));
    await h.session.waitForIdle();
    const [id] = h.agentIds();
    const transcript = h.savedRecord(id)!.outputFile!;
    expect(trace(transcript)).toEqual(["open:question:answer"]);
    const childCount = h.requests.child.length;

    await h.session.reload();

    await vi.waitFor(() => expect(ui.text()).toContain("waiting: answer"), { timeout: 15_000 });
    expect(h.requests.child).toHaveLength(childCount);
    expect(lostMessages(h)).toEqual([]);
    expect(h.announcements("subagent:question")).toHaveLength(1); // the parent is not told again
    expect(trace(transcript)).toEqual(["open:question:answer"]); // still open, not closed or lost

    // The parent answers: the question closes, and the child runs on with the answer.
    h.script({
      parent: [
        sendCall(id, "Use Postgres."),
        fauxAssistantMessage("Answered."),
        fauxAssistantMessage("Noted the result."),
      ],
      child: [
        (context) => {
          childRequests.push(structuredClone(context));
          return fauxAssistantMessage("Using Postgres. Done.");
        },
      ],
    });
    await h.session.prompt("Answer it");
    await untilAnnounced(h);
    expect(childRequests).toHaveLength(1);
    expect(text(childRequests[0])).toContain("Use Postgres.");
    expect(h.announcements()[0].text).toContain("Using Postgres. Done.");
    expect(trace(transcript)).toEqual(["open:question:answer", "close:cancelled"]);
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs);
  }, 40_000);

  it("loses a child's own subagent with the reload: reported once to the parent, written into the child, and the child takes subagent_send", async () => {
    const { h, ui, runs } = await parentOf();
    const worker = gated(fauxAssistantMessage("Parser fixed."));
    type Side = "parent" | "orchestrator" | "worker";
    const sideOf = (context: Context): Side => {
      const prompts = context.messages
        .filter((message) => message.role === "user")
        .map((message) => JSON.stringify(message.content));
      if (prompts.some((prompt) => prompt.includes("[worker]"))) return "worker";
      if (prompts.some((prompt) => prompt.includes("[orchestrator]"))) return "orchestrator";
      return "parent";
    };
    const orchestratorRequests: Context[] = [];
    const queues: Record<Side, Step[]> = {
      parent: [
        toolCall("subagent_start", {
          subagent_type: "orchestrate",
          description: "Coordinate the parser fix",
          prompt: "[orchestrator] Get the parser fixed by a worker, then report.",
        }),
        fauxAssistantMessage("Started."),
      ],
      orchestrator: [
        toolCall("subagent_start", {
          subagent_type: "general-purpose",
          description: "Fix parser",
          prompt: "[worker] Fix the parser.",
        }),
        fauxAssistantMessage("Delegated; waiting for the worker."),
      ],
      worker: [worker.step],
    };
    h.faux.setResponses(
      Array.from({ length: 60 }, () => async (context: Context, options?: SimpleStreamOptions) => {
        const side = sideOf(context);
        if (side === "orchestrator") orchestratorRequests.push(structuredClone(context));
        const reply = queues[side].shift();
        if (!reply) return fauxAssistantMessage("(unscripted)");
        return typeof reply === "function" ? reply(context, options) : reply;
      }),
    );
    await h.session.prompt("Get the parser fixed");
    await worker.started;
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: Fix parser"), { timeout: 15_000 });
    await h.session.waitForIdle();
    const [id] = h.agentIds();
    const transcript = h.savedRecord(id)!.outputFile!;
    expect(trace(transcript).filter((e) => e.startsWith("open:"))).toEqual([
      expect.stringMatching(/^open:subagent:Fix parser \(general-purpose agent /),
    ]);

    await h.session.reload();
    await settle(300);

    // The worker ended with the reload, so the orchestrator lost its item. It holds nothing now,
    // so it is idle, not waiting, and the parent heard of it once.
    expect(ui.text()).not.toContain("waiting");
    const lost = lostMessages(h);
    expect(lost).toHaveLength(1);
    expect(lost[0].text).toContain("Subagent work lost: 1 agent");
    expect(lost[0].text).toContain(`${id} orchestrate "Coordinate the parser fix"`);
    expect(lost[0].text).toMatch(/lost subagent "Fix parser \(general-purpose agent [\w-]+\)"/);
    expect(lost[0].details).toMatchObject({
      agents: [{ id, interrupted: false, waitingOn: [], lost: [{ kind: "subagent" }] }],
    });
    // The parent's item for the agent is closed without a completion: the report is the message.
    expect(h.announcements()).toEqual([]);
    expect(h.seen("subagent:completed")).toEqual([]);
    expect(hostLost(h)).toEqual([]);
    // The orchestrator was told in its own transcript.
    expect(trace(transcript)).toContain("close:lost");
    expect(trace(transcript)).toContain("message:work:lost");
    expect(readFileSync(transcript, "utf8")).toContain("Work lost: 1 item");
    expect(h.savedRecord(id)).toMatchObject({ status: "idle", outcome: "completed" });
    expect(h.savedRecord(id)).not.toHaveProperty("waitingOn");

    // It takes subagent_send, and the next run sees what it lost.
    queues.parent = [
      sendCall(id, "Carry on without the worker"),
      fauxAssistantMessage("Sent."),
      fauxAssistantMessage("Noted."),
    ];
    queues.orchestrator = [fauxAssistantMessage("Carried on.")];
    orchestratorRequests.length = 0;
    await h.session.prompt("Tell it");
    await untilAnnounced(h);
    expect(text(orchestratorRequests[0])).toContain("Work lost: 1 item");
    expect(text(orchestratorRequests[0])).toContain("Carry on without the worker");
    expect(h.announcements()[0].text).toContain("Carried on.");
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs);
  }, 40_000);

  it("ends a run in progress as interrupted, reports it once, and the agent resumes with subagent_send", async () => {
    const { h, runs } = await parentOf();
    const child = gated();
    h.script({
      parent: [delegate("Work"), fauxAssistantMessage("Started.")],
      child: [child.step],
    });
    await h.session.prompt("Delegate");
    await child.started;
    const [id] = h.agentIds();
    expect(h.savedRecord(id)).toMatchObject({ status: "running" });

    await h.session.reload();
    await settle();

    expect(h.savedRecord(id)).toMatchObject({ status: "idle", outcome: "interrupted" });
    const lost = lostMessages(h);
    expect(lost).toHaveLength(1);
    expect(lost[0].text).toContain(`${id} general-purpose "Work": its run was interrupted`);
    expect(h.announcements()).toEqual([]); // no completion for a run that never ended
    expect(hostLost(h)).toEqual([]);

    h.script({
      parent: [
        sendCall(id, "Pick it back up"),
        fauxAssistantMessage("Sent."),
        fauxAssistantMessage("Noted."),
      ],
      child: [fauxAssistantMessage("Picked it back up.")],
    });
    await h.session.prompt("Resume it");
    await untilAnnounced(h);
    expect(h.announcements()[0].text).toContain("Picked it back up.");
    expect(h.savedRecord(id)).toMatchObject({ status: "idle", outcome: "completed" });
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs);
  }, 40_000);

  it("keeps the job of an agent whose run the reload interrupted: interrupted and still waiting, and the job's completion wakes it", async () => {
    const { h, ui, gate, runs } = await parentOf();
    // The child starts a watch, then its model request hangs: a run in progress with a job open.
    const hang = gated();
    const woken: Context[] = [];
    answer(
      h,
      [delegate("Review CI"), fauxAssistantMessage("Started."), fauxAssistantMessage("Heard.")],
      (context, options) => {
        if (JSON.stringify(context.messages).includes(WORK_WAKE_PROMPT)) {
          woken.push(structuredClone(context));
          return fauxAssistantMessage("CI passed after the reload.");
        }
        return hasToolResult(context) ? (hang.step(context, options) as never) : watch(gate);
      },
    );
    await h.session.prompt("Delegate");
    await hang.started;
    const [id] = h.agentIds();
    expect(h.savedRecord(id)).toMatchObject({ status: "running" });

    await h.session.reload();
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: CI"), { timeout: 15_000 });

    // Reported once: its run was interrupted, and it is still waiting on the job the reload kept.
    const lost = lostMessages(h);
    expect(lost).toHaveLength(1);
    expect(lost[0].text).toContain(`${id} general-purpose "Review CI": its run was interrupted`);
    expect(lost[0].text).toContain('still waiting on "CI"');
    expect(lost[0].text).not.toContain("lost watch");
    expect(h.savedRecord(id)).toMatchObject({
      status: "idle",
      outcome: "interrupted",
      waitingOn: ["CI"],
    });
    expect(h.announcements()).toEqual([]);

    writeFileSync(gate, "");
    await untilAnnounced(h);
    expect(woken).toHaveLength(1);
    expect(text(woken[0])).toContain("Watch j1 matched: CI");
    expect(h.announcements()[0].text).toContain("CI passed after the reload.");
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs);
  }, 40_000);

  it("reports an interrupted run once and keeps a waiting agent waiting across a double reload", async () => {
    const { h, ui, gate } = await parentOf();
    const interrupted = gated();
    answer(
      h,
      [delegate("Interrupted"), delegate("Waiting"), fauxAssistantMessage("Started both.")],
      (context, options) => {
        if (JSON.stringify(context.messages).includes("Interrupted"))
          return interrupted.step(context, options) as never;
        return hasToolResult(context) ? fauxAssistantMessage("Watching.") : watch(gate);
      },
    );
    await h.session.prompt("Delegate two");
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: CI"), { timeout: 15_000 });
    await interrupted.started;

    await h.session.reload();
    await settle(300);
    expect(lostMessages(h)).toHaveLength(1);
    await h.session.reload();
    await settle(300);

    // The second reload finds the interrupted agent already settled, and the waiting one waiting.
    expect(lostMessages(h)).toHaveLength(1);
    expect(ui.text()).toContain("waiting: CI");
    expect(h.errors).toEqual([]);
  }, 40_000);

  it("reports a waiting child whose transcript is gone as lost, and refuses a message to it", async () => {
    const { h, ui, gate } = await parentOf();
    h.script({
      parent: [delegate("Review CI"), fauxAssistantMessage("Started.")],
      child: [watch(gate), fauxAssistantMessage("Watching CI.")],
    });
    await h.session.prompt("Delegate");
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: CI"), { timeout: 15_000 });
    const [id] = h.agentIds();
    rmSync(h.savedRecord(id)!.outputFile!);

    await h.session.reload();
    await settle(300);

    const lost = lostMessages(h);
    expect(lost).toHaveLength(1);
    expect(lost[0].text).toContain(`${id} general-purpose "Review CI"`);
    expect(lost[0].text).toContain('lost "CI"');
    expect(ui.text()).not.toContain("waiting");
    expect(h.savedRecord(id)).toMatchObject({ status: "idle" });
    expect(h.savedRecord(id)).not.toHaveProperty("waitingOn");
    expect(h.errors).toEqual([]);
  }, 40_000);

  it("reopens many agents without a run, and without taking a slot; their wakes go through the limiter", async () => {
    const { h, ui, gate, runs } = await parentOf({
      files: { "subagent.json": { maxConcurrent: 2 } },
    });
    const count = 6;
    answer(
      h,
      [
        ...Array.from({ length: count }, (_, i) => delegate(`Review CI ${i}`)),
        fauxAssistantMessage("Started all."),
      ],
      (context) => {
        if (JSON.stringify(context.messages).includes(WORK_WAKE_PROMPT))
          return fauxAssistantMessage("CI passed.");
        return hasToolResult(context) ? fauxAssistantMessage("Watching CI.") : watch(gate);
      },
    );
    await h.session.prompt("Delegate many");
    await vi.waitFor(() => expect(ui.status()).toBe(`${count} waiting agents`), {
      timeout: 30_000,
    });
    const managed = runs.managed;
    const starts = h.seen("subagent:started").length;
    const childCount = h.requests.child.length;

    await h.session.reload();

    await vi.waitFor(() => expect(ui.status()).toBe(`${count} waiting agents`), {
      timeout: 30_000,
    });
    // No run was admitted or started for any of them: nothing queued, nothing running.
    expect(runs.managed).toBe(managed);
    expect(h.requests.child).toHaveLength(childCount);
    expect(h.seen("subagent:started")).toHaveLength(starts);
    expect(h.seen("subagent:resuming")).toEqual([]);
    expect(h.seen("subagent:queued")).toEqual([]);
    expect(lostMessages(h)).toEqual([]);

    // Their wakes go through the limiter, and they all finish.
    writeFileSync(gate, "");
    await untilAnnounced(h, count);
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs);
  }, 60_000);
});

describe("a child that hangs while it is reopened", () => {
  it("does not hold the parent's startup past the bound: it is reported as not reopened, its record is kept, the late session is disposed, and subagent_send reopens it", async () => {
    // The bound is 20 s: shorten that one timer, nothing else.
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) =>
        realSetTimeout(fn, ms === RESTORE_TIMEOUT_MS ? 300 : ms, ...rest)) as typeof setTimeout);
    const slots = globalThis as Record<symbol, Hang | undefined>;
    const p = await parentOf({ childExtensions: [EXTENSIONS.hangOnReopen] });
    const { h, ui } = p;
    // Restored after the spy: `startParent` mocks `setInterval` on the same global, not this one.
    const release = Promise.withResolvers<void>();
    const cleanup = () => {
      release.resolve();
      slots[HANG] = undefined;
      spy.mockRestore();
    };
    try {
      twoWaiting(p);
      await h.session.prompt("Delegate two");
      await vi.waitFor(() => expect(ui.text()).toContain("waiting: CI"), { timeout: 15_000 });
      await vi.waitFor(() => expect(ui.text()).toContain("waiting: answer"), { timeout: 15_000 });
      await h.session.waitForIdle();
      const [ci, storage] = h.agentIds();
      const ciFile = h.savedRecord(ci)!.outputFile!;
      const hang: Hang = {
        sessionId: SessionManager.open(ciFile).getSessionId(),
        release: release.promise,
        taken: false,
        shutdowns: 0,
      };
      slots[HANG] = hang;
      const started = Date.now();

      await h.session.reload(); // returns: the hung child cannot hold it

      expect(Date.now() - started).toBeLessThan(10_000);
      // The other child came back, waiting on its question.
      await vi.waitFor(() => expect(ui.text()).toContain("waiting: answer"), { timeout: 15_000 });
      expect(ui.text()).not.toContain("waiting: CI");
      // The hung one is reported, once, as not reopened: its work is not claimed lost.
      const lost = lostMessages(h);
      expect(lost).toHaveLength(1);
      expect(lost[0].text).toContain(`${ci} general-purpose "Review CI"`);
      expect(lost[0].text).toContain("could not be reopened at startup");
      expect(lost[0].text).not.toContain("lost watch");
      expect(lost[0].text).not.toContain(storage);
      expect(hostLost(h)).toEqual([]);
      // Its record is untouched, so a later send can reopen it (and the next start tries again).
      expect(h.savedRecord(ci)).toMatchObject({ status: "idle", waitingOn: ["CI"] });

      // The session finishes starting after all: it is disposed, not attached, and it publishes
      // nothing (its id is the live agent's to reopen).
      const disposedAfterReload = h.seen("subagent:session:disposed").length;
      release.resolve();
      await vi.waitFor(() => expect(hang.shutdowns).toBe(1), { timeout: 15_000 });
      await settle(300);
      expect(hang.shutdowns).toBe(1); // disposed once
      expect(h.seen("subagent:session:disposed")).toHaveLength(disposedAfterReload);
      expect(ui.text()).not.toContain("waiting: CI");

      // subagent_send reopens it and runs it.
      const requests: Context[] = [];
      answer(
        h,
        [
          sendCall(ci, "Check CI by hand"),
          fauxAssistantMessage("Sent."),
          fauxAssistantMessage("Noted."),
        ],
        (context) => {
          requests.push(structuredClone(context));
          return fauxAssistantMessage("Checked by hand.");
        },
      );
      await h.session.prompt("Look at CI");
      await untilAnnounced(h);
      expect(text(requests[0])).toContain("Check CI by hand");
      expect(h.announcements()[0].text).toContain("Checked by hand.");
      expect(h.errors).toEqual([]);
    } finally {
      cleanup();
    }
  }, 60_000);
});

describe("a child session that arrives late, after subagent_send reopened its transcript", () => {
  /** A transcript's entries, as written. */
  const entriesOf = (file: string) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            id?: string;
            parentId?: string | null;
            customType?: string;
            data?: { op?: string; reason?: string };
          },
      );

  it.each(["before", "after"])(
    "leaves the transcript alone when it arrives %s the new run ends: one branch, one work:lost, the new exchange on it",
    async (order) => {
      const realSetTimeout = globalThis.setTimeout;
      const spy = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) =>
          realSetTimeout(fn, ms === RESTORE_TIMEOUT_MS ? 300 : ms, ...rest)) as typeof setTimeout);
      const slots = globalThis as Record<symbol, Hang | undefined>;
      // The child waits on an item nobody adopts: after a reopen it is lost, which is what a stale
      // session would write a second report of.
      const p = await parentOf({ childExtensions: [EXTENSIONS.hangOnReopen], probe: true });
      const { h, ui } = p;
      const release = Promise.withResolvers<void>();
      try {
        h.script({
          parent: [delegate("Review CI"), fauxAssistantMessage("Started.")],
          child: [toolCall("probe_open", { label: "Gate" }), fauxAssistantMessage("Waiting.")],
        });
        await h.session.prompt("Delegate");
        await vi.waitFor(() => expect(ui.text()).toContain("waiting: Gate"), { timeout: 15_000 });
        const [id] = h.agentIds();
        const file = h.savedRecord(id)!.outputFile!;
        const hang: Hang = {
          sessionId: SessionManager.open(file).getSessionId(),
          release: release.promise,
          taken: false,
          shutdowns: 0,
        };
        slots[HANG] = hang;

        await h.session.reload(); // gives up on the hung child after the bound
        expect(lostMessages(h)).toHaveLength(1);
        expect(lostMessages(h)[0].text).toContain("could not be reopened at startup");

        // The parent sends it a message: the transcript is reopened in a session of its own.
        const newRun = gated(fauxAssistantMessage("Checked by hand."));
        const seen: Context[] = [];
        answer(
          h,
          [
            sendCall(id, "Check CI by hand"),
            fauxAssistantMessage("Sent."),
            fauxAssistantMessage("Noted."),
          ],
          (context, options) => {
            seen.push(structuredClone(context));
            return (
              order === "before"
                ? newRun.step(context, options)
                : fauxAssistantMessage("Checked by hand.")
            ) as never;
          },
        );
        await h.session.prompt("Look at CI");
        if (order === "before") {
          await newRun.started;
          // The late session finishes starting while the new run is in progress.
          release.resolve();
          await vi.waitFor(() => expect(hang.shutdowns).toBe(1), { timeout: 15_000 });
          await settle(300);
          newRun.release();
          await untilAnnounced(h);
        } else {
          await untilAnnounced(h);
          await settle(300);
          release.resolve();
          await vi.waitFor(() => expect(hang.shutdowns).toBe(1), { timeout: 15_000 });
          await settle(300);
        }
        expect(h.announcements()[0].text).toContain("Checked by hand.");
        expect(hang.shutdowns).toBe(1);

        // Nothing the late session did is in the transcript: no fork, no second lost report.
        const entries = entriesOf(file).filter((entry) => entry.type !== "session");
        const parents = new Set(entries.map((entry) => entry.parentId));
        const leaves = entries.filter((entry) => entry.id && !parents.has(entry.id));
        expect(leaves).toHaveLength(1);
        expect(
          entries.filter((e) => e.type === "custom_message" && e.customType === "work:lost"),
        ).toHaveLength(1);
        expect(
          entries.filter(
            (e) => e.type === "custom" && e.customType === "work:item" && e.data?.reason === "lost",
          ),
        ).toHaveLength(1);
        // The new exchange is on the branch the next reopen would continue.
        const branch = JSON.stringify(SessionManager.open(file).getBranch());
        expect(branch).toContain("Check CI by hand");
        expect(branch).toContain("Checked by hand.");
        expect(text(seen[0])).toContain("Check CI by hand");
        expect(h.errors).toEqual([]);
      } finally {
        release.resolve();
        slots[HANG] = undefined;
        spy.mockRestore();
      }
    },
    60_000,
  );
});

describe("a parent restart", () => {
  it("reports lost jobs and subagents in one message, adopts questions, and the agents are idle and take subagent_send", async () => {
    const p = await parentOf();
    const { h, ui } = p;
    twoWaiting(p);
    await h.session.prompt("Delegate two");
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: CI"), { timeout: 15_000 });
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: answer"), { timeout: 15_000 });
    await h.session.waitForIdle();
    const [ci, storage] = h.agentIds();
    const ciFile = h.savedRecord(ci)!.outputFile!;
    const storageFile = h.savedRecord(storage)!.outputFile!;
    expect(trace(ciFile)).toEqual(["open:watch:CI"]);
    expect(trace(storageFile)).toEqual(["open:question:answer"]);

    const copy = crash(p);
    afterCrash(p);

    const before = p.runs.managed;
    const second = await restart(p.dir, copy, p.runs);
    await settle(300);
    const s = second.h;

    // No model run happened at startup, for the parent or for any child.
    expect(s.requests.parent).toHaveLength(0);
    expect(s.requests.child).toHaveLength(0);
    expect(second.runs.managed).toBe(before);
    expectNoUnmanagedRuns(second.runs);

    // The parent heard once: the job is lost, the question is not.
    const lost = lostMessages(s);
    expect(lost).toHaveLength(1);
    expect(lost[0].text).toContain("Subagent work lost: 1 agent");
    expect(lost[0].text).toContain(`${ci} general-purpose "Review CI"`);
    expect(lost[0].text).toContain('lost watch "CI"');
    expect(lost[0].text).not.toContain(storage);
    expect(lost[0].details).toMatchObject({
      agents: [{ id: ci, lost: [{ kind: "watch", label: "CI" }] }],
    });

    // Each agent's transcript says what it lost. The job's was closed lost; the question stayed open.
    expect(trace(ciFile)).toEqual(["open:watch:CI", "close:lost", "message:work:lost"]);
    expect(trace(storageFile)).toEqual(["open:question:answer"]);

    // The agent that lost its work is idle (done); the one with a question is still waiting.
    expect(second.ui.text()).toContain("waiting: answer");
    expect(second.ui.text()).not.toContain("waiting: CI");
    expect(s.savedRecord(ci)).toMatchObject({ status: "idle" });
    expect(s.savedRecord(ci)).not.toHaveProperty("waitingOn");
    expect(s.savedRecord(storage)).toMatchObject({ status: "idle", waitingOn: ["answer"] });
    // The parent's own items were adopted or cancelled: the host reports nothing lost for them.
    expect(hostLost(s)).toEqual([]);

    // Both take subagent_send: the one that lost its job reopens with the loss in its context,
    // and the one with the question gets the answer.
    const childRequests: Context[] = [];
    answer(
      s,
      [
        sendCall(ci, "Check CI by hand"),
        sendCall(storage, "Use Postgres."),
        fauxAssistantMessage("Sent both."),
      ],
      (context) => {
        childRequests.push(structuredClone(context));
        return fauxAssistantMessage(
          text(context).includes("Use Postgres.") ? "Using Postgres." : "Checked by hand.",
        );
      },
    );
    await s.session.prompt("What now?");
    expect(JSON.stringify(s.requests.parent[0].messages)).toContain("Subagent work lost");
    await untilAnnounced(s, 2);
    const forAgent = (needle: string) => childRequests.find((r) => text(r).includes(needle))!;
    expect(text(forAgent("Check CI by hand"))).toContain("Work lost: 1 item");
    expect(text(forAgent("Use Postgres."))).toContain(
      "Your question was sent to the delegating agent",
    );
    expect(trace(storageFile)).toEqual(["open:question:answer", "close:cancelled"]);
    expect(s.errors).toEqual([]);
  }, 60_000);

  it("ends a run in progress as interrupted and resumable", async () => {
    const p = await parentOf();
    const child = gated();
    p.h.script({
      parent: [delegate("Work"), fauxAssistantMessage("Started.")],
      child: [child.step],
    });
    await p.h.session.prompt("Delegate");
    await child.started;
    const [id] = p.h.agentIds();
    const copy = crash(p);
    afterCrash(p);

    const before = p.runs.managed;
    const second = await restart(p.dir, copy, p.runs);
    await settle(300);
    const s = second.h;
    expect(s.requests.child).toHaveLength(0);
    expect(second.runs.managed).toBe(before); // reporting it started no run
    const lost = lostMessages(s);
    expect(lost).toHaveLength(1);
    expect(lost[0].text).toContain(`${id} general-purpose "Work": its run was interrupted`);
    expect(s.savedRecord(id)).toMatchObject({ status: "idle", outcome: "interrupted" });

    s.script({
      parent: [
        sendCall(id, "Pick it back up"),
        fauxAssistantMessage("Sent."),
        fauxAssistantMessage("Noted."),
      ],
      child: [fauxAssistantMessage("Picked it back up.")],
    });
    await s.session.prompt("Resume it");
    await untilAnnounced(s);
    expect(s.announcements()[0].text).toContain("Picked it back up.");
    expect(s.errors).toEqual([]);
  }, 40_000);

  it("reopens an interrupted agent that had started a job, and reports the job lost with the interruption", async () => {
    const p = await parentOf();
    const { h, gate } = p;
    // The child starts a watch, then its model request hangs: the run is in progress with a job open.
    const hang = gated();
    answer(h, [delegate("Review CI"), fauxAssistantMessage("Started.")], (context, options) =>
      hasToolResult(context) ? (hang.step(context, options) as never) : watch(gate),
    );
    await h.session.prompt("Delegate");
    await hang.started;
    const [id] = h.agentIds();
    expect(h.savedRecord(id)).toMatchObject({ status: "running" });
    const file = h.savedRecord(id)!.outputFile!;
    expect(trace(file)).toEqual(["open:watch:CI"]);
    const copy = crash(p);
    afterCrash(p);

    const before = p.runs.managed;
    const second = await restart(p.dir, copy, p.runs);
    await settle(300);
    const lost = lostMessages(second.h);
    expect(lost).toHaveLength(1);
    expect(lost[0].text).toContain("its run was interrupted");
    expect(lost[0].text).toContain('lost watch "CI"');
    expect(trace(file)).toContain("close:lost");
    expect(second.h.savedRecord(id)).toMatchObject({ status: "idle", outcome: "interrupted" });
    expect(second.h.requests.child).toHaveLength(0);
    expect(second.runs.managed).toBe(before);
  }, 40_000);
});

describe("a parent shutdown for another reason", () => {
  it.each(["quit", "new", "resume", "fork"])(
    "with reason %s leaves a waiting child's work open, and the next start reports the job lost and adopts the question",
    async (reason) => {
      const p = await parentOf();
      const { h, ui } = p;
      twoWaiting(p);
      await h.session.prompt("Delegate two");
      await vi.waitFor(() => expect(ui.text()).toContain("waiting: CI"), { timeout: 15_000 });
      await vi.waitFor(() => expect(ui.text()).toContain("waiting: answer"), { timeout: 15_000 });
      await h.session.waitForIdle();
      const [ci, storage] = h.agentIds();
      const ciFile = h.savedRecord(ci)!.outputFile!;
      const storageFile = h.savedRecord(storage)!.outputFile!;

      // The session ends. Nothing is stopped or called off; the children's extensions are told
      // `quit` (their jobs die), not `reload` (pi-job would keep them for a reopened session).
      const runner = (
        h.session as unknown as { extensionRunner: { emit(event: unknown): Promise<unknown> } }
      ).extensionRunner;
      await runner.emit({ type: "session_shutdown", reason });
      expect(trace(ciFile)).toEqual(["open:watch:CI"]);
      expect(trace(storageFile)).toEqual(["open:question:answer"]);
      expect(readFileSync(ciFile, "utf8")).not.toContain("Work called off");
      expect(h.seen("subagent:session:disposed")).toHaveLength(2);
      expect(h.savedRecord(ci)).toMatchObject({ status: "idle", waitingOn: ["CI"] });
      expect(h.announcements()).toEqual([]); // nothing was stopped, so nobody was told so
      expect(sessionOwners().size).toBe(0); // pi-job kept nothing for a reload that is not one

      const copy = crash(p);
      afterCrash(p);
      const before = p.runs.managed;
      const second = await restart(p.dir, copy, p.runs);
      await settle(300);
      expect(second.runs.managed).toBe(before);
      const lost = lostMessages(second.h);
      expect(lost).toHaveLength(1);
      expect(lost[0].text).toContain('lost watch "CI"');
      expect(trace(storageFile)).toEqual(["open:question:answer"]);
      expect(second.ui.text()).toContain("waiting: answer");
    },
    60_000,
  );
});
