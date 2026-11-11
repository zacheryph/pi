/**
 * The root host against a real `AgentSession` on a scripted model: open an item, complete it
 * while the session is idle (wakes a turn) or running (answered in the same run), and see open
 * items closed as lost after a simulated restart. A probe extension plays the producer.
 */
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { fauxSession, messageText, toolCall } from "../../pi-test-helpers/src/faux-session.ts";
import { resetSessionTree } from "../../pi-test-helpers/src/globals.ts";
import { tempDir } from "../../pi-test-helpers/src/temp.ts";
import { waitFor } from "../../pi-test-helpers/src/wait.ts";
import { service } from "../../pi-session-tree/src/index.ts";
import {
  ensureWorkHost,
  WORK_ENTRY,
  WORK_LOST,
  WORK_SERVICE,
  type WorkHost,
  type WorkItem,
} from "../src/index.ts";

const DONE = "test:done";

interface Entry {
  type: string;
  customType?: string;
  message?: { role?: string; stopReason?: string };
}

/** A model response that blocks until released, or answers "aborted" when its request is aborted. */
function blocking(answer = "first answer") {
  let release!: () => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => (markEntered = resolve));
  const step: FauxResponseStep = (_context, options) =>
    new Promise((resolve) => {
      release = () => resolve(fauxAssistantMessage(answer));
      options?.signal?.addEventListener(
        "abort",
        () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
        { once: true },
      );
      markEntered();
    });
  return { step, entered, release: () => release() };
}

/**
 * A producer: the `open_work` tool opens an item, and with `adopts` it takes back whatever it
 * left open at the last start. Items it holds are in `items`.
 */
function producer(options: { adopts?: boolean } = {}) {
  const items: WorkItem[] = [];
  let sessionId = "";
  const extension = (pi: ExtensionAPI) => {
    const work = ensureWorkHost(pi);
    pi.on("session_start", (_event, ctx) => {
      sessionId = ctx.sessionManager.getSessionId();
      if (options.adopts)
        work.host()?.adopt("test", (item) => {
          items.push(item);
          return true;
        });
    });
    pi.registerTool({
      name: "open_work",
      label: "open_work",
      description: "Open a work item",
      parameters: Type.Object({ label: Type.String() }),
      execute: async (_id, params) => {
        items.push(work.host()!.open({ owner: "test", kind: "job", label: params.label }));
        return { content: [{ type: "text" as const, text: "opened" }], details: {} };
      },
    });
  };
  return { extension, items, host: () => service<WorkHost>(sessionId, WORK_SERVICE) };
}

/** Branch entries as `role` or custom type, oldest first. */
const transcript = (manager: SessionManager) =>
  (manager.getBranch() as Entry[]).flatMap((entry) =>
    entry.type === "custom_message"
      ? [`custom:${entry.customType}`]
      : entry.type === "message" && entry.message?.role !== "system"
        ? [`${entry.message?.role}${entry.message?.stopReason === "aborted" ? "(aborted)" : ""}`]
        : [],
  );

/** The branch as `message:<customType>` for the result and `close:<reason>` for work close records. */
const closeOrder = (manager: SessionManager) =>
  (
    manager.getBranch() as {
      type: string;
      customType?: string;
      data?: { op?: string; reason?: string };
    }[]
  ).flatMap((entry) =>
    entry.type === "custom_message" && entry.customType === DONE
      ? ["message"]
      : entry.type === "custom" && entry.customType === WORK_ENTRY && entry.data?.op === "close"
        ? [`close:${entry.data.reason}`]
        : [],
  );

const requestTexts = (request: { messages: unknown[] }) =>
  (request.messages as { content?: unknown }[]).map((m) => messageText(m));

afterEach(resetSessionTree);

describe("root host on a real session", () => {
  it("wakes a turn when an item completes while the session is idle", async () => {
    const p = producer();
    const h = await fauxSession({
      cleanup: onTestFinished,
      extensions: [p.extension],
      tools: ["open_work"],
      responses: [toolCall("open_work", { label: "CI" }), fauxAssistantMessage("waiting")],
    });
    await h.session.prompt("start it");
    expect(h.requests).toHaveLength(2);
    expect(
      p
        .host()!
        .list()
        .map((item) => item.label),
    ).toEqual(["CI"]);

    h.faux.setResponses([fauxAssistantMessage("saw the result")]);
    p.items[0].complete({ customType: DONE, content: "RESULT: green" });
    await waitFor(() => h.requests.length === 3 && h.session.isIdle, { what: "the woken turn" });

    expect(requestTexts(h.requests[2]).join("\n")).toContain("RESULT: green");
    expect(transcript(h.sessionManager).slice(-2)).toEqual([`custom:${DONE}`, "assistant"]);
    expect(p.host()!.list()).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("answers a completion that arrives mid-run in the same run", async () => {
    const p = producer();
    const h = await fauxSession({
      cleanup: onTestFinished,
      extensions: [p.extension],
      tools: ["open_work"],
      responses: [toolCall("open_work", { label: "CI" }), fauxAssistantMessage("waiting")],
    });
    await h.session.prompt("start it");

    const busy = blocking("still working");
    h.faux.setResponses([busy.step, fauxAssistantMessage("answered it")]);
    const run = h.session.prompt("keep going");
    await busy.entered;
    p.items[0].complete({ customType: DONE, content: "RESULT: mid-run" });
    expect(transcript(h.sessionManager).at(-1)).toBe("user");
    busy.release();
    await run;

    // One more request in the same run, which saw the completion; nothing woke a second run.
    expect(h.requests).toHaveLength(4);
    expect(requestTexts(h.requests[3]).join("\n")).toContain("RESULT: mid-run");
    expect(transcript(h.sessionManager).slice(-3)).toEqual([
      "assistant",
      `custom:${DONE}`,
      "assistant",
    ]);
    expect(h.faux.getPendingResponseCount()).toBe(0);
    expect(h.errors).toEqual([]);
  });

  it("writes the close record after the result is in the transcript, idle or mid-run", async () => {
    const p = producer();
    const h = await fauxSession({
      cleanup: onTestFinished,
      extensions: [p.extension],
      tools: ["open_work"],
      responses: [
        toolCall("open_work", { label: "one" }),
        toolCall("open_work", { label: "two" }),
        fauxAssistantMessage("waiting"),
      ],
    });
    await h.session.prompt("start both");
    expect(p.host()!.list()).toHaveLength(2);

    // Idle: the message starts a run and is the first thing in it.
    h.faux.setResponses([fauxAssistantMessage("saw one")]);
    p.items[0].complete({ customType: DONE, content: "ONE" });
    await waitFor(() => h.session.isIdle && closeOrder(h.sessionManager).length === 2, {
      what: "the idle completion",
    });
    expect(closeOrder(h.sessionManager)).toEqual(["message", "close:completed"]);

    // Mid-run: Pi holds the message until the turn ends. Nothing is closed before it lands.
    const busy = blocking();
    h.faux.setResponses([busy.step, fauxAssistantMessage("saw two")]);
    const run = h.session.prompt("keep going");
    await busy.entered;
    p.items[1].complete({ customType: DONE, content: "TWO" });
    expect(closeOrder(h.sessionManager)).toEqual(["message", "close:completed"]);
    busy.release();
    await run;
    await waitFor(() => closeOrder(h.sessionManager).length === 4, { what: "the mid-run close" });
    expect(closeOrder(h.sessionManager)).toEqual([
      "message",
      "close:completed",
      "message",
      "close:completed",
    ]);
    expect(p.host()!.list()).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it("does not take an earlier, identical message for the one still held", async () => {
    const p = producer();
    const h = await fauxSession({
      cleanup: onTestFinished,
      extensions: [p.extension],
      tools: ["open_work"],
      responses: [
        toolCall("open_work", { label: "one" }),
        toolCall("open_work", { label: "two" }),
        fauxAssistantMessage("waiting"),
      ],
    });
    await h.session.prompt("start both");
    const tick = () => new Promise((resolve) => setImmediate(resolve));

    // The first lands at once (idle). The second is byte-identical and completes mid-run.
    h.faux.setResponses([fauxAssistantMessage("saw one")]);
    p.items[0].complete({ customType: DONE, content: "SAME", details: { n: 1 } });
    await waitFor(() => h.session.isIdle && closeOrder(h.sessionManager).length === 2, {
      what: "the first completion",
    });

    const busy = blocking();
    h.faux.setResponses([busy.step, fauxAssistantMessage("saw two")]);
    const run = h.session.prompt("keep going");
    await busy.entered;
    p.items[1].complete({ customType: DONE, content: "SAME", details: { n: 1 } });
    await tick();
    await tick();
    // The second message is held by Pi: nothing may close for it yet.
    expect(closeOrder(h.sessionManager)).toEqual(["message", "close:completed"]);

    busy.release();
    await run;
    await waitFor(() => closeOrder(h.sessionManager).length === 4, { what: "the second close" });
    expect(closeOrder(h.sessionManager)).toEqual([
      "message",
      "close:completed",
      "message",
      "close:completed",
    ]);
    expect(h.errors).toEqual([]);
  });

  it("leaves a completion in the transcript after an abort and forces no turn", async () => {
    const p = producer();
    const h = await fauxSession({
      cleanup: onTestFinished,
      extensions: [p.extension],
      tools: ["open_work"],
      responses: [toolCall("open_work", { label: "CI" }), fauxAssistantMessage("waiting")],
    });
    await h.session.prompt("start it");
    const busy = blocking();
    h.faux.setResponses([busy.step, fauxAssistantMessage("must not run")]);
    const run = h.session.prompt("keep going");
    await busy.entered;
    p.items[0].complete({ customType: DONE, content: "RESULT: aborted" });
    h.session.clearQueue();
    await h.session.abort();
    await run;

    expect(h.requests).toHaveLength(3);
    expect(transcript(h.sessionManager).slice(-2)).toEqual([
      "assistant(aborted)",
      `custom:${DONE}`,
    ]);
    h.faux.setResponses([fauxAssistantMessage("next")]);
    await h.session.prompt("again");
    expect(requestTexts(h.requests[3]).join("\n")).toContain("RESULT: aborted");
  });

  // These pin the safe half of the remaining root-wake gaps: a completion reaches the
  // transcript exactly once and the next prompt sees it. They deliberately do not add a
  // timer-based extension workaround for the SDK's missing post-idle wake boundary.
  for (const outcome of ["succeeds", "fails", "is cancelled"] as const) {
    it(`preserves a completion during manual compaction that ${outcome}`, async () => {
      const fail = outcome === "fails";
      const cancelled = outcome === "is cancelled";
      const p = producer();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const hookIdle: boolean[] = [];
      const compactor = (pi: ExtensionAPI) => {
        pi.on("session_before_compact", async (event) => {
          entered.resolve();
          await release.promise;
          if (cancelled) return { cancel: true };
          if (fail) return undefined; // Pi's summarization request fails below.
          return {
            compaction: {
              summary: "SUMMARY",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            },
          };
        });
        pi.on("session_compact", (_event, ctx) => {
          hookIdle.push(ctx.isIdle());
        });
        pi.on("session_compact_failed", (_event, ctx) => {
          hookIdle.push(ctx.isIdle());
        });
      };
      const h = await fauxSession({
        cleanup: onTestFinished,
        extensions: [p.extension, compactor],
        tools: ["open_work"],
        settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
        responses: [toolCall("open_work", { label: "CI" }), fauxAssistantMessage("waiting")],
      });
      await h.session.prompt("start it");

      const rawIdle: boolean[] = [];
      h.session.subscribe((event) => {
        if (event.type === "compaction_end") rawIdle.push(h.session.isIdle);
      });
      const compact = h.session.compact().catch((error: unknown) => error);
      await entered.promise;
      h.faux.setResponses([
        ...(fail
          ? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary failed" })]
          : []),
        fauxAssistantMessage("saw the preserved result"),
      ]);
      p.items[0].complete({ customType: DONE, content: "RESULT: during compaction" });
      expect(h.session.isIdle).toBe(false);
      expect(
        transcript(h.sessionManager).filter((entry) => entry === `custom:${DONE}`),
      ).toHaveLength(1);
      release.resolve();
      const result = await compact;
      if (fail || cancelled) expect(result).toBeInstanceOf(Error);
      else expect(result).not.toBeInstanceOf(Error);

      // Success fires the extension hook before teardown. The SDK's raw event is after it;
      // failure already has a post-teardown extension hook, but no common idle contract.
      expect(hookIdle).toEqual([fail || cancelled]);
      expect(rawIdle).toEqual([true]);
      expect(h.session.isIdle).toBe(true);
      const beforeResume = fail ? 3 : 2; // Failure makes one summarization request, not an agent run.
      expect(h.requests).toHaveLength(beforeResume);
      expect(h.faux.getPendingResponseCount()).toBe(1);
      expect(closeOrder(h.sessionManager)).toEqual(["message", "close:completed"]);

      await h.session.prompt("continue");
      expect(requestTexts(h.requests[beforeResume]).join("\n")).toContain(
        "RESULT: during compaction",
      );
      expect(h.requests).toHaveLength(beforeResume + 1);
      expect(h.errors).toEqual([]);
    });
  }

  it("preserves a completion arriving after the work host's last settle decision", async () => {
    const p = producer();
    let completeLate = false;
    const late = (pi: ExtensionAPI) => {
      // The host's handler is registered first. This handler completes the item only after
      // the host decided no continuation was needed, but before agent_settled clears its run.
      pi.on("agent_before_settle", (event) => {
        if (!completeLate || event.outcome !== "completed") return;
        completeLate = false;
        p.items[0].complete({ customType: DONE, content: "RESULT: final settlement window" });
      });
    };
    const h = await fauxSession({
      cleanup: onTestFinished,
      extensions: [p.extension, late],
      tools: ["open_work"],
      responses: [toolCall("open_work", { label: "CI" }), fauxAssistantMessage("waiting")],
    });
    await h.session.prompt("start it");
    h.faux.setResponses([fauxAssistantMessage("last answer"), fauxAssistantMessage("saw it")]);
    completeLate = true;
    await h.session.prompt("finish");
    expect(h.session.isIdle).toBe(true);
    expect(h.requests).toHaveLength(3);
    expect(h.faux.getPendingResponseCount()).toBe(1);
    expect(transcript(h.sessionManager).at(-1)).toBe(`custom:${DONE}`);
    expect(closeOrder(h.sessionManager)).toEqual(["message", "close:completed"]);

    await h.session.prompt("continue");
    expect(requestTexts(h.requests[3]).join("\n")).toContain("RESULT: final settlement window");
    expect(transcript(h.sessionManager).filter((entry) => entry === `custom:${DONE}`)).toHaveLength(
      1,
    );
    expect(h.requests).toHaveLength(4);
    expect(h.errors).toEqual([]);
  });

  it("records a notify without closing the item", async () => {
    const p = producer();
    const h = await fauxSession({
      cleanup: onTestFinished,
      extensions: [p.extension],
      tools: ["open_work"],
      responses: [toolCall("open_work", { label: "question" }), fauxAssistantMessage("waiting")],
    });
    await h.session.prompt("start it");
    h.faux.setResponses([fauxAssistantMessage("noted")]);
    p.items[0].notify({ customType: "test:progress", content: "50%" });
    await waitFor(() => h.requests.length === 3 && h.session.isIdle, { what: "the woken turn" });
    expect(p.host()!.list()).toHaveLength(1);
    p.items[0].cancel();
    expect(p.host()!.list()).toEqual([]);
  });

  describe("after a restart", () => {
    /** A session on a file, with one item left open, as a process that then died. */
    async function openAndDie() {
      const dir = tempDir(onTestFinished, "pi-work-");
      const manager = SessionManager.create(dir, dir);
      const p = producer();
      const h = await fauxSession({
        cleanup: onTestFinished,
        dir,
        sessionManager: manager,
        extensions: [p.extension],
        tools: ["open_work"],
        responses: [toolCall("open_work", { label: "CI" }), fauxAssistantMessage("waiting")],
      });
      await h.session.prompt("start it");
      expect(p.host()!.list()).toHaveLength(1);
      const file = manager.getSessionFile()!;
      expect(existsSync(file)).toBe(true);
      await h.session.abort();
      h.session.dispose();
      resetSessionTree(); // a new process starts with an empty registry
      return { dir, file, id: p.items[0].id };
    }

    it("closes unadopted items as lost, shows it, and starts no turn", async () => {
      const { dir, file, id } = await openAndDie();
      const p = producer();
      const h = await fauxSession({
        cleanup: onTestFinished,
        dir,
        sessionManager: SessionManager.open(file, undefined, dir),
        extensions: [p.extension],
        tools: ["open_work"],
      });

      expect(p.host()!.list()).toEqual([]);
      expect(h.requests).toHaveLength(0);
      expect(h.session.isIdle).toBe(true);
      const lost = (
        h.sessionManager.getBranch() as {
          type: string;
          customType?: string;
          content?: unknown;
          details?: { items: { id: string }[] };
        }[]
      ).filter((entry) => entry.type === "custom_message" && entry.customType === WORK_LOST);
      expect(lost).toHaveLength(1);
      expect(lost[0].details?.items.map((item) => item.id)).toEqual([id]);
      expect(JSON.stringify(lost[0].content)).toContain("CI");
      expect(h.errors).toEqual([]);

      // The loss is recorded: a second restart reports nothing again.
      const closed = (
        h.sessionManager.getBranch() as {
          type: string;
          customType?: string;
          data?: { op?: string; reason?: string };
        }[]
      ).filter(
        (entry) =>
          entry.type === "custom" && entry.customType === WORK_ENTRY && entry.data?.op === "close",
      );
      expect(closed.map((entry) => entry.data?.reason)).toEqual(["lost"]);

      // The model sees the loss on its next run.
      h.faux.setResponses([fauxAssistantMessage("understood")]);
      await h.session.prompt("status?");
      expect(requestTexts(h.requests[0]).join("\n")).toContain("Work lost");
    });

    it("reports the item lost when the process dies between complete and the end of the turn", async () => {
      const dir = tempDir(onTestFinished, "pi-work-");
      const manager = SessionManager.create(dir, dir);
      const p = producer();
      const h = await fauxSession({
        cleanup: onTestFinished,
        dir,
        sessionManager: manager,
        extensions: [p.extension],
        tools: ["open_work"],
        responses: [toolCall("open_work", { label: "CI" }), fauxAssistantMessage("waiting")],
      });
      await h.session.prompt("start it");
      const file = manager.getSessionFile()!;
      const crashed = join(dir, "crashed.jsonl");

      // The item completes while a run is in flight: Pi holds the message until the turn ends.
      const busy = blocking();
      h.faux.setResponses([busy.step, fauxAssistantMessage("saw it")]);
      const run = h.session.prompt("keep going");
      await busy.entered;
      p.items[0].complete({ customType: DONE, content: "RESULT: lost in the crash" });
      copyFileSync(file, crashed); // what a kill -9 right now leaves on disk
      busy.release();
      await run;
      await waitFor(() => closeOrder(h.sessionManager).includes("close:completed"), {
        what: "the close once the message landed",
      });
      h.session.dispose();
      resetSessionTree();

      const next = producer();
      const restarted = await fauxSession({
        cleanup: onTestFinished,
        dir,
        sessionManager: SessionManager.open(crashed, undefined, dir),
        extensions: [next.extension],
        tools: ["open_work"],
      });
      // The result never reached the transcript, so the item is not closed as done.
      expect(transcript(restarted.sessionManager)).not.toContain(`custom:${DONE}`);
      expect(closeOrder(restarted.sessionManager)).toEqual(["close:lost"]);
      expect(transcript(restarted.sessionManager)).toContain(`custom:${WORK_LOST}`);
      expect(restarted.requests).toHaveLength(0);
      expect(restarted.errors).toEqual([]);
    });

    it("keeps an item its owner adopts, which then completes and wakes a turn", async () => {
      const { dir, file, id } = await openAndDie();
      const p = producer({ adopts: true });
      const h = await fauxSession({
        cleanup: onTestFinished,
        dir,
        sessionManager: SessionManager.open(file, undefined, dir),
        extensions: [p.extension],
        tools: ["open_work"],
        responses: [fauxAssistantMessage("welcome back")],
      });

      expect(p.items.map((item) => item.id)).toEqual([id]);
      expect(
        p
          .host()!
          .list()
          .map((item) => item.id),
      ).toEqual([id]);
      expect(
        transcript(h.sessionManager).filter((entry) => entry === `custom:${WORK_LOST}`),
      ).toEqual([]);
      expect(h.requests).toHaveLength(0);

      p.items[0].complete({ customType: DONE, content: "RESULT: after restart" });
      await waitFor(() => h.requests.length === 1 && h.session.isIdle, { what: "the woken turn" });
      expect(requestTexts(h.requests[0]).join("\n")).toContain("RESULT: after restart");
      expect(p.host()!.list()).toEqual([]);
    });
  });
});
