import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi, onTestFinished } from "vitest";
import { provide } from "#session-tree";
import {
  createWorkHost,
  QUESTION_KIND,
  WORK_PARENT_SERVICE,
  WORK_SERVICE,
  type WorkRecord,
} from "#work";
import piAsk from "#src/index";
import { dispatchAction, listActions } from "#surface";
import {
  waitFor,
  fakePi,
  resetSessionTree,
  fakeCustomUi,
  ansiTheme,
  plainTheme,
} from "#test-helpers";
import { visibleWidth } from "@earendil-works/pi-tui";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));
const NOTIFICATION_ID = "59A9DCD2-BB99-4BD2-8FC7-943073019662";

// No real cmux calls, even when the suite itself runs inside a cmux pane.
beforeEach(() => {
  execFile.mockReset();
  vi.stubEnv("CMUX_SURFACE_ID", undefined);
  vi.stubEnv("CMUX_PANEL_ID", undefined);
  vi.stubEnv("CMUX_PI_HOOKS_DISABLED", undefined);
});

type Tool = {
  name: string;
  exposure?: string;
  description: string;
  promptSnippet?: string;
  execute: (...args: unknown[]) => Promise<{
    content: { type: string; text: string }[];
    details: Record<string, unknown>;
    terminate?: boolean;
  }>;
};

function harness(options: { mode?: string; hasUI?: boolean; sessionId?: string } = {}) {
  const fake = fakePi();
  const { pi, events } = fake;
  const tools = fake.tools as unknown as Map<string, Tool>;
  const mounted = fakeCustomUi<{
    handleInput?(data: string): void;
    render(width: number): string[];
  }>({ awaitDone: true });
  const ui = { notify: vi.fn(), select: vi.fn(), input: vi.fn(), custom: mounted.custom };
  // An inline window, never an overlay: ui.custom gets no options.
  onTestFinished(() => {
    for (const [, custom] of ui.custom.mock.calls) expect(custom).toBeUndefined();
  });
  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    ui,
    isIdle: () => true,
    sessionManager: { getSessionId: () => options.sessionId ?? "root", getBranch: () => [] },
  } as unknown as ExtensionContext;
  piAsk(fake.api);
  const start = () => fake.emit("session_start", {}, ctx);
  const shutdown = () => fake.emit("session_shutdown", {}, ctx);
  const ask = (params: unknown, signal?: AbortSignal, id = "call-1") =>
    tools.get("ask")!.execute(id, params, signal, undefined, ctx);
  const until = (check: () => boolean) => waitFor(check, { interval: 0, timeout: 1000 });
  return {
    pi,
    tools,
    registrations: pi.registerTool.mock.calls.map(([tool]) => tool),
    /** What pi-ask published; the action registry's own requests are not publications. */
    get sent() {
      return events.emitted.filter(([channel]) => !channel.startsWith("surface:"));
    },
    events,
    ui,
    ctx,
    start,
    shutdown,
    ask,
    until,
    get mounted() {
      return mounted.latest();
    },
  };
}

/**
 * A delegated session as pi-subagent sets it up before the child's extensions bind: a work host
 * under the session's id (`persisted` are the records an earlier instance left in its
 * transcript) and a parent link to tell. Nothing else provides the host, so pi-ask's
 * `ensureWorkHost` finds this one.
 */
function delegated(persisted: WorkRecord[] = [], options: { id?: string; parent?: boolean } = {}) {
  const id = options.id ?? "child";
  const records = [...persisted];
  const send = vi.fn();
  const host = createWorkHost({
    store: { read: () => records, append: (record) => records.push(record) },
    delivery: { isIdle: () => true, send, lost: vi.fn() },
  });
  host.start();
  provide(id, WORK_SERVICE, host);
  const question = vi.fn<(text: string) => void>();
  if (options.parent !== false) provide(id, WORK_PARENT_SERVICE, { question });
  return { host, question, send, records };
}

const params = {
  questions: [
    {
      question: "Which database?",
      header: "Storage",
      options: [{ label: "Postgres" }, { label: "SQLite" }],
    },
  ],
};

afterEach(() => {
  vi.unstubAllEnvs();
  resetSessionTree();
});

describe("pi-ask routing", () => {
  it("registers ask as a model-only tool that asks the user", async () => {
    const h = harness();
    await h.start();
    const tool = h.tools.get("ask")!;
    expect(tool.exposure).toBe("model-only");
    expect(tool.description).toContain("Ask the user");
    expect(h.registrations.map((tool) => tool.name)).toEqual(["ask", "user_notify"]);
  });

  it("hides ask where no one can answer, and refuses a stray call", async () => {
    const h = harness({ mode: "print", hasUI: false });
    await h.start();
    expect(h.tools.get("ask")!.exposure).toBe("hidden");
    await expect(h.ask(params)).rejects.toThrow("No one can answer questions in this session");
  });

  it("turns toward the parent in a child session: a question item, the parent told, the turn ended", async () => {
    const child = delegated();
    const h = harness({ mode: "print", hasUI: false, sessionId: "child" });
    await h.start();
    const tool = h.tools.get("ask")!;
    expect(tool.description).toContain("agent that delegated this task");
    expect(tool.promptSnippet).toContain("your turn ends");
    const result = await h.ask(params);
    // The parent hears the question once, as text.
    expect(child.question).toHaveBeenCalledTimes(1);
    expect(child.question).toHaveBeenCalledWith(
      [
        "[Storage] Which database?",
        "   a) Postgres",
        "   b) SQLite",
        "   (choose one, or answer in your own words)",
      ].join("\n"),
    );
    // The child waits on a question item in its own host: data a reload can adopt.
    expect(child.host.list()).toMatchObject([
      {
        owner: "pi-ask",
        kind: QUESTION_KIND,
        label: "answer",
        data: {
          toolCallId: "call-1",
          questions: ["Which database?"],
          text: expect.stringContaining("[Storage] Which database?"),
        },
      },
    ]);
    // The turn ends after the tool batch. No dialog, no cmux, no answer to wait for.
    expect(result.terminate).toBe(true);
    expect(result.content[0]!.text).toContain("Your turn ends now");
    expect(result.details).toEqual({
      route: "parent",
      status: "asked",
      questions: ["Which database?"],
    });
    expect(h.ui.custom).not.toHaveBeenCalled();
  });

  it("opens the item before it tells the parent", async () => {
    const child = delegated();
    const seen: unknown[] = [];
    child.question.mockImplementation(() => seen.push(child.host.list().length));
    const h = harness({ mode: "print", hasUI: false, sessionId: "child" });
    await h.start();
    await h.ask(params);
    expect(seen).toEqual([1]);
  });

  it("withdraws the item and tells the model when the parent cannot be reached", async () => {
    const child = delegated();
    child.question.mockImplementation(() => {
      throw new Error("the spawner is gone");
    });
    const h = harness({ mode: "print", hasUI: false, sessionId: "child" });
    await h.start();
    await expect(h.ask(params)).rejects.toThrow("could not be reached (the spawner is gone)");
    expect(child.host.list()).toEqual([]);
  });

  it("refuses the question when the session has no work host to wait in", async () => {
    provide("child", WORK_PARENT_SERVICE, { question: vi.fn() });
    const h = harness({ mode: "print", hasUI: false, sessionId: "child" });
    // No session_start: nothing has provided a host for this session yet.
    await expect(h.ask(params)).rejects.toThrow("no work host");
  });

  it("asks the user in the root session, whatever else is offered", async () => {
    // The root has a work host (ensureWorkHost provides it) and no parent link: nothing changes.
    const h = harness();
    await h.start();
    const pending = h.ask(params);
    await h.until(() => h.mounted !== undefined);
    h.mounted!.handleInput?.("1");
    const result = await pending;
    expect(result.details.route).toBe("user");
    expect(result.terminate).toBeUndefined();
    expect(h.pi.appendEntry).not.toHaveBeenCalled(); // no question item in the root's host
  });
});

describe("the row a parent question leaves in the transcript", () => {
  const rendered = async (status: string, width: number, theme: typeof plainTheme = plainTheme) => {
    const h = harness({ mode: "print", hasUI: false, sessionId: "child" });
    await h.start();
    const tool = h.registrations[0] as unknown as {
      renderResult(
        result: unknown,
        options: { isPartial: boolean },
        theme: unknown,
      ): {
        render(width: number): string[];
      };
    };
    return tool
      .renderResult(
        { content: [], details: { route: "parent", status, questions: ["Which database?"] } },
        { isPartial: false },
        theme,
      )
      .render(width);
  };

  it.each(["asked", "recorded"])("says it is waiting for the answer (%s)", async (status) => {
    expect(await rendered(status, 80)).toEqual([
      " Asked the delegating agent; waiting for its answer".padEnd(79) + " ",
    ]);
  });

  it.each([0, 1, 2, 3, 8, 20, 30])(
    "keeps a space on both sides, or draws a blank row, at width %i",
    async (width) => {
      const [row] = await rendered("asked", width);
      expect(visibleWidth(row)).toBe(width);
      if (width <= 2) expect(row.trim()).toBe("");
      else {
        expect(row.startsWith(" ")).toBe(true);
        expect(row.endsWith(" ")).toBe(true);
      }
    },
  );

  it("measures styled text by what is visible", async () => {
    const [row] = await rendered("asked", 24, ansiTheme);
    expect(visibleWidth(row)).toBe(24);
    expect(row.startsWith(" ")).toBe(true);
    expect(row.endsWith(" ")).toBe(true);
  });
});

describe("a question across a reload or restart", () => {
  const open = (
    id: string,
    over: Partial<Extract<WorkRecord, { op: "open" }>> = {},
  ): WorkRecord => ({
    v: 1,
    op: "open",
    id,
    owner: "pi-ask",
    kind: QUESTION_KIND,
    label: "answer",
    data: { toolCallId: "c1", questions: ["Which database?"], text: "Which database?" },
    at: 1,
    ...over,
  });

  it("adopts its open question at session start, so it is never reported lost", async () => {
    const child = delegated([open("q1")]);
    const h = harness({ mode: "print", hasUI: false, sessionId: "child" });
    await h.start();
    expect(child.host.settleStartup()).toEqual([]);
    expect(child.host.list()).toMatchObject([{ id: "q1", kind: QUESTION_KIND }]);
    expect(child.send).not.toHaveBeenCalled(); // no work:lost message
    // The parent was told when the question was asked, not again now.
    expect(child.question).not.toHaveBeenCalled();
  });

  it("does not adopt an item it did not write the way it writes questions", async () => {
    const child = delegated([
      open("bad", { data: { nothing: true } }),
      open("job", { kind: "job" }),
      open("other", { owner: "pi-job" }),
    ]);
    const h = harness({ mode: "print", hasUI: false, sessionId: "child" });
    await h.start();
    // pi-job's item is pi-job's to adopt: it was not offered to pi-ask, and here nothing took it.
    expect(child.host.settleStartup().map((item) => item.id)).toEqual(["bad", "job", "other"]);
    expect(child.host.list()).toEqual([]);
  });

  it("leaves a question item alone in a session that asks the user", async () => {
    // A transcript forked from a child's: the root has no one to answer it.
    const root = delegated([open("q1")], { id: "root", parent: false });
    const h = harness();
    await h.start();
    expect(root.host.settleStartup().map((item) => item.id)).toEqual(["q1"]);
  });
});

describe("asking the user in the terminal", () => {
  it("opens the questionnaire inline, announces it, and returns the answer", async () => {
    const h = harness();
    await h.start();
    const pending = h.ask(params);
    await h.until(() => h.mounted !== undefined);
    expect(h.sent[0]).toEqual([
      "ask:opened",
      {
        toolCallId: "call-1",
        questions: [
          {
            question: "Which database?",
            header: "Storage",
            multiSelect: false,
            options: [
              { label: "Postgres", description: "" },
              { label: "SQLite", description: "" },
            ],
          },
        ],
      },
    ]);
    expect(h.mounted!.render(60).join("\n")).toContain("Question");
    h.mounted!.handleInput?.("2");
    const result = await pending;
    expect(result.content[0]!.text).toBe('The user answered:\n- Which database? → "SQLite"');
    expect(result.details).toMatchObject({ route: "user", status: "answered" });
    expect(h.sent.at(-1)).toEqual(["ask:closed", { toolCallId: "call-1", outcome: "answered" }]);
  });

  it("takes an answer from outside the terminal, refusing bad ones and unknown ids", async () => {
    const h = harness();
    await h.start();
    const pending = h.ask(params);
    await h.until(() => h.mounted !== undefined);
    const replies = () => h.sent.filter(([channel]) => channel === "ask:answer-result");

    h.events.emit("ask:answer", { toolCallId: "nope", requestId: "r0" });
    h.events.emit("ask:answer", {
      toolCallId: "call-1",
      requestId: "r1",
      answers: [{ questionIndex: 0, optionIndexes: [0, 1] }],
    });
    h.events.emit("ask:answer", {
      toolCallId: "call-1",
      requestId: "r2",
      answers: [{ questionIndex: 0, text: "DuckDB" }],
    });
    expect(replies().map(([, data]) => data)).toEqual([
      expect.objectContaining({ ok: false, code: "not_found", requestId: "r0" }),
      expect.objectContaining({ ok: false, code: "invalid_answer", requestId: "r1" }),
      { ok: true, toolCallId: "call-1", requestId: "r2" },
    ]);
    const result = await pending;
    expect(result.content[0]!.text).toContain('"DuckDB" (own words)');
  });

  it("answers through the ask.answer action as ask:answer does, from start to shutdown", async () => {
    const h = harness();
    await h.start();
    expect(listActions(h.events)).toEqual([{ id: "ask.answer", title: expect.any(String) }]);
    const pending = h.ask(params);
    await h.until(() => h.mounted !== undefined);

    await expect(dispatchAction(h.events, "ask.answer", { toolCallId: "nope" })).resolves.toEqual(
      expect.objectContaining({ ok: false, code: "not_found", toolCallId: "nope" }),
    );
    await expect(dispatchAction(h.events, "ask.answer")).resolves.toEqual(
      expect.objectContaining({ ok: false, code: "invalid_payload" }),
    );
    await expect(
      dispatchAction(h.events, "ask.answer", {
        toolCallId: "call-1",
        answers: [{ questionIndex: 0, optionIndexes: [0, 1] }],
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: false, code: "invalid_answer" }));
    await expect(
      dispatchAction(h.events, "ask.answer", {
        toolCallId: "call-1",
        requestId: "r1",
        answers: [{ questionIndex: 0, optionIndexes: [1] }],
      }),
    ).resolves.toEqual({ ok: true, toolCallId: "call-1", requestId: "r1" });
    expect((await pending).content[0]!.text).toBe(
      'The user answered:\n- Which database? → "SQLite"',
    );
    // The action replies to its caller only; nothing goes out on ask:answer-result.
    expect(h.sent.some(([channel]) => channel === "ask:answer-result")).toBe(false);

    await h.shutdown();
    expect(listActions(h.events)).toEqual([]);
  });

  it("dismisses the questionnaire when the call is aborted", async () => {
    const h = harness();
    await h.start();
    const controller = new AbortController();
    const pending = h.ask(params, controller.signal);
    await h.until(() => h.mounted !== undefined);
    controller.abort();
    const result = await pending;
    expect(result.details).toMatchObject({ status: "cancelled" });
    expect(h.sent.at(-1)).toEqual(["ask:closed", { toolCallId: "call-1", outcome: "cancelled" }]);
  });

  it("asks through the host's own dialogs in RPC mode", async () => {
    const h = harness({ mode: "rpc" });
    await h.start();
    h.ui.select.mockResolvedValue("Postgres");
    const result = await h.ask(params);
    expect(h.ui.select).toHaveBeenCalledWith(
      "Storage: Which database?",
      ["Postgres", "SQLite", "Type something…"],
      {},
    );
    expect(result.content[0]!.text).toContain('"Postgres"');
    expect(h.ui.custom).not.toHaveBeenCalled();
  });
});

describe("inline cmux notification lifecycle", () => {
  beforeEach(() => {
    vi.stubEnv("CMUX_SURFACE_ID", "surface");
    execFile.mockImplementation((_cli, args, _options, callback) => {
      callback(null, args[0] === "notify" ? JSON.stringify({ id: NOTIFICATION_ID }) : "OK", "");
    });
  });

  const expectExactCleanup = () => {
    expect(execFile.mock.calls.map((call) => call[1][0])).toEqual([
      "notify",
      "dismiss-notification",
    ]);
    expect(execFile.mock.calls[1]![1]).toEqual(["dismiss-notification", "--id", NOTIFICATION_ID]);
  };

  it.each(["answer", "escape", "abort", "external", "external cancel"])(
    "creates and dismisses exactly its own notice on %s",
    async (exit) => {
      const h = harness();
      await h.start();
      const controller = new AbortController();
      const pending = h.ask(params, controller.signal);
      await h.until(() => h.mounted !== undefined);
      expect(execFile.mock.calls[0]![1]).not.toContain("Which database?");
      if (exit === "answer") h.mounted!.handleInput?.("1");
      else if (exit === "escape") h.mounted!.handleInput?.("\x1b");
      else if (exit === "abort") controller.abort();
      else
        h.events.emit("ask:answer", {
          toolCallId: "call-1",
          ...(exit === "external cancel"
            ? { cancel: true }
            : { answers: [{ questionIndex: 0, text: "DuckDB" }] }),
        });
      const result = await pending;
      expect(result.details.status).toBe(
        ["answer", "external"].includes(exit) ? "answered" : "cancelled",
      );
      expectExactCleanup();
      await h.shutdown();
    },
  );

  it("cleans up on UI failure without replacing the original error or closed event", async () => {
    const h = harness();
    h.ui.custom.mockRejectedValueOnce(new Error("UI failed"));
    await expect(h.ask(params)).rejects.toThrow("UI failed");
    expectExactCleanup();
    expect(h.sent.at(-1)).toEqual(["ask:closed", { toolCallId: "call-1", outcome: "error" }]);
    await h.shutdown();
  });

  it("cleans up even if the opened event handler throws", async () => {
    const h = harness();
    h.events.on("ask:opened", () => {
      throw new Error("event failed");
    });
    await expect(h.ask(params)).rejects.toThrow("event failed");
    await h.until(() => execFile.mock.calls.length === 2);
    expectExactCleanup();
    expect(h.sent.at(-1)).toEqual(["ask:closed", { toolCallId: "call-1", outcome: "error" }]);
    await h.shutdown();
  });

  it("handles external answers before mounting", async () => {
    const h = harness();
    h.events.on("ask:opened", () =>
      h.events.emit("ask:answer", {
        toolCallId: "call-1",
        answers: [{ questionIndex: 0, text: "early" }],
      }),
    );
    const result = await h.ask(params);
    expect(result.details.status).toBe("answered");
    expectExactCleanup();
    await h.shutdown();
  });

  it("handles cancellation from the opened event before mounting", async () => {
    const h = harness();
    const controller = new AbortController();
    h.events.on("ask:opened", () => controller.abort());
    const result = await h.ask(params, controller.signal);
    expect(result.details.status).toBe("cancelled");
    expectExactCleanup();
    await h.shutdown();
  });

  it("does not notify for an already-aborted call", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(h.ask(params, controller.signal)).rejects.toThrow("cancelled before");
    expect(execFile).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
    expect(h.ui.custom).not.toHaveBeenCalled();
  });

  it.each(["rpc", "child", "print"])("does not notify on the %s route", async (route) => {
    if (route === "child") delegated();
    const h = harness(
      route === "child" ? { sessionId: "child" } : { mode: route, hasUI: route === "rpc" },
    );
    h.ui.select.mockResolvedValue("Postgres");
    await h.start();
    if (route === "print") await expect(h.ask(params)).rejects.toThrow("No one can answer");
    else await h.ask(params);
    expect(execFile).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });

  it("never waits for create or cleanup on the normal question path", async () => {
    execFile.mockImplementation(() => {});
    const h = harness();
    const pending = h.ask(params);
    await h.until(() => h.mounted !== undefined);
    h.mounted!.handleInput?.("1");
    expect((await pending).details.status).toBe("answered");
    expect(execFile).toHaveBeenCalledTimes(1);
    execFile.mock.calls[0]![3](null, JSON.stringify({ id: NOTIFICATION_ID }), "");
    await h.until(() => execFile.mock.calls.length === 2);
    expectExactCleanup();
    execFile.mock.calls[1]![3](null, "OK", "");
    await h.shutdown();
  });

  it("keeps the same inline behavior when cmux fails", async () => {
    execFile.mockImplementation((_cli, _args, _options, callback) =>
      callback(new Error("ENOENT"), "", ""),
    );
    const h = harness();
    const pending = h.ask(params);
    await h.until(() => h.mounted !== undefined);
    h.mounted!.handleInput?.("2");
    expect((await pending).content[0]!.text).toContain('"SQLite"');
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(h.ui.notify).not.toHaveBeenCalled();
    await h.shutdown();
  });
});

describe("user_notify", () => {
  const notify = (h: ReturnType<typeof harness>, args: unknown) =>
    h.tools.get("user_notify")!.execute("call-n", args, undefined, undefined, h.ctx);
  const message = { title: "PR 12 is ready for review", body: "Checks are green. https://x/12" };

  it("sends the model's text as a notification that is never dismissed", async () => {
    vi.stubEnv("CMUX_SURFACE_ID", "surface");
    execFile.mockImplementation((_cli, _args, _options, callback) => callback(null, "OK", ""));
    const h = harness();
    await h.start();
    expect(h.tools.get("user_notify")!.exposure).toBe("model-only");
    const result = await notify(h, message);
    expect(result.content[0]!.text).toBe("The user was notified.");
    expect(result.details).toEqual({ ...message, delivered: true });
    expect(execFile.mock.calls[0]![1]).toEqual([
      "notify",
      "--title",
      message.title,
      "--body",
      message.body,
      "--surface",
      "surface",
    ]);
    await h.shutdown();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("strips control sequences and line breaks from what it sends", async () => {
    vi.stubEnv("CMUX_SURFACE_ID", "surface");
    execFile.mockImplementation((_cli, _args, _options, callback) => callback(null, "OK", ""));
    const h = harness();
    await h.start();
    const result = await notify(h, { title: "\x1b[31mred\x1b[0m", body: "one\ntwo" });
    expect(result.details.title).toBe("red");
    expect(result.details.body).not.toContain("\n");
  });

  it("says so, without failing, when no notification can be shown", async () => {
    const h = harness();
    await h.start();
    const result = await notify(h, message);
    expect(result.details.delivered).toBe(false);
    expect(result.content[0]!.text).toContain("transcript only");
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each(["child", "print"])("is hidden and refused on the %s route", async (route) => {
    vi.stubEnv("CMUX_SURFACE_ID", "surface");
    if (route === "child") delegated();
    const h = harness(route === "child" ? { sessionId: "child" } : { mode: "print", hasUI: false });
    await h.start();
    expect(h.tools.get("user_notify")!.exposure).toBe("hidden");
    await expect(notify(h, message)).rejects.toThrow("Only the main session");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("pads its transcript row and warns when nothing was shown", async () => {
    const h = harness();
    await h.start();
    const tool = h.tools.get("user_notify") as unknown as {
      renderResult(
        result: unknown,
        options: { isPartial: boolean },
        theme: unknown,
      ): { render(width: number): string[] };
    };
    const result = await notify(h, { title: "t", body: "宽字符 wide body that will not fit" });
    for (const width of [1, 2, 12, 40]) {
      const rows = tool.renderResult(result, { isPartial: false }, ansiTheme).render(width);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    }
    const wide = tool.renderResult(result, { isPartial: false }, plainTheme).render(60);
    expect(wide[0]).toMatch(/^ 宽字符/);
    expect(wide[1]).toContain("No native notification");
  });
});
