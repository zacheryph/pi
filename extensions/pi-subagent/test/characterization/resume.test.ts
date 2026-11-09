import { readFileSync } from "node:fs";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import { lastResult } from "../helpers/sdk.ts";
import {
  delegate,
  gated,
  type Parent,
  sendCall,
  shape,
  startParent,
  untilAnnounced,
} from "./harness.ts";

// Giving an idle agent more work, through subagent_send. Rewritten by roadmap step 7b: this
// used to be subagent_start with `resume`. The run starts and reports as it did, with the
// same texts; what changed is the door, the refusals (a running agent is steered, not refused)
// and that a stopped or failed agent takes a message like any other idle agent.

const resultText = (request: Context, tool: string) =>
  (JSON.parse(lastResult(request, tool)) as { content: Array<{ text: string }> }).content[0].text;

/** Run an agent to completion; it learns a fact only its transcript can remember. */
async function finishedAgent(h: Parent) {
  h.script({
    parent: [delegate("Remember the codeword"), fauxAssistantMessage("Started.")],
    child: [fauxAssistantMessage("The codeword is PLOVER.")],
  });
  await h.session.prompt("Delegate");
  await untilAnnounced(h);
  const [id] = h.agentIds();
  return { id, transcript: h.savedRecord(id)!.outputFile! };
}

/** Send `id` a question and wait for the second completion message. */
async function resumeAndAwait(h: Parent, id: string) {
  const question: Context[] = [];
  h.script({
    parent: [sendCall(id, "What was the codeword?"), fauxAssistantMessage("Asked.")],
    child: [
      (context) => {
        question.push(structuredClone(context));
        return fauxAssistantMessage("It was PLOVER.");
      },
    ],
  });
  await h.session.prompt("Ask the agent");
  await untilAnnounced(h, 2);
  return question[0];
}

function expectContinued(child: Context) {
  const conversation = JSON.stringify(child.messages);
  expect(conversation).toContain("[child] Remember the codeword");
  expect(conversation).toContain("The codeword is PLOVER.");
  expect(conversation).toContain("What was the codeword?");
}

describe("resuming a finished agent", () => {
  it("continues a live agent in the background and announces the new result", async () => {
    const h = await startParent();
    const { id } = await finishedAgent(h);

    const child = await resumeAndAwait(h, id);

    expectContinued(child);
    const started = shape(resultText(h.requests.parent[1], "subagent_send"), id);
    expect(started).toMatch(/^Agent resumed in background\.\nAgent ID: <id>\n/);
    expect(started).toContain("You will be notified when this agent completes.");
    expect(h.announcements()).toHaveLength(2);
    const text = shape(h.announcements()[1].text, id);
    expect(text).toContain("<status>Done</status>");
    expect(text).toContain(`<summary>Subagent "Remember the codeword" completed</summary>`);
    expect(text).toContain("<result>It was PLOVER.</result>");
    expect(h.savedRecord(id)).toMatchObject({
      status: "idle",
      outcome: "completed",
      result: "It was PLOVER.",
    });
    expect(h.seen("subagent:resuming")).toHaveLength(1);
    expect(h.seen("subagent:resumed")).toHaveLength(1);
    expect(h.errors).toEqual([]);
  }, 30_000);

  it("continues an agent whose session retention released, from its saved transcript", async () => {
    const h = await startParent();
    const { id, transcript } = await finishedAgent(h);
    await h.sweepAfter(24 * 60);
    await vi.waitFor(() => expect(h.seen("subagent:session:disposed")).toHaveLength(1));
    const before = readFileSync(transcript, "utf8");

    const child = await resumeAndAwait(h, id);

    expectContinued(child);
    expect(h.savedRecord(id)).toMatchObject({
      status: "idle",
      outcome: "completed",
      result: "It was PLOVER.",
    });
    // The same transcript carries on; no second one starts.
    const after = readFileSync(transcript, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toContain("It was PLOVER.");
    expect(h.errors).toEqual([]);
  }, 30_000);

  it("continues an agent from before a reload, from its saved transcript", async () => {
    const h = await startParent();
    const { id } = await finishedAgent(h);
    await h.session.reload();

    const child = await resumeAndAwait(h, id);

    expectContinued(child);
    expect(shape(h.announcements()[1].text, id)).toContain("<result>It was PLOVER.</result>");
    expect(h.savedRecord(id)).toMatchObject({
      status: "idle",
      outcome: "completed",
      result: "It was PLOVER.",
    });
    expect(h.errors).toEqual([]);
  }, 30_000);

  it("continues an agent the parent stopped", async () => {
    const h = await startParent();
    const child = gated();
    const parentBusy = gated();
    h.script({
      parent: [delegate("Work"), parentBusy.step, fauxAssistantMessage("Interrupted.")],
      child: [child.step],
    });
    const run = h.session.prompt("Delegate");
    await Promise.all([child.started, parentBusy.started]);
    await h.session.abort();
    await run.catch(() => {});
    await untilAnnounced(h);
    const [id] = h.agentIds();
    expect(h.savedRecord(id)).toMatchObject({ status: "idle", outcome: "stopped" });

    h.script({
      parent: [sendCall(id, "Carry on"), fauxAssistantMessage("Resumed.")],
      child: [fauxAssistantMessage("Carried on.")],
    });
    await h.session.prompt("Resume it");
    await untilAnnounced(h, 2);

    expect(h.savedRecord(id)).toMatchObject({
      status: "idle",
      outcome: "completed",
      result: "Carried on.",
    });
  }, 30_000);

  // Changed by roadmap step 7a (was: a resume skipped the limiter and ran at once
  // even when every slot was taken): a resume waits for a slot like a first run.
  it("queues the resumed run when every concurrency slot is taken, and runs it once one frees", async () => {
    const h = await startParent({ files: { "subagent.json": { maxConcurrent: 1 } } });
    const { id } = await finishedAgent(h);

    const busy = gated();
    h.script({
      parent: [delegate("Holds the slot"), fauxAssistantMessage("Started.")],
      child: [busy.step],
    });
    await h.session.prompt("Take the slot");
    await busy.started;

    h.script({
      parent: [
        sendCall(id, "Go again"),
        fauxAssistantMessage("Queued."),
        fauxAssistantMessage("Noted."),
        fauxAssistantMessage("Noted again."),
      ],
      child: [fauxAssistantMessage("Resumed after the slot freed.")],
    });
    await h.session.prompt("Resume while full");

    // The call returned at once, saying the resume waits, and nothing has run.
    expect(shape(resultText(h.requests.parent[1], "subagent_send"), id)).toMatch(
      /^Agent resume queued in background\.\nAgent ID: <id>\n[\s\S]*Position: queued \(max 1 concurrent\)/,
    );
    expect(h.savedRecord(id)).toMatchObject({ status: "queued", outcome: undefined });
    expect(h.requests.child).toHaveLength(0);
    expect(h.seen("subagent:resuming")).toHaveLength(0);
    // Added by step 7b: consumers learn that the finished agent has a run waiting.
    expect(h.seen("subagent:queued")).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ id }) }),
    ]);

    busy.release();
    await vi.waitFor(() =>
      expect(h.savedRecord(id)).toMatchObject({
        status: "idle",
        outcome: "completed",
        result: "Resumed after the slot freed.",
      }),
    );
    expect(h.seen("subagent:resuming")).toHaveLength(1);
    expect(h.seen("subagent:resumed")).toHaveLength(1);
    expect(h.errors).toEqual([]);
  }, 30_000);
});

describe("sending to an agent that cannot take the message", () => {
  // Changed by roadmap step 7b (was: refused as still running, pointing at subagent_steer).
  it("steers an agent that is still running instead of refusing", async () => {
    const h = await startParent();
    const child = gated();
    h.script({
      parent: [delegate("Work"), fauxAssistantMessage("Started.")],
      child: [child.step, fauxAssistantMessage("Adjusted.")],
    });
    await h.session.prompt("Delegate");
    await child.started;
    const [id] = h.agentIds();

    h.script({
      parent: [sendCall(id, "Hurry up"), fauxAssistantMessage("Sent.")],
    });
    await h.session.prompt("Message it");

    expect(resultText(h.requests.parent[1], "subagent_send")).toContain(
      `Steering message sent to agent ${id}.`,
    );
    expect(h.seen("subagent:resuming")).toEqual([]);
    child.release();
    await untilAnnounced(h);
  }, 30_000);

  it("refuses an agent the session never started", async () => {
    const h = await startParent();
    h.script({ parent: [sendCall("nope", "Hello?"), fauxAssistantMessage("Refused.")] });

    await h.session.prompt("Message a stranger");

    expect(resultText(h.requests.parent[1], "subagent_send")).toBe(
      'Agent not found: "nope". It is not live in this session; subagent_get without agent_id lists the agents started on this branch, including any from before a reload or resume.',
    );
  }, 30_000);
});
