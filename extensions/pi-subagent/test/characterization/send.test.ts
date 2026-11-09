import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import { lastResult } from "../helpers/sdk.ts";
import { delegate, gated, sendCall, shape, startParent, untilAnnounced } from "./harness.ts";

// What subagent_send does with an agent that has not run yet or never got a session: added by
// roadmap step 7b. A running agent (steer.test.ts) and a finished one (resume.test.ts) are
// pinned there.

const resultText = (request: Context, tool: string) =>
  (JSON.parse(lastResult(request, tool)) as { content: Array<{ text: string }> }).content[0].text;

/**
 * One slot, held by agent A; agent B queued behind it. Returns both IDs and the gate
 * that holds A, so a test decides when the slot frees.
 */
async function queuedBehindABusyAgent(h: Awaited<ReturnType<typeof startParent>>) {
  const holder = gated(fauxAssistantMessage("Holder done."));
  h.script({
    parent: [
      delegate("Holds the slot"),
      delegate("Waits for the slot"),
      fauxAssistantMessage("Ok."),
    ],
    child: [holder.step],
  });
  await h.session.prompt("Start two agents");
  await holder.started;
  const [busy, queued] = h.agentIds();
  expect(h.savedRecord(queued)).toMatchObject({ status: "queued" });
  return { busy, queued, holder };
}

describe("subagent_send to an agent waiting for its first slot", () => {
  it("adds the message to the prompt the run starts with, and starts no second run", async () => {
    const h = await startParent({ files: { "subagent.json": { maxConcurrent: 1 } } });
    const { queued, holder } = await queuedBehindABusyAgent(h);

    const seenByQueued: Context[] = [];
    h.script({
      parent: [sendCall(queued, "Use the staging database."), fauxAssistantMessage("Sent.")],
      child: [
        (context) => {
          seenByQueued.push(structuredClone(context));
          return fauxAssistantMessage("Used staging.");
        },
      ],
    });
    await h.session.prompt("Message the queued one");

    expect(shape(resultText(h.requests.parent[1], "subagent_send"), queued)).toBe(
      "Agent <id> is queued for a concurrency slot (max 1 concurrent) and has not started. " +
        "Your message was added to the prompt of the run that is waiting, so the agent sees it when it starts. " +
        "If that run is stopped before its slot opens, the message is dropped.",
    );
    expect(h.seen("subagent:steered")).toEqual([
      {
        channel: "subagent:steered",
        data: { id: queued, message: "[child] Use the staging database." },
      },
    ]);
    // Nothing runs until the slot frees.
    expect(h.requests.child).toHaveLength(0);

    holder.release();
    await untilAnnounced(h, 2);

    // The queued agent started once, from its task followed by the message.
    expect(seenByQueued).toHaveLength(1);
    const prompt = JSON.stringify(seenByQueued[0].messages);
    expect(prompt).toContain("Waits for the slot");
    expect(prompt).toContain("Use the staging database.");
    expect(prompt.indexOf("Waits for the slot")).toBeLessThan(
      prompt.indexOf("Use the staging database."),
    );
    expect(h.savedRecord(queued)).toMatchObject({
      status: "idle",
      outcome: "completed",
      result: "Used staging.",
    });
    expect(h.seen("subagent:resuming")).toEqual([]);
    expect(h.errors).toEqual([]);
  }, 30_000);
});

describe("subagent_send to an agent that never had a session", () => {
  /** A is running and B queued behind it; the parent's interrupt stops both. */
  async function stoppedWhileQueued(h: Awaited<ReturnType<typeof startParent>>) {
    const holder = gated();
    const parentBusy = gated();
    h.script({
      parent: [
        delegate("Holds the slot"),
        delegate("Waits for the slot"),
        parentBusy.step,
        fauxAssistantMessage("Interrupted."),
      ],
      child: [holder.step],
    });
    const run = h.session.prompt("Start two agents");
    await Promise.all([holder.started, parentBusy.started]);
    const [, queued] = h.agentIds();
    await h.session.abort();
    await run.catch(() => {});
    await untilAnnounced(h, 2);
    expect(h.savedRecord(queued)).toMatchObject({ status: "idle", outcome: "stopped" });
    expect(h.savedRecord(queued)!.outputFile).toBeUndefined();
    return queued;
  }

  it("starts its first run from its original task followed by the message", async () => {
    const h = await startParent({ files: { "subagent.json": { maxConcurrent: 1 } } });
    const queued = await stoppedWhileQueued(h);
    expect(h.seen("subagent:started")).toHaveLength(1);

    const seenByChild: Context[] = [];
    h.script({
      parent: [sendCall(queued, "Go ahead after all."), fauxAssistantMessage("Sent.")],
      child: [
        (context) => {
          seenByChild.push(structuredClone(context));
          return fauxAssistantMessage("Did it at last.");
        },
      ],
    });
    await h.session.prompt("Message the stopped one");
    await untilAnnounced(h, 3);

    const started = shape(resultText(h.requests.parent[1], "subagent_send"), queued);
    expect(started).toMatch(/^Note: this agent never started a session, so this is its first run/);
    expect(started).toContain("Agent started in background.\nAgent ID: <id>\n");
    const prompt = JSON.stringify(seenByChild[0].messages);
    expect(prompt).toContain("Waits for the slot");
    expect(prompt).toContain("Go ahead after all.");
    expect(prompt.indexOf("Waits for the slot")).toBeLessThan(
      prompt.indexOf("Go ahead after all."),
    );
    expect(h.savedRecord(queued)).toMatchObject({
      status: "idle",
      outcome: "completed",
      result: "Did it at last.",
    });
    expect(h.savedRecord(queued)!.outputFile).toBeTruthy();
    // Announced as a resume: the agent's one start was the other agent's.
    expect(h.seen("subagent:started")).toHaveLength(1);
    expect(h.seen("subagent:resuming")).toHaveLength(1);
    expect(h.seen("subagent:resumed")).toHaveLength(1);
    expect(shape(h.announcements()[2].text, queued)).toContain("<result>Did it at last.</result>");
    expect(h.errors).toEqual([]);
  }, 30_000);

  it("cannot be started after a reload, which keeps no task to start it from", async () => {
    const h = await startParent({ files: { "subagent.json": { maxConcurrent: 1 } } });
    const queued = await stoppedWhileQueued(h);
    await h.session.reload();

    h.script({
      parent: [sendCall(queued, "Go ahead after all."), fauxAssistantMessage("Refused.")],
    });
    await h.session.prompt("Message the stopped one");

    expect(shape(resultText(h.requests.parent[1], "subagent_send"), queued)).toBe(
      'Agent "<id>" never started a session, and its original task was not saved across the reload, so it cannot take a message. ' +
        "Spawn a new agent with the task.",
    );
    expect(h.requests.child).toHaveLength(0);
    expect(h.savedRecord(queued)).toMatchObject({ status: "idle", outcome: "stopped" });
  }, 30_000);
});

describe("subagent_send to a finished agent that has to wait for a slot", () => {
  it("lets a second message join the run that is waiting", async () => {
    const h = await startParent({ files: { "subagent.json": { maxConcurrent: 1 } } });
    h.script({
      parent: [delegate("Remember the codeword"), fauxAssistantMessage("Started.")],
      child: [fauxAssistantMessage("The codeword is PLOVER.")],
    });
    await h.session.prompt("Delegate");
    await untilAnnounced(h);
    const [id] = h.agentIds();

    const busy = gated();
    h.script({
      parent: [delegate("Holds the slot"), fauxAssistantMessage("Started.")],
      child: [busy.step],
    });
    await h.session.prompt("Take the slot");
    await busy.started;

    const seenByChild: Context[] = [];
    h.script({
      parent: [
        sendCall(id, "What was the codeword?"),
        sendCall(id, "Answer in capitals."),
        fauxAssistantMessage("Asked."),
        fauxAssistantMessage("Noted."),
        fauxAssistantMessage("Noted again."),
      ],
      child: [
        (context) => {
          seenByChild.push(structuredClone(context));
          return fauxAssistantMessage("PLOVER.");
        },
      ],
    });
    await h.session.prompt("Ask twice while full");

    expect(shape(resultText(h.requests.parent[1], "subagent_send"), id)).toMatch(
      /^Agent resume queued in background\./,
    );
    expect(shape(resultText(h.requests.parent[2], "subagent_send"), id)).toMatch(
      /^Agent <id> is queued for a concurrency slot/,
    );
    expect(h.seen("subagent:queued")).toHaveLength(1);

    busy.release();
    await vi.waitFor(() =>
      expect(h.savedRecord(id)).toMatchObject({ status: "idle", result: "PLOVER." }),
    );
    expect(seenByChild).toHaveLength(1);
    const conversation = JSON.stringify(seenByChild[0].messages);
    expect(conversation).toContain("What was the codeword?");
    expect(conversation).toContain("Answer in capitals.");
    expect(h.errors).toEqual([]);
  }, 30_000);
});
