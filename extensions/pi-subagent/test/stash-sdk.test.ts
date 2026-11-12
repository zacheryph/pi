import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import { offlineAgentDir, EXTENSIONS, realChildSession, BUILTIN_TOOLS } from "#test/helpers/sdk";
import { toolCall, toolResults } from "#test-helpers";

// Real SDK children with the repository's pi-stash extension loaded, as a
// parent bundle would provide it. Checks capability, not model judgment.
async function child(type: "explore" | "plan") {
  const dir = offlineAgentDir({ extensions: [EXTENSIONS.stash] });
  vi.stubEnv("PI_STASH_DIR", join(dir, "stash"));
  return realChildSession(dir, {
    type,
    provider: "stash-subagent-test",
    models: [{ id: "worker" }],
    parentTools: [...BUILTIN_TOOLS, "stash_put", "stash_get", "stash_list"],
    pinModel: true,
  });
}

it("explore can stash large findings and read them back by handle", async () => {
  const { session, faux } = await child("explore");
  expect(session.session.getActiveToolNames()).toEqual(
    expect.arrayContaining(["read", "stash_put", "stash_get", "stash_list"]),
  );
  expect(session.session.getActiveToolNames()).not.toContain("write");
  faux.setResponses([
    toolCall("stash_put", { name: "findings", content: "a.ts:1\nb.ts:2\n" }),
    (context) => {
      const receipt = JSON.stringify(context.messages.at(-1));
      const handle = /stash:findings@[0-9a-f]{12}/.exec(receipt)?.[0];
      expect(handle).toBeTruthy();
      return toolCall("stash_get", { ref: handle! });
    },
    fauxAssistantMessage("Findings stored."),
  ]);
  const result = await session.runTurnLoop("Find usages.", {});
  expect(result.responseText).toContain("Findings stored.");
  expect(toolResults(session.session, "stash_put")[0]).toMatchObject({ isError: false });
  expect(toolResults(session.session, "stash_get")[0]).toMatchObject({
    isError: false,
    content: [{ text: expect.stringContaining("2\tb.ts:2") }],
  });
}, 20_000);

it("Plan can read the stash but cannot write to it", async () => {
  const { session, faux } = await child("plan");
  const active = session.session.getActiveToolNames();
  expect(active).toEqual(expect.arrayContaining(["stash_get", "stash_list"]));
  expect(active).not.toContain("stash_put");
  faux.setResponses([
    toolCall("stash_put", { name: "plan", content: "x" }),
    fauxAssistantMessage("Could not stash."),
  ]);
  await session.runTurnLoop("Plan it.", {});
  const [attempt] = toolResults(session.session, "stash_put");
  expect(attempt?.isError).toBe(true);
}, 20_000);
