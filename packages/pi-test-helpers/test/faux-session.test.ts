import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { expect, it, onTestFinished } from "vitest";
import {
  fauxSession,
  loadResources,
  messageText,
  toolCall,
  toolResults,
  clearSlots,
  slots,
} from "#src/index";

it("runs a real session against scripted responses and reads tool results back", async () => {
  const h = await fauxSession({
    cleanup: onTestFinished,
    extensions: [
      (pi) =>
        pi.registerTool({
          name: "shout",
          label: "Shout",
          description: "Upper-case a word.",
          parameters: Type.Object({ word: Type.String() }),
          execute: async (_id, params) => ({
            content: [{ type: "text", text: params.word.toUpperCase() }],
            details: {},
          }),
        }),
    ],
    tools: ["shout"],
    responses: [toolCall("shout", { word: "hi" }), fauxAssistantMessage("ok")],
  });
  await h.session.prompt("go");
  expect(h.errors).toEqual([]);
  expect(h.requests).toHaveLength(2);
  const [result] = toolResults(h.sessionManager, "shout");
  expect(messageText(result)).toBe("HI");
  expect(toolResults(h.session, "shout")).toHaveLength(1);
  expect(toolResults(h.requests[1]!, "shout")).toHaveLength(1);
});

it("loads extension files through Pi's loader", async () => {
  const key = Symbol.for("pi-test-helpers.test.loaded");
  onTestFinished(() => clearSlots(key));
  const loaded = await loadResources(onTestFinished, {
    extensions: [`${import.meta.dirname}/fixtures/probe.ts`],
  });
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toHaveLength(1);
  expect(slots[key]).toBe(true);
});
