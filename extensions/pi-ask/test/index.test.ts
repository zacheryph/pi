import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { provide, SESSION_TREE_KEY } from "../../../packages/pi-session-tree/src/index.ts";
import piAsk from "../src/index.ts";
import { waitFor } from "../../../packages/pi-test-helpers/src/wait.ts";

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
  }>;
};

const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };

function harness(options: { mode?: string; hasUI?: boolean; sessionId?: string } = {}) {
  const handlers = new Map<string, Function[]>();
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const sent: [string, unknown][] = [];
  const tools = new Map<string, Tool>();
  const registrations: Tool[] = [];
  const events = {
    on: (channel: string, handler: (data: unknown) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
      return () => {};
    },
    emit: (channel: string, data: unknown) => {
      sent.push([channel, data]);
      for (const handler of listeners.get(channel) ?? []) handler(data);
    },
  };
  const pi = {
    on: vi.fn((event: string, handler: Function) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    ),
    registerTool: vi.fn((tool: Tool) => {
      tools.set(tool.name, tool);
      registrations.push(tool);
    }),
    events,
  };
  let mounted: { handleInput?(data: string): void; render(width: number): string[] } | undefined;
  const ui = {
    notify: vi.fn(),
    select: vi.fn(),
    input: vi.fn(),
    custom: vi.fn(async (factory: Function, custom?: unknown) => {
      expect(custom).toBeUndefined();
      return new Promise((resolve) => {
        void Promise.resolve(
          factory(
            { requestRender: vi.fn(), isFollowingOutput: true },
            theme,
            new KeybindingsManager(TUI_KEYBINDINGS),
            resolve,
          ),
        ).then((component) => {
          mounted = component;
        });
      });
    }),
  };
  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    ui,
    sessionManager: { getSessionId: () => options.sessionId ?? "root" },
  } as unknown as ExtensionContext;
  piAsk(pi as unknown as ExtensionAPI);
  const start = async () => {
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
  };
  const shutdown = async () => {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
  };
  const ask = (params: unknown, signal?: AbortSignal, id = "call-1") =>
    tools.get("ask")!.execute(id, params, signal, undefined, ctx);
  const until = (check: () => boolean) => waitFor(check, { interval: 0, timeout: 1000 });
  return {
    pi,
    tools,
    registrations,
    sent,
    events,
    ui,
    ctx,
    start,
    shutdown,
    ask,
    until,
    get mounted() {
      return mounted;
    },
  };
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
  delete (globalThis as Record<symbol, unknown>)[SESSION_TREE_KEY];
});

describe("pi-ask routing", () => {
  it("registers ask as a model-only tool that asks the user", async () => {
    const h = harness();
    await h.start();
    const tool = h.tools.get("ask")!;
    expect(tool.exposure).toBe("model-only");
    expect(tool.description).toContain("Ask the user");
    expect(h.registrations).toHaveLength(1);
  });

  it("hides ask where no one can answer, and refuses a stray call", async () => {
    const h = harness({ mode: "print", hasUI: false });
    await h.start();
    expect(h.tools.get("ask")!.exposure).toBe("hidden");
    await expect(h.ask(params)).rejects.toThrow("No one can answer questions in this session");
  });

  it("turns toward the parent in a child session and records the question for it", async () => {
    const record = vi.fn();
    provide("child", "ask:route", { record });
    const h = harness({ mode: "print", hasUI: false, sessionId: "child" });
    await h.start();
    const tool = h.tools.get("ask")!;
    expect(tool.description).toContain("agent that delegated this task");
    expect(tool.promptSnippet).toContain("then end your turn");
    const result = await h.ask(params);
    expect(record).toHaveBeenCalledWith(
      [
        "[Storage] Which database?",
        "   a) Postgres",
        "   b) SQLite",
        "   (choose one, or answer in your own words)",
      ].join("\n"),
    );
    expect(result.content[0]!.text).toContain("End your turn now");
    expect(result.details).toEqual({
      route: "parent",
      status: "recorded",
      questions: ["Which database?"],
    });
    expect(h.ui.custom).not.toHaveBeenCalled();
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
    if (route === "child") provide("child", "ask:route", { record: vi.fn() });
    const h = harness(
      route === "child" ? { sessionId: "child" } : { mode: route, hasUI: route === "rpc" },
    );
    h.ui.select.mockResolvedValue("Postgres");
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
