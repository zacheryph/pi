import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import { toolCall } from "../../../../packages/pi-test-helpers/src/faux-session.ts";
import { lastResult } from "../helpers/sdk.ts";
import { delegate, gated, type Parent, shape, startParent, untilAnnounced } from "./harness.ts";

// When a finished agent's session is released. The record, its result and its
// transcript outlive the session; only the live session is freed. Windows are
// the defaults: 10 minutes once the parent has read the result with subagent_get, 12 hours
// for a result nobody read. The sweep is run on demand.

const resultText = (request: Context, tool: string) =>
  (JSON.parse(lastResult(request, tool)) as { content: Array<{ text: string }> }).content[0].text;

async function finishedAgent(h: Parent) {
  h.script({
    parent: [delegate("Work"), fauxAssistantMessage("Started.")],
    child: [fauxAssistantMessage("Did the work.")],
  });
  await h.session.prompt("Delegate");
  await untilAnnounced(h);
  return h.agentIds()[0];
}

/** The parent reads the agent's result with subagent_get, which starts the short window. */
async function collect(h: Parent, id: string) {
  h.script({
    parent: [toolCall("subagent_get", { agent_id: id }), fauxAssistantMessage("Read it.")],
  });
  await h.session.prompt("Collect it");
  return resultText(h.requests.parent[1], "subagent_get");
}

describe("releasing a finished agent's session", () => {
  it("keeps the session of an agent whose outcome nobody collected for twelve hours", async () => {
    const h = await startParent();
    await finishedAgent(h);

    await h.sweepAfter(11);
    expect(h.seen("subagent:session:disposed")).toHaveLength(0);
    await h.sweepAfter(11 * 60);
    expect(h.seen("subagent:session:disposed")).toHaveLength(0);

    await h.sweepAfter(12 * 60 + 1);
    await vi.waitFor(() => expect(h.seen("subagent:session:disposed")).toHaveLength(1));
  }, 30_000);

  it("releases the session ten minutes after the parent collected the outcome", async () => {
    const h = await startParent();
    const id = await finishedAgent(h);
    await collect(h, id);

    await h.sweepAfter(5);
    expect(h.seen("subagent:session:disposed")).toHaveLength(0);

    await h.sweepAfter(11);
    await vi.waitFor(() => expect(h.seen("subagent:session:disposed")).toHaveLength(1));
    expect(h.seen("subagent:session:disposed")[0].data).toMatchObject({ agentId: id });
  }, 30_000);

  it("never releases the session of an agent that is still running", async () => {
    const h = await startParent();
    const child = gated(fauxAssistantMessage("Finally."));
    h.script({
      parent: [delegate("Work"), fauxAssistantMessage("Started.")],
      child: [child.step],
    });
    await h.session.prompt("Delegate");
    await child.started;

    await h.sweepAfter(24 * 60);

    expect(h.seen("subagent:session:disposed")).toHaveLength(0);
    child.release();
    await untilAnnounced(h);
  }, 30_000);

  it("keeps the released agent listed as resumable, with its result and transcript", async () => {
    const h = await startParent();
    const id = await finishedAgent(h);
    await collect(h, id);
    await h.sweepAfter(11);
    await vi.waitFor(() => expect(h.seen("subagent:session:disposed")).toHaveLength(1));

    h.script({
      parent: [
        toolCall("subagent_get", { agent_id: id }),
        toolCall("subagent_get", {}),
        fauxAssistantMessage("Checked."),
      ],
    });
    await h.session.prompt("Check on it");

    const report = shape(resultText(h.requests.parent[1], "subagent_get"), id);
    expect(report).toContain("Status: completed");
    expect(report).toContain("Did the work.");
    expect(report).toContain("Full transcript available at: <transcript>");
    expect(resultText(h.requests.parent[2], "subagent_get")).toMatch(
      /completed \d\d:\d\d, resumable/,
    );
    expect(h.savedRecord(id)).toMatchObject({ status: "completed", result: "Did the work." });
  }, 30_000);
});
