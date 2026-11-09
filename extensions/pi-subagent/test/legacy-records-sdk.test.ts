import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { SUBAGENT_RECORD_ENTRY } from "#src/persisted-record";
import { toolCall } from "../../../packages/pi-test-helpers/src/faux-session.ts";
import {
  delegate,
  resumeCall,
  shape,
  startParent,
  untilAnnounced,
} from "./characterization/harness.ts";
import { lastResult } from "./helpers/sdk.ts";

// Sessions saved before roadmap step 7a hold version 1 `subagent:record` entries
// (six statuses, no outcome). A parent over such a session reads them as the
// version 2 shape the rest of the extension knows: idle with an outcome.

const resultText = (request: Context, tool: string) =>
  (JSON.parse(lastResult(request, tool)) as { content: Array<{ text: string }> }).content[0].text;

/** A version 1 entry, as the old writer appended it: no `version`, one of six statuses. */
function v1Entry(base: Record<string, unknown>, status: string, overrides = {}) {
  return {
    ...base,
    version: undefined,
    outcome: undefined,
    status,
    ...overrides,
  };
}

/**
 * Run one agent to completion, then make the session's last record for it a
 * version 1 entry with `status`, and reload so that nothing is live: the parent
 * knows the agent only from what the session saved.
 */
async function reloadedOverV1Record(status: string, overrides: Record<string, unknown> = {}) {
  const h = await startParent();
  h.script({
    parent: [delegate("Remember the codeword"), fauxAssistantMessage("Started.")],
    child: [fauxAssistantMessage("The codeword is PLOVER.")],
  });
  await h.session.prompt("Delegate");
  await untilAnnounced(h);
  const [id] = h.agentIds();
  h.manager.appendCustomEntry(
    SUBAGENT_RECORD_ENTRY,
    v1Entry({ ...h.savedRecord(id)! }, status, overrides),
  );
  await h.session.reload();
  return { h, id };
}

describe("a session saved with version 1 records", () => {
  it.each([
    ["completed", {}, "completed \\d\\d:\\d\\d, resumable"],
    ["aborted", {}, "failed: turn budget exhausted"],
    ["error", { error: "boom" }, "failed: boom"],
    ["stopped", {}, "stopped before it finished"],
    [
      "queued",
      { result: undefined, completedAt: undefined },
      "interrupted: the session was reloaded or replaced before it finished, resumable",
    ],
    [
      "running",
      { result: undefined, completedAt: undefined },
      "interrupted: the session was reloaded or replaced before it finished, resumable",
    ],
  ])(
    "lists a %s agent as it always did",
    async (status, overrides, line) => {
      const { h, id } = await reloadedOverV1Record(status, overrides);
      h.script({ parent: [toolCall("subagent_get", {}), fauxAssistantMessage("Listed.")] });

      await h.session.prompt("List the agents");

      expect(shape(resultText(h.requests.parent[1], "subagent_get"), id)).toMatch(
        new RegExp(`^- <id> general-purpose "Remember the codeword": ${line}$`, "m"),
      );
    },
    30_000,
  );

  it("resumes an agent a version 1 record left running, and saves the next record as version 2", async () => {
    const { h, id } = await reloadedOverV1Record("running", {
      result: undefined,
      completedAt: undefined,
    });
    h.script({
      parent: [
        toolCall("subagent_get", { agent_id: id }),
        resumeCall(id, "Pick it back up"),
        fauxAssistantMessage("Resumed."),
      ],
      child: [fauxAssistantMessage("Picked it back up.")],
    });

    await h.session.prompt("Check, then resume");
    await untilAnnounced(h, 2);

    expect(shape(resultText(h.requests.parent[1], "subagent_get"), id)).toContain(
      "Status: interrupted",
    );
    expect(h.savedRecord(id)).toMatchObject({
      version: 2,
      status: "idle",
      outcome: "completed",
      result: "Picked it back up.",
    });
    expect(h.errors).toEqual([]);
  }, 30_000);

  it("resumes an agent a version 1 record said was stopped", async () => {
    const { h, id } = await reloadedOverV1Record("stopped");
    h.script({
      parent: [resumeCall(id, "Carry on"), fauxAssistantMessage("Resumed.")],
      child: [fauxAssistantMessage("Carried on.")],
    });

    await h.session.prompt("Resume it");
    await untilAnnounced(h, 2);

    expect(h.savedRecord(id)).toMatchObject({
      version: 2,
      status: "idle",
      outcome: "completed",
      result: "Carried on.",
    });
  }, 30_000);
});
