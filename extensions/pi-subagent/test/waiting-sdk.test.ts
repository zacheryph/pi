import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORK_WAKE_PROMPT } from "#src/lifecycle/run";
import { toolCall } from "../../../packages/pi-test-helpers/src/faux-session.ts";
import { resetSessionTree } from "../../../packages/pi-test-helpers/src/globals.ts";
import { createJobsExtension } from "../../pi-job/src/extension.ts";
import {
  delegate,
  gated,
  sendCall,
  startParent,
  untilAnnounced,
} from "./characterization/harness.ts";
import { expectNoUnmanagedRuns, trackChildRuns } from "./helpers/managed-runs.ts";
import { EXTENSIONS, offlineAgentDir } from "./helpers/sdk.ts";
import { widgetUi } from "./helpers/widget-ui.ts";

// Roadmap step 9a on real sessions: a child that ends its turn with a job running is idle and
// waiting, not done. The job's completion is a message in its transcript, and the manager (through
// the concurrency limiter) gives it the run that answers it. The root shows `waiting: <label>`,
// then done.

afterEach(resetSessionTree);

/** The parent loads pi-job too, so its children inherit `job_watch` as they would for a user. */
const parentJobs = createJobsExtension({
  logRoot: join(tmpdir(), "pi-subagent-test-jobs"),
  minIntervalSeconds: 0.1,
});

/** A child's `job_watch` call: runs until `gate` exists. */
const watch = (gate: string, label = "CI") =>
  toolCall("job_watch", {
    check: `test -f '${gate}'`,
    intervalSeconds: 0.1,
    timeoutSeconds: 30,
    label,
  });

async function parentWithJobs(options: { files?: Record<string, string | object> } = {}) {
  const runs = trackChildRuns();
  const dir = offlineAgentDir({ extensions: [EXTENSIONS.fastJobs], files: options.files });
  const ui = widgetUi();
  const h = await startParent({
    dir,
    extensions: [parentJobs],
    tools: ["job_start", "job_watch"],
    bind: { uiContext: ui.uiContext },
  });
  return { h, dir, ui, runs, gate: join(dir, "ci-finished") };
}

const text = (request: Context) => JSON.stringify(request.messages);

describe("a child that ends its turn with a job running", () => {
  it("is waiting, not done; the job wakes it; it answers and is done", async () => {
    const { h, ui, gate, runs } = await parentWithJobs();
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

    // The child's run ended with the watch open: the root shows it waiting, with the label.
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: CI"), { timeout: 15_000 });
    expect(ui.status()).toBe("1 waiting agent");
    expect(ui.text()).not.toContain("done");
    expect(ui.text()).toContain("--:--"); // no clock runs for a waiting agent
    const [id] = h.agentIds();
    expect(h.seen("subagent:waiting")).toMatchObject([{ data: { id, reason: "CI" } }]);
    // Nothing reached the parent: no completion, no wake, no second run of its own.
    expect(h.seen("subagent:completed")).toEqual([]);
    expect(h.announcements()).toEqual([]);
    expect(h.requests.parent).toHaveLength(2);
    expect(h.requests.child).toHaveLength(2);
    expect(h.savedRecord(id)).toMatchObject({ status: "idle", outcome: "completed" });

    // The job completes. The manager runs the child: one more request, no more.
    writeFileSync(gate, "");
    await untilAnnounced(h);
    // The widget showed it done, and then waiting no more. (A finished agent leaves the widget
    // at the parent's next turn, which the completion starts, so the frames are read.)
    const done = ui.frames.findIndex((frame) => /agent: Review CI .* ✓ done/.test(frame));
    expect(done).toBeGreaterThan(ui.frames.findIndex((frame) => frame.includes("waiting: CI")));
    expect(ui.frames[done]).not.toContain("waiting");
    expect(ui.statuses.at(-1)).toBeUndefined();

    expect(h.requests.child).toHaveLength(3);
    // The run started from the transcript as it stands: the job's completion message is in it,
    // before the fixed prompt that starts the run.
    const seen = text(childRequests[0]);
    expect(seen).toContain("Watch j1 matched: CI");
    expect(seen).toContain(WORK_WAKE_PROMPT);
    expect(seen.indexOf("Watch j1 matched")).toBeLessThan(seen.indexOf(WORK_WAKE_PROMPT));
    expect(h.seen("subagent:resuming")).toHaveLength(1);
    expect(h.seen("subagent:resumed")).toMatchObject([{ data: { id, status: "completed" } }]);
    // The completion is the child's last answer, delivered once.
    expect(h.announcements()).toHaveLength(1);
    expect(h.announcements()[0].text).toContain("CI passed; review complete.");
    await vi.waitFor(() => expect(h.requests.parent).toHaveLength(3), { timeout: 15_000 });
    expect(h.savedRecord(id)).toMatchObject({
      status: "idle",
      outcome: "completed",
      result: "CI passed; review complete.",
    });
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs); // every wake went through the agent and its limiter
  }, 40_000);

  it("is woken through the limiter, behind the agent that holds the only slot", async () => {
    const { h, ui, gate, runs } = await parentWithJobs({
      files: { "subagent.json": { maxConcurrent: 1 } },
    });
    const holder = gated(fauxAssistantMessage("Held, then done."));
    h.script({
      parent: [
        delegate("Review CI"),
        delegate("Holds the slot"),
        fauxAssistantMessage("Started both."),
        fauxAssistantMessage("Noted."),
        fauxAssistantMessage("Noted again."),
      ],
      child: [
        watch(gate),
        fauxAssistantMessage("Watching CI."),
        holder.step,
        fauxAssistantMessage("CI passed."),
      ],
    });
    await h.session.prompt("Start two agents");
    await holder.started;
    const [reviewer, blocker] = h.agentIds();

    // The watcher parked and gave its slot to the second agent.
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: CI"));
    expect(h.requests.child).toHaveLength(3);

    // The job completes while the slot is taken: the message is in the child's transcript, and
    // the child is queued for its run. Nothing ran it around the limiter.
    writeFileSync(gate, "");
    await vi.waitFor(() =>
      expect(h.seen("subagent:queued")).toMatchObject([{ data: { id: reviewer } }]),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.requests.child).toHaveLength(3);
    expect(h.savedRecord(reviewer)).toMatchObject({ status: "queued" });
    expect(ui.text()).not.toContain("waiting: CI");
    expect(h.announcements()).toEqual([]); // the watcher is not done: it has not answered yet

    // The slot frees: the second agent finishes first, then the watcher runs and is done.
    holder.release();
    await untilAnnounced(h, 2);
    const order = h.announcements().map((entry) => entry.details.id);
    expect(order).toEqual([blocker, reviewer]);
    expect(h.requests.child).toHaveLength(4);
    expect(h.announcements()[1].text).toContain("CI passed.");
    await vi.waitFor(() => expect(h.seen("subagent:resuming")).toHaveLength(1));
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs); // every wake went through the agent and its limiter
  }, 40_000);

  it("is stopped with the work it waits on when the user interrupts", async () => {
    const { h, ui, gate, runs } = await parentWithJobs();
    const parentBusy = gated(fauxAssistantMessage("Interrupted."));
    h.script({
      parent: [delegate("Review CI"), fauxAssistantMessage("Started."), parentBusy.step],
      child: [watch(gate), fauxAssistantMessage("Watching CI.")],
    });
    await h.session.prompt("Delegate");
    await vi.waitFor(() => expect(ui.text()).toContain("waiting: CI"), { timeout: 15_000 });

    const run = h.session.prompt("Keep going");
    await parentBusy.started;
    await h.session.abort(); // ESC stops the parent's agents, a waiting one included
    await run.catch(() => {});
    await untilAnnounced(h);
    expect(h.announcements()[0].text).toContain("<status>Stopped (user request)</status>");
    expect(ui.text()).not.toContain("waiting");

    // Its session was released with the watch inside it: the job ending later wakes nothing.
    writeFileSync(gate, "");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(h.requests.child).toHaveLength(2);
    expect(h.seen("subagent:resuming")).toEqual([]);

    // The stop called the watch off: its item is cancelled in the child's transcript, not left
    // open. So when the parent sends the stopped agent a message later, the reopened child sees
    // that message and is not told about work the user deliberately stopped.
    const [id] = h.agentIds();
    const transcript = readFileSync(h.savedRecord(id)!.outputFile!, "utf8");
    expect(transcript).toContain('"reason":"cancelled"');
    const reopened: Context[] = [];
    h.script({
      parent: [
        sendCall(id, "Try again later"),
        fauxAssistantMessage("Sent."),
        fauxAssistantMessage("Noted."),
      ],
      child: [
        (context) => {
          reopened.push(structuredClone(context));
          return fauxAssistantMessage("Starting over.");
        },
      ],
    });
    await h.session.prompt("Send it more");
    await untilAnnounced(h, 2);
    expect(reopened).toHaveLength(1);
    expect(text(reopened[0])).toContain("Try again later");
    expect(text(reopened[0])).not.toContain("Work lost");
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs); // every wake went through the agent and its limiter
  }, 40_000);
});
