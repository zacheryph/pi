/**
 * The Pi SDK behaviour pi-job's delivery relies on, pinned with a real AgentSession on a scripted
 * model and a minimal probe extension (no pi-job code). If one of these fails after a Pi upgrade,
 * pi-job's completion delivery needs a second look (see src/delivery.ts).
 *
 *  - `sendMessage(msg, { triggerTurn: false })` during a run is held and appended to the
 *    transcript at the end of the current turn, never between a tool call and its result.
 *  - A handler for `agent_before_settle` that returns `continue: true` produces one more model
 *    request, and that request sees the message. Without it the run ends and the message waits.
 *  - Escape (`clearQueue` + `abort`) leaves the message in the transcript and forces no turn.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fauxSession, messageText } from "../../../packages/pi-test-helpers/src/faux-session.ts";
import { waitUntil } from "./helpers.ts";

const PROBE = "probe:message";

interface Entry {
  type: string;
  customType?: string;
  message?: { role?: string; stopReason?: string };
}

/** A model response that blocks until released, or answers "aborted" when its request is aborted. */
function blocking(answer: () => AssistantMessage = () => fauxAssistantMessage("first answer")) {
  let release!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => (markEntered = resolve));
  const step: FauxResponseStep = (_context, options) =>
    new Promise((resolve) => {
      release = () => resolve(answer());
      options?.signal?.addEventListener(
        "abort",
        () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
        { once: true },
      );
      markEntered();
    });
  return { step, entered, release: () => release() };
}

async function harness(t: TestContext, options: { continueRun: boolean }) {
  let api!: ExtensionAPI;
  const seen: { outcome: string; last?: string; pending: number }[] = [];
  const probe = (pi: ExtensionAPI) => {
    api = pi;
    pi.registerTool({
      name: "send_probe",
      label: "send_probe",
      description: "Sends the probe message with triggerTurn: false from inside a tool call",
      parameters: Type.Object({}),
      execute: async () => {
        pi.sendMessage(
          { customType: PROBE, content: "FROM-TOOL", display: true },
          { triggerTurn: false },
        );
        return { content: [{ type: "text" as const, text: "sent" }], details: {} };
      },
    });
    pi.on("agent_before_settle", (event) => {
      const messages = event.context.contextMessages as { role?: string; customType?: string }[];
      const last = messages.at(-1);
      seen.push({
        outcome: event.outcome,
        last: last?.role === "custom" ? last.customType : last?.role,
        pending: event.context.pendingMessages.length,
      });
      if (!options.continueRun || event.outcome !== "completed") return undefined;
      const isProbe = (m?: { role?: string; customType?: string }) =>
        m?.role === "custom" && m.customType === PROBE;
      const pending = event.context.pendingMessages as { role?: string; customType?: string }[];
      return isProbe(last) || pending.some(isProbe) ? { continue: true } : undefined;
    });
  };
  const h = await fauxSession({ cleanup: t, extensions: [probe], tools: ["send_probe"] });
  const send = (text: string) =>
    api.sendMessage({ customType: PROBE, content: text, display: true }, { triggerTurn: false });
  /** Branch entries as `role` or custom type, oldest first. */
  const transcript = () =>
    (h.sessionManager.getBranch() as Entry[]).flatMap((entry) =>
      entry.type === "custom_message"
        ? [`custom:${entry.customType}`]
        : entry.type === "message" && entry.message?.role !== "system"
          ? [`${entry.message?.role}${entry.message?.stopReason === "aborted" ? "(aborted)" : ""}`]
          : [],
    );
  /** Texts of the probe messages the model saw in request `index`. */
  const probesIn = (index: number) =>
    (h.requests[index].messages as { role: string; content: unknown }[])
      .filter(
        (m) =>
          JSON.stringify(m.content).includes("FROM-") || JSON.stringify(m.content).includes("MID-"),
      )
      .map((m) => messageText(m));
  return { ...h, send, transcript, probesIn, seen };
}

void test("a message sent during a tool call lands after the tool result and is seen by the next request", async (t) => {
  const h = await harness(t, { continueRun: false });
  h.faux.setResponses([
    fauxAssistantMessage([{ type: "toolCall", id: "c1", name: "send_probe", arguments: {} }], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  await h.session.prompt("go");
  assert.deepEqual(h.transcript(), [
    "user",
    "assistant",
    "toolResult",
    "custom:probe:message",
    "assistant",
  ]);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.probesIn(1), ["FROM-TOOL"]);
  assert.deepEqual(h.errors, []);
});

void test("sent while the last turn streams: without a continuation the run ends and the message waits", async (t) => {
  const h = await harness(t, { continueRun: false });
  const busy = blocking();
  h.faux.setResponses([busy.step, fauxAssistantMessage("never requested")]);
  const run = h.session.prompt("go");
  await busy.entered;
  h.send("MID-RUN");
  assert.deepEqual(h.transcript(), ["user"], "held, not appended mid-turn");
  busy.release();
  await run;
  assert.deepEqual(h.transcript(), ["user", "assistant", "custom:probe:message"]);
  assert.equal(h.requests.length, 1, "no turn is forced for it");
  assert.equal(h.faux.getPendingResponseCount(), 1);
});

void test("continue: true from agent_before_settle makes one more request that sees the message", async (t) => {
  const h = await harness(t, { continueRun: true });
  const busy = blocking();
  h.faux.setResponses([busy.step, fauxAssistantMessage("answered it"), fauxAssistantMessage("x")]);
  const run = h.session.prompt("go");
  await busy.entered;
  h.send("MID-RUN");
  busy.release();
  await run;
  assert.equal(h.requests.length, 2, "exactly one more model request");
  assert.deepEqual(h.probesIn(1), ["MID-RUN"]);
  assert.deepEqual(h.transcript(), ["user", "assistant", "custom:probe:message", "assistant"]);
  assert.deepEqual(
    h.seen.map((s) => [s.outcome, s.last]),
    [
      ["completed", PROBE],
      ["completed", "assistant"],
    ],
    "the boundary fires again after the continuation, which then ends the run",
  );
  assert.equal(h.faux.getPendingResponseCount(), 1);
  await waitUntil(() => h.session.isIdle);
});

void test("a message that arrives while the run is settling is still seen by the boundary", async (t) => {
  const h = await harness(t, { continueRun: true });
  let late = false;
  // Sent from agent_end, i.e. after the last turn_end flush: pending when the boundary fires.
  h.session.subscribe((event) => {
    if (event.type === "agent_end" && !late) {
      late = true;
      h.send("MID-LATE");
    }
  });
  h.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("answered late")]);
  await h.session.prompt("go");
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.probesIn(1), ["MID-LATE"]);
  assert.equal(h.seen[0].pending, 1, "reported as pending, not yet in the context");
});

for (const [name, escape] of [
  ["Escape (clearQueue + abort)", true],
  ["abort", false],
] as const) {
  void test(`${name} leaves the message in the transcript and forces no turn`, async (t) => {
    const h = await harness(t, { continueRun: true });
    const busy = blocking();
    h.faux.setResponses([busy.step, fauxAssistantMessage("must not run")]);
    const run = h.session.prompt("go");
    await busy.entered;
    h.send("MID-ABORT");
    if (escape) h.session.clearQueue();
    await h.session.abort();
    await run;
    assert.deepEqual(h.transcript(), ["user", "assistant(aborted)", "custom:probe:message"]);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.seen, [], "an aborted run never reaches the boundary");
    // The next prompt sees it.
    h.faux.setResponses([fauxAssistantMessage("next")]);
    await h.session.prompt("again");
    assert.deepEqual(h.probesIn(1), ["MID-ABORT"]);
  });
}

void test("idle: triggerTurn: false appends at once and starts nothing", async (t) => {
  const h = await harness(t, { continueRun: true });
  h.send("MID-IDLE");
  assert.deepEqual(h.transcript(), ["custom:probe:message"]);
  assert.equal(h.requests.length, 0);
});

void test("a failed run reports outcome error to the boundary, where the message is still pending", async (t) => {
  const h = await harness(t, { continueRun: true });
  const busy = blocking(() =>
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" }),
  );
  h.faux.setResponses([busy.step, fauxAssistantMessage("must not run")]);
  const run = h.session.prompt("go");
  await busy.entered;
  h.send("MID-ERROR");
  busy.release();
  await run;
  assert.deepEqual(
    h.seen.map((s) => s.outcome),
    ["error"],
  );
  assert.equal(h.requests.length, 1, "a probe that only continues completed runs does not retry");
  assert.deepEqual(h.transcript(), ["user", "assistant", "custom:probe:message"]);
});
