import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import { toolCall } from "#test-helpers";
import { lastResult } from "#test/helpers/sdk";
import {
  delegate,
  gated,
  shape,
  startParent,
  untilAnnounced,
} from "#test/characterization/harness";

// What the parent is told when a background agent ends, for each way it can end.
// The parent is a real session; the message is read from its transcript.

const SETTLE_MS = 100;
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

/** The text of a `subagent_start` / `subagent_get` tool result, from the parent's next request. */
const resultText = (request: Parameters<typeof lastResult>[0], tool: string) =>
  (JSON.parse(lastResult(request, tool)) as { content: Array<{ text: string }> }).content[0].text;

function completion(status: string, summary: string, result: string, toolUses = 0) {
  return [
    "<task-notification>",
    "<task-id><id></task-id>",
    "<tool-use-id>CALL</tool-use-id>",
    "<output-file><transcript></output-file>",
    `<status>${status}</status>`,
    `<summary>Subagent "Work" ${summary}</summary>`,
    `<result>${result}</result>`,
    `<usage><total_tokens>N</total_tokens><tool_uses>${toolUses}</tool_uses><context_percent>N</context_percent><duration_ms>N</duration_ms></usage>`,
    "</task-notification>",
    "Full transcript available at: <transcript>",
    `Call subagent_get("<id>") to collect the full result.`,
  ].join("\n");
}

describe("the completion message for a background agent", () => {
  it("reports a completed agent as Done, with its result and a pointer to subagent_get", async () => {
    const h = await startParent();
    h.script({
      parent: [delegate("Work"), fauxAssistantMessage("Started.")],
      child: [fauxAssistantMessage("Did the work.")],
    });

    await h.session.prompt("Delegate");
    await untilAnnounced(h);

    const [id] = h.agentIds();
    const [message] = h.announcements();
    expect(shape(message.text, id)).toBe(completion("Done", "completed", "Did the work."));
    expect(message.details).toMatchObject({
      id,
      status: "completed",
      resultPreview: "Did the work.",
    });
    expect(h.errors).toEqual([]);
  }, 30_000);

  it("wakes an idle parent with the completion in its context", async () => {
    const h = await startParent();
    h.script({
      parent: [delegate("Work"), fauxAssistantMessage("Started."), fauxAssistantMessage("Noted.")],
      child: [fauxAssistantMessage("Did the work.")],
    });

    await h.session.prompt("Delegate");
    await vi.waitFor(() => expect(h.requests.parent).toHaveLength(3), { timeout: 15_000 });

    expect(JSON.stringify(h.requests.parent[2].messages.at(-1))).toContain("<task-notification>");
    expect(JSON.stringify(h.requests.parent[2].messages.at(-1))).toContain("Did the work.");
  }, 30_000);

  it("reports a failed agent as Error with the provider's message and no output", async () => {
    const h = await startParent();
    h.script({
      parent: [delegate("Work"), fauxAssistantMessage("Started.")],
      child: [fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })],
    });

    await h.session.prompt("Delegate");
    await untilAnnounced(h);

    const [id] = h.agentIds();
    expect(shape(h.announcements()[0].text, id)).toBe(
      completion("Error: boom", "error", "No output."),
    );
    expect(h.announcements()[0].details).toMatchObject({ id, status: "error", error: "boom" });
    expect(h.savedRecord(id)).toMatchObject({ status: "idle", outcome: "error", error: "boom" });
  }, 30_000);

  it("reports an agent the parent interrupted as Stopped (user request)", async () => {
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
    expect(shape(h.announcements()[0].text, id)).toBe(
      completion("Stopped (user request)", "stopped", "No output."),
    );
    expect(h.announcements()[0].details).toMatchObject({ id, status: "stopped" });
    expect(h.savedRecord(id)).toMatchObject({ status: "idle", outcome: "stopped" });
  }, 30_000);

  it("reports an agent that finished after its turn-limit warning as Wrapped up", async () => {
    const h = await startParent();
    const ls = () => toolCall("ls", { path: "." });
    h.script({
      parent: [delegate("Work", { max_turns: 3 }), fauxAssistantMessage("Started.")],
      child: [ls(), ls(), fauxAssistantMessage("Summary of what got done.")],
    });

    await h.session.prompt("Delegate");
    await untilAnnounced(h);

    const [id] = h.agentIds();
    expect(shape(h.announcements()[0].text, id)).toBe(
      completion(
        "Wrapped up (after turn-budget warning)",
        "completed",
        "Summary of what got done.",
        2,
      ),
    );
    expect(h.savedRecord(id)).toMatchObject({
      status: "idle",
      outcome: "completed",
      turnBudget: { maxTurns: 3, used: 3, phase: "warned" },
    });
  }, 30_000);

  it("says nothing while the agent is still running", async () => {
    const h = await startParent();
    const child = gated(fauxAssistantMessage("Finally."));
    h.script({
      parent: [delegate("Work"), fauxAssistantMessage("Started.")],
      child: [child.step],
    });

    await h.session.prompt("Delegate");
    await child.started;
    await settle();
    expect(h.announcements()).toEqual([]);

    child.release();
    await untilAnnounced(h);
    expect(h.announcements()).toHaveLength(1);
  }, 30_000);
});

describe("the completion message is the only carrier of an outcome", () => {
  // Rewritten by roadmap step 6 (was: a foreground call blocked and returned the result).
  it("runs in the background and still announces when the call asks for foreground", async () => {
    const h = await startParent();
    h.script({
      parent: [delegate("Work", { foreground: true }), fauxAssistantMessage("Started.")],
      child: [fauxAssistantMessage("Did the work.")],
    });

    await h.session.prompt("Delegate");
    await untilAnnounced(h);

    const [id] = h.agentIds();
    const text = shape(resultText(h.requests.parent[1], "subagent_start"), id);
    expect(text).toMatch(/^Agent started in background\.\nAgent ID: <id>\n/);
    expect(h.announcements()).toHaveLength(1);
    expect(shape(h.announcements()[0].text, id)).toBe(
      completion("Done", "completed", "Did the work."),
    );
  }, 30_000);

  // Rewritten by roadmap steps 6 and 7a (was: subagent_get with wait blocked and returned the result).
  it("answers subagent_get with wait at once, and announces the outcome when it ends", async () => {
    const h = await startParent();
    const child = gated(fauxAssistantMessage("Did the work."));
    h.script({
      parent: [
        delegate("Work"),
        async () => {
          await child.started;
          return toolCall("subagent_get", { agent_id: h.agentIds()[0], wait: true });
        },
        fauxAssistantMessage("Not yet."),
      ],
      child: [child.step],
    });

    await h.session.prompt("Delegate");

    const [id] = h.agentIds();
    const report = shape(resultText(h.requests.parent[2], "subagent_get"), id);
    expect(report).toContain("Status: running");
    expect(report).toContain("Its completion message arrives when it finishes.");
    expect(h.announcements()).toEqual([]);

    child.release();
    await untilAnnounced(h);
    expect(shape(h.announcements()[0].text, id)).toBe(
      completion("Done", "completed", "Did the work."),
    );
  }, 30_000);

  // Rewritten by roadmap step 6 (was: a pulled result suppressed the completion message).
  it("announces the outcome even when the parent already pulled the result during its run", async () => {
    const h = await startParent();
    h.script({
      parent: [
        delegate("Work"),
        async () => {
          await vi.waitFor(() => expect(h.seen("subagent:completed")).toHaveLength(1));
          return toolCall("subagent_get", { agent_id: h.agentIds()[0] });
        },
        fauxAssistantMessage("Collected."),
      ],
      child: [fauxAssistantMessage("Did the work.")],
    });

    await h.session.prompt("Delegate");
    await untilAnnounced(h);
    await settle();

    expect(resultText(h.requests.parent[2], "subagent_get")).toContain("Did the work.");
    // Exactly one: reading the result is not delivering it, and delivering it
    // does not depend on the read.
    expect(h.announcements()).toHaveLength(1);
    const [id] = h.agentIds();
    expect(shape(h.announcements()[0].text, id)).toBe(
      completion("Done", "completed", "Did the work."),
    );
  }, 30_000);
});
