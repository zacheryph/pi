import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { toolCall } from "../../../../packages/pi-test-helpers/src/faux-session.ts";
import { lastResult } from "../helpers/sdk.ts";
import { delegate, gated, resumeCall, shape, startParent, untilAnnounced } from "./harness.ts";

// Sending a message to an agent through subagent_steer, from the parent's side.

const resultText = (request: Context, tool: string) =>
  (JSON.parse(lastResult(request, tool)) as { content: Array<{ text: string }> }).content[0].text;

describe("subagent_steer", () => {
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
          return toolCall("subagent_steer", {
            agent_id: steerId,
            message: "Also check the tests.",
          });
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

    const text = shape(resultText(h.requests.parent[2], "subagent_steer"), steerId);
    expect(text).toMatch(
      /^Steering message sent to agent <id>\. The agent will process it after its current tool execution\.\nCurrent state: /,
    );
    expect(JSON.stringify(seenByChild[0].messages.at(-1))).toContain("Also check the tests.");
    expect(h.seen("subagent:steered")).toEqual([
      { channel: "subagent:steered", data: { id: steerId, message: "Also check the tests." } },
    ]);
    // The agent's answer to the steer is its result.
    expect(h.savedRecord(steerId)).toMatchObject({ status: "completed", result: "Adjusted." });
    expect(shape(h.announcements()[0].text, steerId)).toContain("<result>Adjusted.</result>");
  }, 30_000);

  it("refuses to steer a finished agent, naming its status", async () => {
    const h = await startParent();
    h.script({
      parent: [delegate("Work"), fauxAssistantMessage("Started.")],
      child: [fauxAssistantMessage("Did the work.")],
    });
    await h.session.prompt("Delegate");
    await untilAnnounced(h);
    const [id] = h.agentIds();

    h.script({
      parent: [
        toolCall("subagent_steer", { agent_id: id, message: "More." }),
        fauxAssistantMessage("Ok."),
      ],
    });
    await h.session.prompt("Steer it");

    expect(shape(resultText(h.requests.parent[1], "subagent_steer"), id)).toBe(
      'Agent "<id>" is not running (status: completed). Cannot steer a non-running agent.',
    );
    expect(h.seen("subagent:steered")).toEqual([]);
  }, 30_000);

  it("refuses an agent the session does not know", async () => {
    const h = await startParent();
    h.script({
      parent: [
        toolCall("subagent_steer", { agent_id: "nope", message: "Hello?" }),
        fauxAssistantMessage("Ok."),
      ],
    });

    await h.session.prompt("Steer a stranger");

    expect(resultText(h.requests.parent[1], "subagent_steer")).toBe(
      'Agent not found: "nope". It is not live in this session; subagent_get without agent_id lists the agents started on this branch, including any from before a reload or resume.',
    );
  }, 30_000);

  it("steers a resumed agent while its resumed run is going", async () => {
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
        resumeCall(id, "Keep going"),
        async () => {
          await child.started;
          return toolCall("subagent_steer", { agent_id: id, message: "Change course." });
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

    expect(resultText(h.requests.parent[2], "subagent_steer")).toContain(
      `Steering message sent to agent ${id}.`,
    );
    expect(h.savedRecord(id)).toMatchObject({ status: "completed", result: "Changed course." });
  }, 30_000);

  it("no longer finds an agent from before a reload", async () => {
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
      parent: [
        toolCall("subagent_steer", { agent_id: id, message: "Still there?" }),
        fauxAssistantMessage("Ok."),
      ],
    });
    await h.session.prompt("Steer it");

    expect(shape(resultText(h.requests.parent[1], "subagent_steer"), id)).toMatch(
      /^Agent not found: "<id>"\. It is not live in this session;/,
    );
  }, 30_000);
});
