import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toolCall } from "../../../packages/pi-test-helpers/src/faux-session.ts";
import { resetSessionTree } from "../../../packages/pi-test-helpers/src/globals.ts";
import { createJobsExtension } from "../../pi-job/src/extension.ts";
import {
  delegate,
  type Parent,
  sendCall,
  startParent,
  untilAnnounced,
} from "./characterization/harness.ts";
import { expectNoUnmanagedRuns, trackChildRuns } from "./helpers/managed-runs.ts";
import { EXTENSIONS, offlineAgentDir } from "./helpers/sdk.ts";

// Roadmap step 11 on real sessions (a scripted model): a session is released only for an agent that
// is done, after its window, and `subagent_send` reopens it from its transcript. An agent waiting
// on work keeps its session however long it waits; the window starts when the work is over.
// Windows are the defaults: 10 minutes once the parent read the result with subagent_get, 12 hours
// otherwise. The sweep is run on demand, as if that much time had passed.

afterEach(resetSessionTree);

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

const released = (h: Parent) => h.seen("subagent:session:disposed");
const text = (request: Context) => JSON.stringify(request.messages);

/** The parent reads the agent's result with subagent_get, which starts the short window. */
async function collect(
  h: Parent,
  id: string,
  child: Parameters<Parent["script"]>[0]["child"] = [],
) {
  h.script({
    parent: [toolCall("subagent_get", { agent_id: id }), fauxAssistantMessage("Read it.")],
    child,
  });
  await h.session.prompt("Collect it");
}

/** Send `message` to the agent and wait for the completion of the run it starts. */
async function sendAndAwait(h: Parent, id: string, message: string, reply: string) {
  const childRequests: Context[] = [];
  const before = h.announcements().length;
  h.script({
    parent: [sendCall(id, message), fauxAssistantMessage("Sent."), fauxAssistantMessage("Noted.")],
    child: [
      (context) => {
        childRequests.push(structuredClone(context));
        return fauxAssistantMessage(reply);
      },
    ],
  });
  await h.session.prompt("Ask the worker");
  await untilAnnounced(h, before + 1);
  return childRequests;
}

describe("releasing a done agent's session, and reopening it with subagent_send", () => {
  it.each([
    ["the parent never read its result: after twelve hours", false, 12 * 60 + 1],
    ["the parent read its result: after ten minutes", true, 11],
  ])(
    "releases the session when %s, and a message reopens the transcript",
    async (_name, read, minutes) => {
      const runs = trackChildRuns();
      const h = await startParent();
      h.script({
        parent: [delegate("Remember the codeword"), fauxAssistantMessage("Started.")],
        child: [fauxAssistantMessage("The codeword is PLOVER.")],
      });
      await h.session.prompt("Delegate");
      await untilAnnounced(h);
      const [id] = h.agentIds();
      if (read) await collect(h, id);

      // Done, so a window applies; short of it the session is kept.
      await h.sweepAfter(minutes - 2);
      expect(released(h)).toHaveLength(0);

      await h.sweepAfter(minutes);
      await vi.waitFor(() => expect(released(h)).toHaveLength(1));
      expect(released(h)[0].data).toMatchObject({ agentId: id });
      expect(h.savedRecord(id)).toMatchObject({ status: "idle", outcome: "completed" });

      // The released agent takes a message: its transcript is reopened and the child sees what it
      // did before, then the new message.
      const [request] = await sendAndAwait(h, id, "What was the codeword?", "It was PLOVER.");
      const seen = text(request);
      expect(seen).toContain("Remember the codeword");
      expect(seen).toContain("The codeword is PLOVER.");
      expect(seen).toContain("What was the codeword?");
      expect(seen.indexOf("The codeword is PLOVER.")).toBeLessThan(
        seen.indexOf("What was the codeword?"),
      );
      expect(h.announcements().at(-1)?.text).toContain("It was PLOVER.");
      expect(h.savedRecord(id)).toMatchObject({
        status: "idle",
        outcome: "completed",
        result: "It was PLOVER.",
      });
      expect(h.errors).toEqual([]);
      expectNoUnmanagedRuns(runs);
    },
    40_000,
  );

  it("releases it again after the reopened run is done, on a fresh window", async () => {
    const h = await startParent();
    h.script({
      parent: [delegate("Work"), fauxAssistantMessage("Started.")],
      child: [fauxAssistantMessage("First answer.")],
    });
    await h.session.prompt("Delegate");
    await untilAnnounced(h);
    const [id] = h.agentIds();
    await h.sweepAfter(13 * 60);
    await vi.waitFor(() => expect(released(h)).toHaveLength(1));

    await sendAndAwait(h, id, "Once more", "Second answer.");
    // The window is measured from the second run's end, not from the first.
    await h.sweepAfter(11 * 60);
    expect(released(h)).toHaveLength(1);
    await h.sweepAfter(13 * 60);
    await vi.waitFor(() => expect(released(h)).toHaveLength(2));
  }, 40_000);
});

describe("an agent waiting on a job keeps its session", () => {
  it("is not released however long it waits; once the job is over and the child is done the window runs, and a message reopens it", async () => {
    const runs = trackChildRuns();
    const dir = offlineAgentDir({ extensions: [EXTENSIONS.fastJobs] });
    const h = await startParent({
      dir,
      extensions: [parentJobs],
      tools: ["job_start", "job_watch"],
    });
    const gate = join(dir, "ci-finished");
    const woken: Context[] = [];
    const wakeRun = (context: Context) => {
      woken.push(structuredClone(context));
      return fauxAssistantMessage("CI passed; review complete.");
    };
    h.script({
      parent: [
        delegate("Review CI"),
        fauxAssistantMessage("Started."),
        fauxAssistantMessage("Noted."),
      ],
      child: [watch(gate), fauxAssistantMessage("Watching CI."), wakeRun],
    });
    await h.session.prompt("Delegate");
    await vi.waitFor(() => expect(h.seen("subagent:waiting")).toHaveLength(1), {
      timeout: 15_000,
    });
    const [id] = h.agentIds();

    // Waiting: a day, then two, of sweeps. Reading its status does not shorten anything either.
    await collect(h, id, [wakeRun]); // the child's remaining script follows into the new phase
    await h.sweepAfter(13 * 60);
    await h.sweepAfter(25 * 60);
    await h.sweepAfter(49 * 60);
    expect(released(h)).toHaveLength(0);

    // The watch matches: the child is woken, answers, and is done.
    writeFileSync(gate, "");
    await untilAnnounced(h);
    expect(text(woken[0])).toContain("Watch j1 matched: CI");
    // Done only now. The days it waited do not count toward the window.
    await h.sweepAfter(11);
    expect(released(h)).toHaveLength(0);
    await h.sweepAfter(11 * 60);
    expect(released(h)).toHaveLength(0);
    await h.sweepAfter(12 * 60 + 1);
    await vi.waitFor(() => expect(released(h)).toHaveLength(1));
    expect(released(h)[0].data).toMatchObject({ agentId: id });

    // And it reopens: it sees the watch it started, the completion, and the new message.
    const [request] = await sendAndAwait(h, id, "Anything else to check?", "Nothing else.");
    const seen = text(request);
    expect(seen).toContain("Watch j1 matched: CI");
    expect(seen).toContain("CI passed; review complete.");
    expect(seen).toContain("Anything else to check?");
    expect(readFileSync(h.savedRecord(id)!.outputFile!, "utf8")).toContain("Nothing else.");
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs);
  }, 60_000);
});
