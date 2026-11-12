import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toolCall, resetSessionTree } from "#test-helpers";
import { createJobsExtension } from "#job";
import { delegate, sendCall, startParent, untilAnnounced } from "#test/characterization/harness";
import { expectNoUnmanagedRuns, trackChildRuns } from "#test/helpers/managed-runs";
import { EXTENSIONS, offlineAgentDir } from "#test/helpers/sdk";

// Roadmap step 11 on real sessions: when a run ends without finishing (it failed) and the agent
// still held work, the work is cancelled and the session released. The agent is told so with one
// message in its own transcript before the release (it starts no run), so a reopened agent does
// not believe it will be woken for a job that was killed. An agent that held no work is told
// nothing.

afterEach(resetSessionTree);

const parentJobs = createJobsExtension({
  logRoot: join(tmpdir(), "pi-subagent-test-jobs"),
  minIntervalSeconds: 0.1,
});

const watch = (gate: string, label = "CI") =>
  toolCall("job_watch", {
    check: `test -f '${gate}'`,
    intervalSeconds: 0.1,
    timeoutSeconds: 30,
    label,
  });

const failure = () =>
  fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider fell over" });

async function parentWithJobs() {
  const runs = trackChildRuns();
  const dir = offlineAgentDir({ extensions: [EXTENSIONS.fastJobs] });
  const h = await startParent({ dir, extensions: [parentJobs], tools: ["job_start", "job_watch"] });
  return { h, runs, gate: join(dir, "ci-finished") };
}

/** The custom messages and work records of a child's transcript, oldest first. */
function trace(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const entry = JSON.parse(line) as {
        type: string;
        customType?: string;
        data?: { op?: string; reason?: string; kind?: string };
      };
      if (entry.type === "custom_message") return [`message:${entry.customType}`];
      if (entry.type === "custom" && entry.customType === "work:item")
        return [
          entry.data?.op === "open" ? `open:${entry.data.kind}` : `close:${entry.data?.reason}`,
        ];
      return [];
    });
}

const text = (request: Context) => JSON.stringify(request.messages);

describe("an agent whose run failed with work open", () => {
  it("is told its watch was called off, once and before it is released; a later send reopens it with that message in context", async () => {
    const { h, runs, gate } = await parentWithJobs();
    h.script({
      parent: [
        delegate("Review CI"),
        fauxAssistantMessage("Started."),
        fauxAssistantMessage("Noted."),
      ],
      child: [watch(gate), failure()],
    });
    await h.session.prompt("Delegate");
    await untilAnnounced(h);
    const [id] = h.agentIds();
    expect(h.announcements()[0].text).toContain("provider fell over");
    await vi.waitFor(() => expect(h.seen("subagent:session:disposed")).toHaveLength(1));
    const transcript = h.savedRecord(id)!.outputFile!;

    // In the child's own transcript: the item opened and was cancelled, and the one message says
    // so. No lost message, and nothing ran for it (the model was asked twice: the call, the error).
    const written = trace(transcript);
    expect(written.filter((entry) => entry === "message:work:called-off")).toHaveLength(1);
    expect(written.filter((entry) => entry.startsWith("close:"))).toEqual(["close:cancelled"]);
    expect(written).not.toContain("message:work:lost");
    expect(h.requests.child).toHaveLength(2);

    // The job is gone with the session: finishing later wakes nothing.
    writeFileSync(gate, "");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(h.requests.child).toHaveLength(2);
    expect(h.seen("subagent:resuming")).toEqual([]);

    // The parent's message reopens the child, which sees the called-off notice first.
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
    const seen = text(reopened[0]);
    expect(seen.match(/Work called off/g)).toHaveLength(1);
    expect(seen).toContain('watch \\"CI\\"');
    expect(seen).toContain("nothing will wake you");
    expect(seen).not.toContain("Work lost");
    expect(seen.indexOf("Work called off")).toBeLessThan(seen.indexOf("Try again later"));
    // And the reopen added no second notice, nor a lost message.
    const after = trace(transcript);
    expect(after.filter((entry) => entry === "message:work:called-off")).toHaveLength(1);
    expect(after).not.toContain("message:work:lost");
    expect(h.errors).toEqual([]);
    expectNoUnmanagedRuns(runs);
  }, 40_000);

  it("is told nothing when it held no work, and keeps its session for the window", async () => {
    const { h } = await parentWithJobs();
    h.script({
      parent: [delegate("Do it"), fauxAssistantMessage("Started."), fauxAssistantMessage("Noted.")],
      child: [failure()],
    });
    await h.session.prompt("Delegate");
    await untilAnnounced(h);
    const [id] = h.agentIds();
    await h.sweepAfter(1);
    expect(h.seen("subagent:session:disposed")).toEqual([]);
    expect(trace(h.savedRecord(id)!.outputFile!)).not.toContain("message:work:called-off");

    // Released later by the window, it is still not told anything on reopen.
    await h.sweepAfter(13 * 60);
    await vi.waitFor(() => expect(h.seen("subagent:session:disposed")).toHaveLength(1));
    expect(trace(h.savedRecord(id)!.outputFile!)).not.toContain("message:work:called-off");
  }, 40_000);
});
