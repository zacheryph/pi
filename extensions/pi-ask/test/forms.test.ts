import { afterEach, describe, expect, it } from "vitest";
import {
  advertiseFormConsumer,
  dispatchAction,
  FORM_VIEW_ID,
  listViews,
  MAX_FORM_QUESTIONNAIRES,
  onViewChanged,
} from "#surface";
import { plainTheme, resetSessionTree } from "#test-helpers";
import { delegated, harness, params } from "#test/harness";

afterEach(() => resetSessionTree());

/** An RPC session with a consumer that can answer forms, as dashboard or bb will advertise. */
async function rpcWithConsumer() {
  const h = harness({ mode: "rpc" });
  await h.start();
  const revoke = advertiseFormConsumer(h.events, { name: "test" });
  return { h, revoke };
}

/** Makes `ui.select` wait like Pi's own dialog: until answered, or dismissed by its signal. */
function pendingSelect(h: ReturnType<typeof harness>) {
  const calls: { signal?: AbortSignal; answer(choice: string): void }[] = [];
  h.ui.select.mockImplementation(
    (_title: string, _choices: string[], options: { signal?: AbortSignal } = {}) =>
      new Promise<string | undefined>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        calls.push({ ...(options.signal ? { signal: options.signal } : {}), answer: resolve });
      }),
  );
  return calls;
}

const submit = (h: ReturnType<typeof harness>, args: Record<string, unknown>) =>
  dispatchAction(h.events, "ask.submit", args as never);
const pick = (id: string, option: number) => ({
  id,
  answers: [{ questionIndex: 0, optionIndexes: [option] }],
});

describe("the ask.questions form", () => {
  it("is defined from session start to shutdown, empty while nothing waits", async () => {
    const h = harness();
    await h.start();
    expect(listViews(h.events)).toEqual([{ id: FORM_VIEW_ID, kind: "form", title: "Questions" }]);
    expect(h.form()).toBeUndefined();
    await h.shutdown();
    expect(listViews(h.events)).toEqual([]);
    // A second start on the same bus (a reload's) defines it once again.
    await h.start();
    await h.start();
    expect(listViews(h.events)).toHaveLength(1);
  });

  it("publishes the terminal's questionnaire with its submit and cancel references", async () => {
    const h = harness();
    await h.start();
    const announced: string[] = [];
    onViewChanged(h.events, (id) => announced.push(id));
    const pending = h.ask({
      questions: [
        {
          question: "Which database?",
          header: "Storage",
          options: [{ label: "Postgres", description: "Already running" }, { label: "SQLite" }],
        },
        { question: "Which tables?", options: [{ label: "a" }, { label: "b" }], multiSelect: true },
        { question: "Anything else?" },
      ],
    });
    await h.until(() => h.mounted !== undefined);
    expect(announced).toEqual([FORM_VIEW_ID]);
    expect(h.form()).toEqual({
      questionnaires: [
        {
          id: "call-1",
          openedAt: expect.any(Number),
          questions: [
            {
              question: "Which database?",
              header: "Storage",
              options: [{ label: "Postgres", description: "Already running" }, { label: "SQLite" }],
            },
            {
              question: "Which tables?",
              options: [{ label: "a" }, { label: "b" }],
              multiSelect: true,
            },
            { question: "Anything else?", options: [] },
          ],
          submit: { action: "ask.submit", args: { id: "call-1" } },
          cancel: { action: "ask.cancel", args: { id: "call-1" } },
        },
      ],
    });
    h.mounted!.handleInput?.("1");
    h.mounted!.handleInput?.(" ");
    h.mounted!.handleInput?.("\r");
    for (const key of "fine\r") h.mounted!.handleInput?.(key);
    expect((await pending).details.status).toBe("answered");
    // The terminal answered: the form withdraws it.
    expect(announced).toEqual([FORM_VIEW_ID, FORM_VIEW_ID]);
    expect(h.form()).toBeUndefined();
  });

  it("takes a form answer on a terminal session and closes the terminal's window", async () => {
    const h = harness();
    await h.start();
    const pending = h.ask(params);
    await h.until(() => h.mounted !== undefined);
    const [questionnaire] = h.form()!.questionnaires;
    await expect(
      dispatchAction(h.events, questionnaire!.submit.action, {
        ...questionnaire!.submit.args,
        answers: [{ questionIndex: 0, optionIndexes: [1], notes: "small" }],
        globalNote: "thanks",
      }),
    ).resolves.toEqual({ id: "call-1", status: "answered" });
    const result = await pending;
    expect(result.content[0]!.text).toBe(
      'The user answered:\n- Which database? → "SQLite" (note: small)\nNote: thanks',
    );
    // The window was dismissed with the form's answer, and the form withdrew it.
    expect(h.windowDone).toHaveBeenCalledTimes(1);
    expect(h.windowDone.mock.calls[0]![0]).toMatchObject({ status: "answered" });
    expect(h.form()).toBeUndefined();
    expect(h.sent.at(-1)).toEqual(["ask:closed", { toolCallId: "call-1", outcome: "answered" }]);
  });

  it("declines through the cancel reference, as the user's own dismissal", async () => {
    const h = harness();
    await h.start();
    const pending = h.ask(params);
    await h.until(() => h.mounted !== undefined);
    const { cancel } = h.form()!.questionnaires[0]!;
    await expect(dispatchAction(h.events, cancel.action, cancel.args)).resolves.toEqual({
      id: "call-1",
      status: "cancelled",
    });
    const result = await pending;
    expect(result.details).toMatchObject({ status: "cancelled" });
    expect(result.details.reason).toBeUndefined();
    expect(result.content[0]!.text).toContain("The user dismissed the questions");
    expect(h.windowDone).toHaveBeenCalledTimes(1);
  });

  it("refuses invalid answers and keeps the questionnaire waiting", async () => {
    const h = harness();
    await h.start();
    const pending = h.ask(params);
    await h.until(() => h.mounted !== undefined);
    // Not a form answer at all: refused by its shape.
    await expect(submit(h, { id: "call-1" })).rejects.toThrow('Invalid arguments for "ask.submit"');
    await expect(submit(h, { id: "call-1", answers: [{ questionIndex: -1 }] })).rejects.toThrow(
      "well-formed",
    );
    await expect(submit(h, { ...pick("call-1", 0), cancel: true })).rejects.toThrow(
      'unexpected field "cancel"',
    );
    await expect(dispatchAction(h.events, "ask.cancel", { id: 3 })).rejects.toThrow("expected");
    // A form answer that does not fit the questionnaire: refused by pi-ask's own validation.
    await expect(submit(h, pick("call-1", 5))).rejects.toThrow(
      "Not accepted (invalid_answer): An answer picks an option that does not exist.",
    );
    await expect(
      submit(h, { id: "call-1", answers: [{ questionIndex: 0, optionIndexes: [0, 1] }] }),
    ).rejects.toThrow("takes exactly one answer");
    await expect(submit(h, { id: "call-1", answers: [] })).rejects.toThrow("Answer every question");
    // An id nobody opened.
    await expect(submit(h, pick("nope", 0))).rejects.toThrow("Not accepted (not_found)");
    expect(h.formIds()).toEqual(["call-1"]);
    expect(h.windowDone).not.toHaveBeenCalled();
    h.mounted!.handleInput?.("1");
    expect((await pending).content[0]!.text).toContain('"Postgres"');
  });

  it("accepts the first answer only: duplicate and stale answers are refused as closed", async () => {
    const h = harness();
    await h.start();
    const pending = h.ask(params);
    await h.until(() => h.mounted !== undefined);
    const [first, second] = await Promise.allSettled([
      submit(h, pick("call-1", 0)),
      submit(h, pick("call-1", 1)),
    ]);
    expect(first).toEqual({ status: "fulfilled", value: { id: "call-1", status: "answered" } });
    expect(second).toMatchObject({ status: "rejected" });
    expect(String((second as PromiseRejectedResult).reason)).toContain(
      "Not accepted (closed): That questionnaire was already answered or cancelled.",
    );
    expect((await pending).content[0]!.text).toContain('"Postgres"');
    // Later, through every way in: the same verdict.
    await expect(dispatchAction(h.events, "ask.cancel", { id: "call-1" })).rejects.toThrow(
      "(closed)",
    );
    await expect(
      dispatchAction(h.events, "ask.answer", { toolCallId: "call-1", cancel: true }),
    ).resolves.toMatchObject({ ok: false, code: "closed", toolCallId: "call-1" });
    // A keypress in a window that has gone changes nothing either.
    h.mounted!.handleInput?.("2");
    expect(h.windowDone).toHaveBeenCalledTimes(1);
  });

  it("refuses a terminal answer after a form answer won", async () => {
    const h = harness();
    await h.start();
    const pending = h.ask(params);
    await h.until(() => h.mounted !== undefined);
    const window = h.mounted!;
    await submit(h, pick("call-1", 1));
    window.handleInput?.("1");
    expect((await pending).content[0]!.text).toContain('"SQLite"');
  });

  it("withdraws an aborted questionnaire with an explicit outcome", async () => {
    const h = harness();
    await h.start();
    const controller = new AbortController();
    const pending = h.ask(params, controller.signal);
    await h.until(() => h.mounted !== undefined);
    controller.abort();
    const result = await pending;
    expect(result.details).toMatchObject({ status: "cancelled", reason: "aborted" });
    expect(result.content[0]!.text).toContain("call was aborted");
    expect(h.form()).toBeUndefined();
    await expect(submit(h, pick("call-1", 0))).rejects.toThrow("(closed)");
  });

  it("holds concurrent questionnaires apart, each answered on its own", async () => {
    const h = harness();
    await h.start();
    const one = h.ask(params, undefined, "call-1");
    const two = h.ask(
      { questions: [{ question: "Which port?", options: [{ label: "80" }, { label: "443" }] }] },
      undefined,
      "call-2",
    );
    await h.until(() => h.ui.custom.mock.calls.length === 2);
    expect(h.formIds()).toEqual(["call-1", "call-2"]);
    await submit(h, pick("call-2", 1));
    expect((await two).content[0]!.text).toContain('"443"');
    expect(h.formIds()).toEqual(["call-1"]);
    await submit(h, pick("call-1", 0));
    expect((await one).content[0]!.text).toContain('"Postgres"');
    expect(h.formIds()).toEqual([]);
    expect(h.windowDone).toHaveBeenCalledTimes(2);
  });

  it("withdraws every waiting questionnaire at shutdown, as a reload does", async () => {
    const h = harness();
    await h.start();
    const announced: string[] = [];
    onViewChanged(h.events, (id) => announced.push(id));
    const pending = h.ask(params);
    await h.until(() => h.mounted !== undefined);
    announced.length = 0;
    await h.shutdown();
    const result = await pending;
    expect(result.details).toMatchObject({ status: "cancelled", reason: "ended" });
    expect(result.content[0]!.text).toContain("reloaded or shut down");
    expect(h.windowDone).toHaveBeenCalledTimes(1);
    // Removed silently: the session is ending, so nothing is announced.
    expect(announced).toEqual([]);
    expect(listViews(h.events)).toEqual([]);
    // The reload's session_start finds nothing pending and a fresh form.
    await h.start();
    expect(h.form()).toBeUndefined();
    await expect(submit(h, pick("call-1", 0))).rejects.toThrow("(closed)");
  });

  it("refuses more questionnaires than one form holds, before showing anything", async () => {
    const { h } = await rpcWithConsumer();
    const pending = Array.from({ length: MAX_FORM_QUESTIONNAIRES }, (_, at) =>
      h.ask(params, undefined, `call-${at}`),
    );
    await h.until(() => h.formIds().length === MAX_FORM_QUESTIONNAIRES);
    const opened = h.sent.length;
    await expect(h.ask(params, undefined, "one-too-many")).rejects.toThrow(
      `${MAX_FORM_QUESTIONNAIRES} questionnaires are already waiting`,
    );
    // Nothing of it was announced or left pending.
    expect(h.sent).toHaveLength(opened);
    expect(h.formIds()).not.toContain("one-too-many");
    await expect(submit(h, pick("one-too-many", 0))).rejects.toThrow("(not_found)");
    for (let at = 0; at < MAX_FORM_QUESTIONNAIRES; at++) await submit(h, pick(`call-${at}`, 0));
    for (const result of await Promise.all(pending)) expect(result.details.status).toBe("answered");
  });

  it("refuses questions beyond the form's bounds, and a form that would be too large", async () => {
    const { h } = await rpcWithConsumer();
    // The tool's schema keeps the model within bounds; a call that skipped it is still refused.
    await expect(h.ask({ questions: [{ question: "x".repeat(5_000) }] })).rejects.toThrow(
      "too long to show",
    );
    // Multibyte text near every limit: each questionnaire takes about 64 KB of the form's 256 KiB.
    const big = (at: number) => ({
      questions: Array.from({ length: 4 }, (_, question) => ({
        question: `${at}-${question} ${"é".repeat(3_990)}`,
        options: Array.from({ length: 4 }, (_, option) => ({
          label: `option ${option}`,
          description: "é".repeat(1_000),
        })),
      })),
    });
    const pending = [0, 1, 2, 3].map((at) => h.ask(big(at), undefined, `big-${at}`));
    await h.until(() => h.formIds().length === 4);
    await expect(h.ask(big(4), undefined, "big-4")).rejects.toThrow("too large to show together");
    expect(h.formIds()).toEqual(["big-0", "big-1", "big-2", "big-3"]);
    for (let at = 0; at < 4; at++)
      await dispatchAction(h.events, "ask.cancel", { id: `big-${at}` });
    await Promise.all(pending);
  });
});

describe("RPC sessions", () => {
  it("keep Pi's own dialogs, unchanged, while no consumer can answer forms", async () => {
    // Today's bb: it shows Pi's dialogs and never advertises a form consumer.
    const h = harness({ mode: "rpc" });
    await h.start();
    const dialogs = pendingSelect(h);
    const pending = h.ask(params);
    await h.until(() => dialogs.length === 1);
    expect(h.ui.select).toHaveBeenCalledWith(
      "Storage: Which database?",
      ["Postgres", "SQLite", "Type something…"],
      {},
    );
    // Not published as a form, not announced, and not answerable from outside.
    expect(h.form()).toBeUndefined();
    expect(h.sent).toEqual([]);
    await expect(submit(h, pick("call-1", 1))).rejects.toThrow("(not_found)");
    // A consumer arriving now does not turn the dialog into a second form.
    const revoke = advertiseFormConsumer(h.events, { name: "late" });
    expect(h.form()).toBeUndefined();
    dialogs[0]!.answer("Postgres");
    const result = await pending;
    expect(result.content[0]!.text).toBe('The user answered:\n- Which database? → "Postgres"');
    expect(h.ui.custom).not.toHaveBeenCalled();
    revoke();
  });

  it("publish a form when a consumer can answer it, and take its answer", async () => {
    const { h, revoke } = await rpcWithConsumer();
    const pending = h.ask(params);
    await h.until(() => h.formIds().length === 1);
    expect(h.ui.select).not.toHaveBeenCalled();
    expect(h.ui.custom).not.toHaveBeenCalled();
    // The older events still go out for the dashboard's current path.
    expect(h.sent.map(([channel]) => channel)).toEqual(["ask:opened"]);
    await submit(h, pick("call-1", 0));
    expect((await pending).content[0]!.text).toContain('"Postgres"');
    expect(h.form()).toBeUndefined();
    expect(h.sent.at(-1)).toEqual(["ask:closed", { toolCallId: "call-1", outcome: "answered" }]);
    revoke();
  });

  it("withdraw an aborted form", async () => {
    const { h } = await rpcWithConsumer();
    const controller = new AbortController();
    const pending = h.ask(params, controller.signal);
    await h.until(() => h.formIds().length === 1);
    controller.abort();
    expect((await pending).details).toMatchObject({ status: "cancelled", reason: "aborted" });
    expect(h.form()).toBeUndefined();
    expect(h.sent.at(-1)).toEqual(["ask:closed", { toolCallId: "call-1", outcome: "cancelled" }]);
  });

  it("hand the questionnaire to Pi's dialog when the last consumer goes, refusing late form answers", async () => {
    const h = harness({ mode: "rpc" });
    await h.start();
    const one = advertiseFormConsumer(h.events, { name: "one" });
    const two = advertiseFormConsumer(h.events, { name: "two" });
    const dialogs = pendingSelect(h);
    const pending = h.ask(params);
    await h.until(() => h.formIds().length === 1);
    // One of two leaving changes nothing.
    one();
    expect(h.formIds()).toEqual(["call-1"]);
    expect(dialogs).toHaveLength(0);
    two();
    // Withdrawn from the form at once; Pi's dialog asks instead.
    expect(h.form()).toBeUndefined();
    await h.until(() => dialogs.length === 1);
    expect(dialogs[0]!.signal).toBeDefined();
    // No second answer during the handover, whatever way it comes.
    await expect(submit(h, pick("call-1", 1))).rejects.toThrow("(not_found)");
    await expect(
      dispatchAction(h.events, "ask.answer", { toolCallId: "call-1", cancel: true }),
    ).resolves.toMatchObject({ ok: false, code: "not_found" });
    // A consumer coming back does not publish it again: the dialog has it now.
    const back = advertiseFormConsumer(h.events, { name: "back" });
    expect(h.form()).toBeUndefined();
    dialogs[0]!.answer("SQLite");
    const result = await pending;
    expect(result.content[0]!.text).toBe('The user answered:\n- Which database? → "SQLite"');
    expect(h.sent.at(-1)).toEqual(["ask:closed", { toolCallId: "call-1", outcome: "answered" }]);
    back();
  });

  it("dismiss the handed-over dialog when the call is aborted", async () => {
    const { h, revoke } = await rpcWithConsumer();
    const dialogs = pendingSelect(h);
    const controller = new AbortController();
    const pending = h.ask(params, controller.signal);
    await h.until(() => h.formIds().length === 1);
    revoke();
    await h.until(() => dialogs.length === 1);
    controller.abort();
    expect((await pending).details).toMatchObject({ status: "cancelled", reason: "aborted" });
    expect(dialogs[0]!.signal!.aborted).toBe(true);
  });

  it.each(["no", "stale"] as const)(
    "cancel explicitly when the last consumer goes and Pi has no dialog (%s)",
    async (state) => {
      const { h, revoke } = await rpcWithConsumer();
      const pending = h.ask(params);
      await h.until(() => h.formIds().length === 1);
      h.dialogs.state = state;
      revoke();
      const result = await pending;
      expect(result.details).toMatchObject({ status: "cancelled", reason: "unavailable" });
      expect(result.content[0]!.text).toContain("no dialog was available");
      expect(h.ui.select).not.toHaveBeenCalled();
      expect(h.form()).toBeUndefined();
      expect(h.sent.at(-1)).toEqual(["ask:closed", { toolCallId: "call-1", outcome: "cancelled" }]);
    },
  );

  it("cancel explicitly when the handed-over dialog fails", async () => {
    const { h, revoke } = await rpcWithConsumer();
    h.ui.select.mockRejectedValue(new Error("RPC client gone"));
    const pending = h.ask(params);
    await h.until(() => h.formIds().length === 1);
    revoke();
    expect((await pending).details).toMatchObject({ status: "cancelled", reason: "unavailable" });
  });

  it("hand over at once when the consumer left before the form was published", async () => {
    const h = harness({ mode: "rpc" });
    await h.start();
    const revoke = advertiseFormConsumer(h.events, { name: "brief" });
    // It withdraws while pi-ask announces the questionnaire, before the form is watched.
    h.events.on("ask:opened", () => revoke());
    h.ui.select.mockResolvedValue("Postgres");
    const result = await h.ask(params);
    expect(result.content[0]!.text).toContain('"Postgres"');
    expect(h.form()).toBeUndefined();
  });
});

describe("delegated questions", () => {
  it("still go to the delegating agent, never to a form, whoever advertises", async () => {
    const child = delegated();
    const h = harness({ mode: "rpc", sessionId: "child" });
    await h.start();
    const revoke = advertiseFormConsumer(h.events, { name: "stray" });
    const result = await h.ask(params);
    expect(result.details).toEqual({
      route: "parent",
      status: "asked",
      questions: ["Which database?"],
    });
    expect(child.question).toHaveBeenCalledTimes(1);
    expect(child.host.list()).toMatchObject([{ owner: "pi-ask", data: { toolCallId: "call-1" } }]);
    expect(h.form()).toBeUndefined();
    expect(h.sent).toEqual([]);
    expect(h.ui.select).not.toHaveBeenCalled();
    await expect(submit(h, pick("call-1", 0))).rejects.toThrow("(not_found)");
    revoke();
  });
});

describe("a form answer arriving with the opened event", () => {
  it("settles before the terminal window opens, which is then never shown", async () => {
    const h = harness();
    await h.start();
    h.events.on("ask:opened", () => void submit(h, pick("call-1", 1)));
    const result = await h.ask(params);
    expect(result.content[0]!.text).toContain('"SQLite"');
    expect(h.ui.custom).not.toHaveBeenCalled();
    expect(h.form()).toBeUndefined();
  });
});

describe("each session's form", () => {
  it("is its own, with nothing process-global", async () => {
    // Two sessions in one process: each has its own form and actions.
    const a = harness();
    const b = harness();
    await a.start();
    await b.start();
    const pending = a.ask(params);
    await a.until(() => a.mounted !== undefined);
    expect(b.form()).toBeUndefined();
    await expect(submit(b, pick("call-1", 0))).rejects.toThrow("(not_found)");
    await submit(a, pick("call-1", 0));
    expect((await pending).details.status).toBe("answered");
  });
});

describe("the row withdrawn questions leave in the transcript", () => {
  it.each([
    ["aborted", "Withdrawn: the call was aborted"],
    ["unavailable", "Withdrawn: nobody was left to answer"],
    ["ended", "Withdrawn: the session ended"],
    [undefined, "Dismissed without an answer"],
  ])("says why (%s)", async (reason, text) => {
    const h = harness();
    await h.start();
    const tool = h.registrations[0] as unknown as {
      renderResult(
        result: unknown,
        options: { isPartial: boolean },
        theme: unknown,
      ): { render(width: number): string[] };
    };
    const [row] = tool
      .renderResult(
        {
          content: [],
          details: { route: "user", status: "cancelled", questions: ["Q?"], reason },
        },
        { isPartial: false },
        plainTheme,
      )
      .render(60);
    expect(row).toBe(` ${text}`.padEnd(59) + " ");
  });
});
