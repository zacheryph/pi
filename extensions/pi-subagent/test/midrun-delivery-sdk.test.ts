import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createSubagentSession } from "#src/lifecycle/create-subagent-session";
import { WORK_WAKE_PROMPT } from "#src/lifecycle/run";
import { toolCall, clearSlots, resetSessionTree } from "#test-helpers";
import { WorkHostRuntime } from "#work";
import { createJobsExtension } from "#job";
import {
  delegate,
  gated,
  sendCall,
  startParent,
  untilAnnounced,
} from "#test/characterization/harness";
import workProbe, { PROBE, probe } from "#test/fixtures/work-probe";
import { expectNoUnmanagedRuns, trackChildRuns } from "#test/helpers/managed-runs";
import { EXTENSIONS, offlineAgentDir, realChildDeps } from "#test/helpers/sdk";
import { widgetUi } from "#test/helpers/widget-ui";

// Roadmap step 9b on real sessions: what a managed child does with a work message that arrives
// while it runs. Pi holds the message until the end of the turn and the host's
// `agent_before_settle` handler lets the model answer it in the same run, so the child never goes
// idle and waiting for it and never needs a wake run. Every test also checks the invariant of
// step 9: no run begins in a child that its agent did not drive.

afterEach(() => {
  resetSessionTree();
  clearSlots(PROBE);
});

/** The parent loads pi-job and the probe too, so its children inherit their tools. */
const parentJobs = createJobsExtension({
  logRoot: join(tmpdir(), "pi-subagent-test-jobs"),
  minIntervalSeconds: 0.1,
});

/** A parent whose children load the probe and pi-job, and inherit their tools. */
async function parentWithWork() {
  const runs = trackChildRuns();
  const dir = offlineAgentDir({ extensions: [EXTENSIONS.workProbe, EXTENSIONS.fastJobs] });
  const ui = widgetUi();
  const h = await startParent({
    dir,
    extensions: [parentJobs, workProbe],
    tools: ["job_start", "job_watch", "probe_open"],
    bind: { uiContext: ui.uiContext },
  });
  return { h, dir, ui, runs, gate: join(dir, "ci-finished"), seenFile: join(dir, "ci-seen") };
}

/** The text of every message in a model request, so a failed assertion prints something readable. */
const said = (request: Context): string[] =>
  request.messages.flatMap((message) =>
    typeof message.content === "string"
      ? [message.content]
      : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  );
const saying = (part: string) => expect.arrayContaining([expect.stringContaining(part)]);
const open = (label: string) => toolCall("probe_open", { label });
const onTestFinishedDispose = (session: { dispose(): Promise<void> }) =>
  onTestFinished(() => session.dispose());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a completion that arrives while the child runs", () => {
  it("is answered in the same run: no waiting, no wake run", async () => {
    const { h, ui, runs, gate, seenFile } = await parentWithWork();
    const busy = gated(fauxAssistantMessage("Still going."));
    const childRequests: Context[] = [];
    h.script({
      parent: [
        delegate("Review CI"),
        fauxAssistantMessage("Started."),
        fauxAssistantMessage("Noted."),
      ],
      child: [
        toolCall("job_watch", {
          // Leaves a mark when it sees the gate, so the test knows the watch is about to complete.
          check: `if test -f '${gate}'; then touch '${seenFile}'; exit 0; else exit 1; fi`,
          intervalSeconds: 0.1,
          timeoutSeconds: 30,
          label: "CI",
        }),
        busy.step,
        (context) => {
          childRequests.push(structuredClone(context));
          return fauxAssistantMessage("CI passed; review complete.");
        },
      ],
    });
    await h.session.prompt("Delegate");

    // The child is in its second model request, and the watch is open.
    await busy.started;
    writeFileSync(gate, "");
    await vi.waitFor(() => expect(existsSync(seenFile)).toBe(true), { timeout: 15_000 });
    await sleep(400); // the watch completes right after its check exits
    busy.release();
    await untilAnnounced(h);

    // One run: the answer to the completion was the next request of that run.
    expect(h.requests.child).toHaveLength(3);
    expect(said(childRequests[0])).toEqual(saying("Watch j1 matched: CI"));
    expect(said(childRequests[0])).not.toContain(WORK_WAKE_PROMPT);
    expect(h.seen("subagent:waiting")).toEqual([]);
    expect(h.seen("subagent:resuming")).toEqual([]);
    expect(h.announcements()).toHaveLength(1);
    expect(h.announcements()[0].text).toContain("CI passed; review complete.");
    expect(ui.text()).not.toContain("waiting");
    const [id] = h.agentIds();
    expect(h.savedRecord(id)).toMatchObject({ status: "idle", outcome: "completed" });
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs);
    expect(runs.managed).toBe(1);
  }, 40_000);
});

/** Entries of the agent's transcript, as the work records and messages they stand for, oldest first. */
function trace(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const entry = JSON.parse(line) as {
        type: string;
        customType?: string;
        data?: { op?: string; reason?: string; label?: string };
        message?: { role?: string };
      };
      if (entry.type === "custom_message") return [`message:${entry.customType}`];
      if (entry.type === "custom" && entry.customType === "work:item")
        return [
          entry.data?.op === "open" ? `open:${entry.data.label}` : `close:${entry.data?.reason}`,
        ];
      if (entry.type === "message" && entry.message?.role === "assistant") return ["assistant"];
      return [];
    });
}

describe("completions the child's host holds until the end of the turn", () => {
  it("answers two completions that arrive in one run with one more request", async () => {
    const { h, runs } = await parentWithWork();
    const busy = gated(fauxAssistantMessage("Still going."));
    const childRequests: Context[] = [];
    h.script({
      parent: [
        delegate("Run two things"),
        fauxAssistantMessage("Started."),
        fauxAssistantMessage("Noted."),
      ],
      child: [
        open("a"),
        open("b"),
        busy.step,
        (context) => {
          childRequests.push(structuredClone(context));
          return fauxAssistantMessage("Both finished.");
        },
      ],
    });
    await h.session.prompt("Delegate");
    await busy.started;
    probe().complete("a", "RESULT A");
    probe().complete("b", "RESULT B");
    busy.release();
    await untilAnnounced(h);

    expect(h.requests.child).toHaveLength(4);
    expect(said(childRequests[0])).toEqual(expect.arrayContaining(["RESULT A", "RESULT B"]));
    expect(h.seen("subagent:waiting")).toEqual([]);
    expect(h.seen("subagent:resuming")).toEqual([]);
    expect(h.announcements()[0].text).toContain("Both finished.");
    // Each message is in the transcript before the close record that vouches for it.
    const [id] = h.agentIds();
    await vi.waitFor(() =>
      expect(trace(h.savedRecord(id)!.outputFile!).filter((e) => e.startsWith("close"))).toEqual([
        "close:completed",
        "close:completed",
      ]),
    );
    const order = trace(h.savedRecord(id)!.outputFile!);
    expect(order.slice(-5)).toEqual([
      "message:probe:done",
      "message:probe:done",
      "close:completed",
      "close:completed",
      "assistant",
    ]);
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs);
    expect(runs.managed).toBe(1);
  }, 40_000);

  it("answers a completion that arrives while the model is answering the one before", async () => {
    const { h, runs } = await parentWithWork();
    const busy = gated(fauxAssistantMessage("Still going."));
    const requests: Context[] = [];
    h.script({
      parent: [
        delegate("Run two things"),
        fauxAssistantMessage("Started."),
        fauxAssistantMessage("Noted."),
      ],
      child: [
        open("a"),
        open("b"),
        busy.step,
        (context) => {
          requests.push(structuredClone(context));
          probe().complete("b", "RESULT B"); // while this very answer is being produced
          return fauxAssistantMessage("Saw A.");
        },
        (context) => {
          requests.push(structuredClone(context));
          return fauxAssistantMessage("Saw A and B.");
        },
      ],
    });
    await h.session.prompt("Delegate");
    await busy.started;
    probe().complete("a", "RESULT A");
    busy.release();
    await untilAnnounced(h);

    expect(h.requests.child).toHaveLength(5);
    expect(said(requests[0])).toContain("RESULT A");
    expect(said(requests[0])).not.toContain("RESULT B");
    expect(said(requests[1])).toContain("RESULT B");
    expect(h.seen("subagent:resuming")).toEqual([]);
    expect(h.announcements()[0].text).toContain("Saw A and B.");
    expectNoUnmanagedRuns(runs);
    expect(runs.managed).toBe(1);
  }, 40_000);
});

describe("another extension's message after the completion", () => {
  it("does not hide the completion from the run: it is still answered in that run", async () => {
    const { h, runs } = await parentWithWork();
    const busy = gated(fauxAssistantMessage("Still going."));
    const childRequests: Context[] = [];
    h.script({
      parent: [
        delegate("Run it"),
        fauxAssistantMessage("Started."),
        fauxAssistantMessage("Noted."),
      ],
      child: [
        open("a"),
        busy.step,
        (context) => {
          childRequests.push(structuredClone(context));
          return fauxAssistantMessage("Saw the result.");
        },
      ],
    });
    await h.session.prompt("Delegate");
    await busy.started;
    probe().complete("a", "RESULT A");
    probe().sendNote?.("NOTE FROM ELSEWHERE"); // lands after the result, at the end of the turn
    busy.release();
    await untilAnnounced(h);

    // The newest message in the child's context is the note, not the result.
    expect(h.requests.child).toHaveLength(3);
    expect(said(childRequests[0]).slice(-2)).toEqual(["RESULT A", "NOTE FROM ELSEWHERE"]);
    expect(h.seen("subagent:resuming")).toEqual([]);
    expect(h.announcements()[0].text).toContain("Saw the result.");
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs);
    expect(runs.managed).toBe(1);
  }, 40_000);
});

describe("an update that arrives while the child runs", () => {
  it("is answered in the same run and leaves the item open, so the child is still waiting after", async () => {
    const { h, ui, runs } = await parentWithWork();
    const busy = gated(fauxAssistantMessage("Still going."));
    const childRequests: Context[] = [];
    h.script({
      parent: [delegate("Ask around"), fauxAssistantMessage("Started.")],
      child: [
        open("q"),
        busy.step,
        (context) => {
          childRequests.push(structuredClone(context));
          return fauxAssistantMessage("Noted the update; still waiting for the rest.");
        },
      ],
    });
    await h.session.prompt("Delegate");
    await busy.started;
    probe().notify("q", "UPDATE: halfway");
    busy.release();

    await vi.waitFor(() => expect(ui.text()).toContain("waiting: q"), { timeout: 15_000 });
    expect(h.requests.child).toHaveLength(3);
    expect(said(childRequests[0])).toContain("UPDATE: halfway");
    expect(said(childRequests[0])).not.toContain(WORK_WAKE_PROMPT);
    expect(h.seen("subagent:resuming")).toEqual([]);
    expect(h.announcements()).toEqual([]); // not done: the item is still open
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs);
    expect(runs.managed).toBe(1);
  }, 40_000);
});

describe("a message from the parent", () => {
  it("starts a waiting child's next run through the agent, not a run of its own", async () => {
    const { h, ui, runs } = await parentWithWork();
    const requests: Context[] = [];
    h.script({
      parent: [delegate("Wait for it"), fauxAssistantMessage("Started.")],
      child: [open("a"), fauxAssistantMessage("Waiting.")],
    });
    await h.session.prompt("Delegate");
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: a"), { timeout: 15_000 });
    const [id] = h.agentIds();

    h.script({
      parent: [
        sendCall(id, "Give me a status"),
        fauxAssistantMessage("Asked."),
        fauxAssistantMessage("Noted."),
      ],
      child: [
        (context) => {
          requests.push(structuredClone(context));
          return fauxAssistantMessage("Still waiting on a.");
        },
      ],
    });
    await h.session.prompt("Ask it");
    await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 15_000 });
    expect(said(requests[0]).at(-1)).toContain("Give me a status");
    expect(h.seen("subagent:resuming")).toHaveLength(1);
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs);
    expect(runs.managed).toBe(2);
  }, 40_000);
});

describe("a completion that arrives at the end of the run", () => {
  /** The child opens "late" and ends its turn; `arrive` makes the completion come at the end. */
  async function lateChild(arrive: (p: ReturnType<typeof probe>) => void) {
    const parent = await parentWithWork();
    const { h } = parent;
    const requests: Context[] = [];
    h.script({
      parent: [
        delegate("Do the thing"),
        fauxAssistantMessage("Started."),
        fauxAssistantMessage("Noted."),
      ],
      child: [
        open("late"),
        fauxAssistantMessage("All done."),
        (context) => {
          requests.push(structuredClone(context));
          return fauxAssistantMessage("Handled the late result.");
        },
      ],
    });
    arrive(probe());
    await h.session.prompt("Delegate");
    await untilAnnounced(h);
    return { ...parent, requests };
  }

  it("is answered in the same run when it arrives as the last agent_before_settle handlers run", async () => {
    // A host whose handler runs after the completion sees it pending and asks for one more
    // request, as it does for any message that arrives while the run winds down.
    let fired = false;
    const { h, runs, requests } = await lateChild((p) => {
      p.beforeSettle = (event) => {
        if (fired || event.outcome !== "completed") return;
        fired = true;
        p.complete("late", "LATE RESULT");
      };
    });
    expect(h.requests.child).toHaveLength(3);
    expect(said(requests[0])).toContain("LATE RESULT");
    expect(said(requests[0])).not.toContain(WORK_WAKE_PROMPT);
    expect(h.seen("subagent:resuming")).toEqual([]);
    expect(h.announcements()).toHaveLength(1);
    expect(h.announcements()[0].text).toContain("Handled the late result.");
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs);
    expect(runs.managed).toBe(1);
  }, 40_000);

  /** What an agent must do with a message no host saw in time. */
  function expectAnsweredByARunOfItsOwn(done: Awaited<ReturnType<typeof lateChild>>) {
    const { h, runs, requests } = done;
    expect(h.announcements()).toHaveLength(1);
    expect(h.announcements()[0].text).toContain("Handled the late result.");
    expect(h.announcements()[0].text).not.toContain("All done.");
    expect(h.requests.child).toHaveLength(3);
    // The extra run started from the transcript as it stands: the message, then the fixed prompt.
    expect(said(requests[0]).slice(-2)).toEqual(["LATE RESULT", WORK_WAKE_PROMPT]);
    expect(h.seen("subagent:resuming")).toHaveLength(1);
    expect(h.seen("subagent:resumed")).toHaveLength(1);
    expect(h.seen("subagent:completed")).toEqual([]); // the first run never reported done
    const [id] = h.agentIds();
    expect(h.savedRecord(id)).toMatchObject({
      outcome: "completed",
      result: "Handled the late result.",
    });
    const order = trace(h.savedRecord(id)!.outputFile!);
    expect(order.lastIndexOf("assistant")).toBeGreaterThan(order.indexOf("message:probe:done"));
    expect(order).toContain("close:completed");
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs);
    expect(runs.managed).toBe(2); // the first run, and the one that answered the message
  }

  it("is answered by a run of its own when it arrives after the run's last chance to continue", async () => {
    // The model answered and every host's `agent_before_settle` handler found nothing to
    // continue. Then the job finishes, at the moment Pi tells the host the run is over: Pi has
    // stopped streaming, so it appends the message at once, but the host still counts the run as
    // active and records instead of waking, and no request is left in the run to answer it. The
    // agent must not report "done" with the message unanswered.
    const heard = WorkHostRuntime.prototype.agentSettled;
    const hearing = vi.spyOn(WorkHostRuntime.prototype, "agentSettled");
    let fired = false;
    hearing.mockImplementation(function (this: WorkHostRuntime) {
      if (!fired && probe().items.size > 0) {
        fired = true;
        probe().complete("late", "LATE RESULT");
      }
      return heard.call(this);
    });
    onTestFinished(() => hearing.mockRestore());
    expectAnsweredByARunOfItsOwn(await lateChild(() => {}));
    expect(fired).toBe(true);
  }, 40_000);

  it("is answered by a run of its own when it arrives in agent_settled, after the host heard the run ended", async () => {
    // The host already knows the run is over, so it wakes the agent itself (`wakeAfterRun`); this
    // pins that path. The final-settle fix is pinned by the test above, which spies `agentSettled`.
    let fired = false;
    expectAnsweredByARunOfItsOwn(
      await lateChild((p) => {
        p.settled = () => {
          if (fired) return;
          fired = true;
          p.complete("late", "LATE RESULT");
        };
      }),
    );
    expect(fired).toBe(true);
  }, 40_000);
});

describe("a crash between a completion and the end of the turn", () => {
  it("reports the item lost and the result absent, and the live run closes it once the result landed", async () => {
    const { h, dir, runs } = await parentWithWork();
    const busy = gated(fauxAssistantMessage("Still going."));
    h.script({
      parent: [
        delegate("Wait for the thing"),
        fauxAssistantMessage("Started."),
        fauxAssistantMessage("Noted."),
      ],
      child: [open("a"), busy.step, fauxAssistantMessage("Saw it.")],
    });
    await h.session.prompt("Delegate");
    await busy.started;
    probe().complete("a", "RESULT: lost in the crash");
    const file = probe().file!;
    const crashed = join(dir, "crashed.jsonl");
    copyFileSync(file, crashed); // what a kill -9 right now leaves on disk
    busy.release();
    await untilAnnounced(h);

    // The live child closed the item only after the result was in its transcript.
    await vi.waitFor(() => expect(trace(file)).toContain("close:completed"));
    const live = trace(file);
    expect(live.indexOf("message:probe:done")).toBeGreaterThan(-1);
    expect(live.indexOf("close:completed")).toBeGreaterThan(live.indexOf("message:probe:done"));
    expectNoUnmanagedRuns(runs);

    // The crash left the item open and the result out of the transcript.
    expect(trace(crashed)).toContain("open:a");
    expect(trace(crashed)).not.toContain("message:probe:done");
    expect(trace(crashed).some((entry) => entry.startsWith("close"))).toBe(false);

    // A new process opens the child from that file: the item is closed as lost, not as done.
    resetSessionTree();
    const { snapshot, deps } = await realChildDeps(dir, {
      type: "general-purpose",
      provider: "restart",
    });
    const wake = vi.fn();
    const restarted = await createSubagentSession(
      {
        type: "general-purpose",
        snapshot,
        transcriptPath: crashed,
        work: { wake, changed: vi.fn() },
      },
      deps,
    );
    onTestFinishedDispose(restarted);
    expect(trace(crashed)).toContain("close:lost");
    expect(trace(crashed)).not.toContain("close:completed");
    expect(trace(crashed)).not.toContain("message:probe:done");
    expect(trace(crashed)).toContain("message:work:lost");
    const lost = readFileSync(crashed, "utf8");
    expect(lost).toContain("Work lost");
    expect(restarted.openWork()).toEqual([]);
    // Lost work never wakes anything on its own.
    expect(wake).not.toHaveBeenCalled();
    expect(restarted.session.isIdle).toBe(true);
    expect(h.errors).toEqual([]);
  }, 40_000);
});

describe("the guard against unmanaged runs", () => {
  it("sees a run that something other than the agent started in a child", async () => {
    // The harness must be able to fail: a child extension that sends a triggering message starts
    // a run that no agent drives, and the tracker reports it.
    const { h, ui, runs } = await parentWithWork();
    h.script({
      parent: [
        delegate("Wait for the thing"),
        fauxAssistantMessage("Started."),
        fauxAssistantMessage("Noted."),
      ],
      child: [open("a"), fauxAssistantMessage("Waiting."), fauxAssistantMessage("Surprise.")],
    });
    await h.session.prompt("Delegate");
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: a"), { timeout: 15_000 });
    expect(runs.unmanaged).toEqual([]);

    probe().triggerRun?.("go");
    await vi.waitFor(() => expect(h.requests.child).toHaveLength(3), { timeout: 15_000 });
    expect(runs.unmanaged).toEqual(["probe:trigger"]);
    expect(runs.managed).toBe(1);
  }, 40_000);
});
