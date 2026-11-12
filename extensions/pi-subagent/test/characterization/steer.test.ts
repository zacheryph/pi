import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { toolCall } from "#test-helpers";
import { lastResult } from "#test/helpers/sdk";
import {
  delegate,
  gated,
  sendCall,
  shape,
  startParent,
  untilAnnounced,
} from "#test/characterization/harness";

// Sending a message to a running agent through subagent_send, from the parent's side.
// Rewritten by roadmap step 7b: subagent_steer is gone, and subagent_send steers a running
// agent with the same text and the same event. Sending to an agent that is not running no
// longer refuses; resume.test.ts and send.test.ts pin what it does instead.

const resultText = (request: Context, tool: string) =>
  (JSON.parse(lastResult(request, tool)) as { content: Array<{ text: string }> }).content[0].text;

describe("subagent_send to a running agent", () => {
  it("delivers a message to a running agent, which answers it before finishing", async () => {
    const h = await startParent();
    const child = gated(fauxAssistantMessage("First answer."));
    const seenByChild: Context[] = [];
    let steerId = "";
    h.script({
      parent: [
        delegate("Work"),
        async () => {
          await child.started;
          steerId = h.agentIds()[0];
          return sendCall(steerId, "Also check the tests.");
        },
        () => {
          child.release();
          return fauxAssistantMessage("Steered.");
        },
      ],
      child: [
        child.step,
        (context) => {
          seenByChild.push(structuredClone(context));
          return fauxAssistantMessage("Adjusted.");
        },
      ],
    });

    await h.session.prompt("Delegate");
    await untilAnnounced(h);

    const text = shape(resultText(h.requests.parent[2], "subagent_send"), steerId);
    expect(text).toMatch(
      /^Steering message sent to agent <id>\. The agent will process it after its current tool execution\.\nCurrent state: /,
    );
    expect(JSON.stringify(seenByChild[0].messages.at(-1))).toContain("Also check the tests.");
    expect(h.seen("subagent:steered")).toEqual([
      {
        channel: "subagent:steered",
        data: { id: steerId, message: "[child] Also check the tests." },
      },
    ]);
    // A steer is not a new run.
    expect(h.seen("subagent:resuming")).toEqual([]);
    // The agent's answer to the steer is its result.
    expect(h.savedRecord(steerId)).toMatchObject({
      status: "idle",
      outcome: "completed",
      result: "Adjusted.",
    });
    expect(shape(h.announcements()[0].text, steerId)).toContain("<result>Adjusted.</result>");
  }, 30_000);

  it("refuses an agent the session does not know", async () => {
    const h = await startParent();
    h.script({
      parent: [
        toolCall("subagent_send", { agent_id: "nope", message: "Hello?" }),
        fauxAssistantMessage("Ok."),
      ],
    });

    await h.session.prompt("Steer a stranger");

    expect(resultText(h.requests.parent[1], "subagent_send")).toBe(
      'Agent not found: "nope". It is not live in this session; subagent_get without agent_id lists the agents started on this branch, including any from before a reload or resume.',
    );
  }, 30_000);

  it("steers an agent while the run a message started is going", async () => {
    const h = await startParent();
    h.script({
      parent: [delegate("Work"), fauxAssistantMessage("Started.")],
      child: [fauxAssistantMessage("Did the work.")],
    });
    await h.session.prompt("Delegate");
    await untilAnnounced(h);
    const [id] = h.agentIds();

    const child = gated(fauxAssistantMessage("Resumed answer."));
    h.script({
      parent: [
        sendCall(id, "Keep going"),
        async () => {
          await child.started;
          return sendCall(id, "Change course.");
        },
        () => {
          child.release();
          return fauxAssistantMessage("Steered.");
        },
      ],
      child: [child.step, fauxAssistantMessage("Changed course.")],
    });
    await h.session.prompt("Resume it");
    await untilAnnounced(h, 2);

    expect(resultText(h.requests.parent[2], "subagent_send")).toContain(
      `Steering message sent to agent ${id}.`,
    );
    expect(h.savedRecord(id)).toMatchObject({
      status: "idle",
      outcome: "completed",
      result: "Changed course.",
    });
  }, 30_000);

  // Changed by roadmap step 7b (was: "no longer finds an agent from before a reload", because
  // steering needed a live record). A reload ends the run, so the agent comes back idle and
  // interrupted, and a message starts a new run for it instead of finding nothing.
  it("starts a run for an agent whose run a reload interrupted, rather than steering it", async () => {
    const h = await startParent();
    const child = gated();
    h.script({
      parent: [delegate("Work"), fauxAssistantMessage("Started.")],
      child: [child.step],
    });
    await h.session.prompt("Delegate");
    await child.started;
    const [id] = h.agentIds();
    await h.session.reload();

    h.script({
      parent: [sendCall(id, "Still there?"), fauxAssistantMessage("Ok.")],
      child: [fauxAssistantMessage("Yes.")],
    });
    await h.session.prompt("Message it");
    await untilAnnounced(h);

    expect(shape(resultText(h.requests.parent[1], "subagent_send"), id)).toMatch(
      /^Agent resumed in background\.\nAgent ID: <id>\n/,
    );
    expect(h.seen("subagent:steered")).toEqual([]);
    expect(h.savedRecord(id)).toMatchObject({
      status: "idle",
      outcome: "completed",
      result: "Yes.",
    });
  }, 30_000);
});
