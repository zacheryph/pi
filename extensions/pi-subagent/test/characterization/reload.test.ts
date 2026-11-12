import { rmSync } from "node:fs";
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

// What the parent sees of its agents after the session reloads. The extension
// is torn down and set up again over the same session file, so nothing is live:
// every agent is rebuilt from the records the parent saved as they changed.

const resultText = (request: Context, tool: string) =>
  (JSON.parse(lastResult(request, tool)) as { content: Array<{ text: string }> }).content[0].text;

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("agents after a reload", () => {
  it("reports a finished agent from its saved record, as resumable, without announcing it again", async () => {
    const h = await startParent();
    h.script({
      parent: [delegate("Work"), fauxAssistantMessage("Started.")],
      child: [fauxAssistantMessage("Did the work.")],
    });
    await h.session.prompt("Delegate");
    await untilAnnounced(h);
    const [id] = h.agentIds();
    await h.session.reload();

    h.script({
      parent: [
        toolCall("subagent_get", { agent_id: id }),
        toolCall("subagent_get", {}),
        fauxAssistantMessage("Checked."),
      ],
    });
    await h.session.prompt("Check on it");
    await settle();

    const report = shape(resultText(h.requests.parent[1], "subagent_get"), id);
    expect(report).toContain("Status: completed");
    expect(report).toContain("Did the work.");
    expect(report).toContain('Send: available. Call subagent_send with agent_id: "<id>"');
    expect(report).toContain("Full transcript available at: <transcript>");
    expect(shape(resultText(h.requests.parent[2], "subagent_get"), id)).toMatch(
      /^Agents started on this branch \(1; subagent_get <id> for details, subagent_send <id> to give an idle one more work\):\n- <id> general-purpose "Work": idle, last run completed \d\d:\d\d$/,
    );
    expect(h.announcements()).toHaveLength(1);
  }, 30_000);

  it("reports an agent the reload interrupted as interrupted, never announces it, and can resume it", async () => {
    const h = await startParent();
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

    h.script({
      parent: [
        toolCall("subagent_get", { agent_id: id }),
        toolCall("subagent_get", {}),
        sendCall(id, "Pick it back up"),
        fauxAssistantMessage("Checked."),
      ],
      child: [fauxAssistantMessage("Picked it back up.")],
    });
    await h.session.prompt("Check on it");
    await untilAnnounced(h);

    const report = shape(resultText(h.requests.parent[1], "subagent_get"), id);
    expect(report).toContain("Status: interrupted");
    expect(report).toContain(
      "This agent was still running when this session was reloaded or replaced, so it never finished.",
    );
    expect(shape(resultText(h.requests.parent[2], "subagent_get"), id)).toContain(
      '"Work": idle, last run interrupted: the session was reloaded or replaced before it finished',
    );
    // The only announcement is the resumed run's; the interrupted run sent none.
    expect(shape(h.announcements()[0].text, id)).toContain("<result>Picked it back up.</result>");
    expect(h.announcements()).toHaveLength(1);
    expect(h.savedRecord(id)).toMatchObject({
      status: "idle",
      outcome: "completed",
      result: "Picked it back up.",
    });
  }, 30_000);

  it("says a finished agent cannot take a message once its transcript is gone", async () => {
    const h = await startParent();
    h.script({
      parent: [delegate("Work"), fauxAssistantMessage("Started.")],
      child: [fauxAssistantMessage("Did the work.")],
    });
    await h.session.prompt("Delegate");
    await untilAnnounced(h);
    const [id] = h.agentIds();
    rmSync(h.savedRecord(id)!.outputFile!);
    await h.session.reload();

    h.script({
      parent: [
        toolCall("subagent_get", { agent_id: id }),
        sendCall(id, "More"),
        fauxAssistantMessage("Checked."),
      ],
    });
    await h.session.prompt("Check on it");

    const report = shape(resultText(h.requests.parent[1], "subagent_get"), id);
    expect(report).toContain("Did the work.");
    expect(report).toContain(
      "Send: not available, because its session was released and its saved transcript is gone.",
    );
    expect(shape(resultText(h.requests.parent[2], "subagent_send"), id)).toMatch(
      /^Agent "<id>" had its session released and its saved transcript is gone; it cannot take a message, but its result is still retrievable via subagent_get\./,
    );
  }, 30_000);
});

describe("the records the parent saves", () => {
  it("saves a record when an agent starts and again when it finishes", async () => {
    const h = await startParent();
    const child = gated(fauxAssistantMessage("Did the work."));
    h.script({
      parent: [delegate("Work"), fauxAssistantMessage("Started.")],
      child: [child.step],
    });
    await h.session.prompt("Delegate");
    await child.started;
    const [id] = h.agentIds();
    expect(h.savedRecord(id)).toMatchObject({
      id,
      type: "general-purpose",
      description: "Work",
      status: "running",
    });

    child.release();
    await untilAnnounced(h);

    expect(h.savedRecord(id)).toMatchObject({
      id,
      status: "idle",
      outcome: "completed",
      result: "Did the work.",
      toolUses: 0,
    });
    expect(h.savedRecord(id)!.outputFile).toMatch(/\.jsonl$/);
  }, 30_000);
});
