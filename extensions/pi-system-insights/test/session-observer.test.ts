import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  defineView,
  FORM_VIEW_ID,
  isSessionModel,
  listViews,
  readView,
  SESSION_VIEW_ID,
  VIEW_CHANGED_EVENT,
  type FormModel,
  type FormQuestionnaire,
  type SessionModel,
} from "#surface";
import systemInsights from "#src/index";
import { fakePi, type FakePi } from "#test-helpers";

const usage = (input: number, output: number, cost = 0, cacheRead = 0, cacheWrite = 0): Usage => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

const assistant = (spent: Usage, text = "ok"): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "test",
  provider: "test",
  model: "test",
  usage: spent,
  stopReason: "stop",
  timestamp: 1,
});

type ContextUsage = { tokens: number | null; contextWindow: number; percent: number | null };

interface Context {
  mode: string;
  cwd: string;
  sessionManager: SessionManager;
  model?: { provider: string; id: string; name?: string };
  getContextUsage(): ContextUsage | undefined;
}

function context(sessionManager = SessionManager.inMemory("/project")): Context {
  return {
    mode: "print",
    cwd: "/project",
    sessionManager,
    model: { provider: "anthropic", id: "opus", name: "Opus" },
    getContextUsage: () => ({ tokens: 1_000, contextWindow: 200_000, percent: 0.5 }),
  };
}

/** One extension instance on a session bus, as Pi loads it: no dashboard, no bb. */
function harness(options: { fake?: FakePi; piVersion?: string | undefined } = {}) {
  let now = 1_000;
  let name: string | undefined = "fix-auth";
  let thinking = "medium";
  const fake =
    options.fake ??
    fakePi({ getSessionName: vi.fn(() => name), getThinkingLevel: vi.fn(() => thinking) });
  systemInsights(fake.api, {
    session: {
      now: () => now,
      startedAt: 500,
      piVersion: "piVersion" in options ? options.piVersion : "1.5.2",
    },
  });
  const ctx = context();
  const bus = fake.events;
  /** The published model, checked against the shared contract on every read. */
  const view = (): SessionModel => {
    const model = readView(bus, SESSION_VIEW_ID);
    expect(isSessionModel(model)).toBe(true);
    return model as SessionModel;
  };
  const announcements = () =>
    bus
      .published(VIEW_CHANGED_EVENT)
      .filter((event) => (event as { id: string }).id === SESSION_VIEW_ID).length;
  return {
    fake,
    bus,
    ctx,
    view,
    announcements,
    emit: (event: string, payload: object = {}, at: Context = ctx) => fake.emit(event, payload, at),
    start: (reason = "startup", at: Context = ctx) => fake.emit("session_start", { reason }, at),
    tick: (ms: number) => {
      now += ms;
    },
    setName: (value: string | undefined) => {
      name = value;
    },
    setThinking: (value: string) => {
      thinking = value;
    },
  };
}

const questionnaire = (id: string, title?: string, openedAt?: number): FormQuestionnaire => ({
  id,
  ...(title ? { title } : {}),
  ...(openedAt !== undefined ? { openedAt } : {}),
  questions: [
    { question: "Which database?", header: "Database", options: [{ label: "Postgres" }] },
  ],
  submit: { action: "ask.submit", args: { id } },
  cancel: { action: "ask.cancel", args: { id } },
});

describe("system.session view", () => {
  it("is published at session start with no adapter loaded, and not before", async () => {
    const h = harness();
    expect(listViews(h.bus)).toEqual([]);
    await h.start();
    expect(listViews(h.bus)).toEqual([{ id: SESSION_VIEW_ID, kind: "session", title: "Session" }]);
    expect(h.announcements()).toBe(1);
    expect(h.view()).toEqual({
      sessionId: h.ctx.sessionManager.getSessionId(),
      cwd: "/project",
      name: "fix-auth",
      model: { provider: "anthropic", id: "opus", name: "Opus" },
      thinking: "medium",
      context: { tokens: 1_000, window: 200_000, percent: 0.5 },
      status: { kind: "idle", since: 1_000 },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      startedAt: 500,
      piVersion: "1.5.2",
    });
  });

  it("publishes in every mode", async () => {
    for (const mode of ["tui", "rpc", "print", "json"]) {
      const h = harness();
      await h.start("startup", { ...h.ctx, mode });
      expect(h.view().sessionId).toBe(h.ctx.sessionManager.getSessionId());
    }
  });

  it("builds a valid model when optional metadata is missing", async () => {
    const fake = fakePi({ getSessionName: () => undefined, getThinkingLevel: () => undefined });
    const h = harness({ fake, piVersion: undefined });
    const bare = { ...context(), model: undefined, getContextUsage: () => undefined };
    await h.start("startup", bare);
    expect(h.view()).toEqual({
      sessionId: bare.sessionManager.getSessionId(),
      cwd: "/project",
      status: { kind: "idle", since: 1_000 },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      startedAt: 500,
    });
  });

  it("follows model, thinking, name and context changes, announcing each", async () => {
    const h = harness();
    await h.start();
    const before = h.announcements();
    h.ctx.model = { provider: "openai", id: "gpt" };
    await h.emit("model_select");
    expect(h.view().model).toEqual({ provider: "openai", id: "gpt" });
    h.setThinking("high");
    await h.emit("thinking_level_select");
    expect(h.view().thinking).toBe("high");
    h.setName(undefined);
    await h.emit("session_info_changed");
    expect(h.view()).not.toHaveProperty("name");
    h.ctx.getContextUsage = () => ({ tokens: 150_000, contextWindow: 200_000, percent: 75 });
    await h.emit("turn_end");
    expect(h.view().context).toEqual({ tokens: 150_000, window: 200_000, percent: 75 });
    expect(h.announcements()).toBe(before + 4);
  });

  it("reads through the context of the latest event", async () => {
    const h = harness();
    await h.start();
    const later = { ...context(h.ctx.sessionManager), cwd: "/elsewhere", model: undefined };
    await h.emit("turn_end", {}, later);
    expect(h.view().cwd).toBe("/elsewhere");
    expect(h.view()).not.toHaveProperty("model");
  });

  it("reads without announcing anything", async () => {
    const h = harness();
    await h.start();
    const emitted = h.bus.published(VIEW_CHANGED_EVENT).length;
    h.view();
    h.view();
    expect(h.bus.published(VIEW_CHANGED_EVENT)).toHaveLength(emitted);
  });

  it("tracks working, top-level tools and their activity, live while running", async () => {
    const h = harness();
    await h.start();
    h.tick(10);
    await h.emit("agent_start");
    expect(h.view().status).toEqual({ kind: "working", since: 1_010 });
    h.tick(10);
    await h.emit("tool_execution_start", {
      toolCallId: "a",
      toolName: "bash",
      args: { command: "npm test\necho done" },
    });
    expect(h.view().status).toEqual({ kind: "tool", tool: "bash", since: 1_020 });
    expect(h.view().activity).toEqual([
      { tool: "bash", summary: "npm test", at: 1_020, live: true },
    ]);
    h.tick(30);
    await h.emit("tool_execution_end", { toolCallId: "a", toolName: "bash", isError: true });
    expect(h.view().status).toEqual({ kind: "working", since: 1_050 });
    expect(h.view().activity).toEqual([
      { tool: "bash", summary: "npm test", at: 1_020, durationMs: 30, error: true },
    ]);
  });

  it("leaves nested tool calls under their parent", async () => {
    const h = harness();
    await h.start();
    await h.emit("agent_start");
    await h.emit("tool_execution_start", { toolCallId: "p", toolName: "codemode", args: {} });
    const before = h.announcements();
    await h.emit("tool_execution_start", {
      toolCallId: "p/1",
      toolName: "read",
      args: { path: "a.ts" },
      parentToolCallId: "p",
    });
    expect(h.view().status).toMatchObject({ kind: "tool", tool: "codemode" });
    await h.emit("tool_execution_end", {
      toolCallId: "p/1",
      toolName: "read",
      isError: false,
      parentToolCallId: "p",
    });
    expect(h.announcements()).toBe(before);
    expect(h.view().activity?.map((call) => call.tool)).toEqual(["codemode"]);
    expect(h.view().status).toMatchObject({ kind: "tool", tool: "codemode" });
  });

  it("settles a run: interrupted tools stop being live and the status is idle", async () => {
    const h = harness();
    await h.start();
    await h.emit("agent_start");
    await h.emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: {} });
    await h.emit("session_before_compact");
    await h.emit("agent_settled", { aborted: true });
    expect(h.view().status.kind).toBe("idle");
    expect(h.view().activity).toEqual([{ tool: "bash", at: 1_000 }]);
  });

  it("shows compaction above a tool, and clears it when compaction succeeds or fails", async () => {
    const h = harness();
    await h.start();
    await h.emit("agent_start");
    await h.emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: {} });
    await h.emit("session_before_compact");
    expect(h.view().status.kind).toBe("compacting");
    await h.emit("session_compact_failed", { aborted: false, errorMessage: "model refused" });
    expect(h.view().status).toMatchObject({ kind: "tool", tool: "bash" });

    await h.emit("session_before_compact");
    const first = h.ctx.sessionManager.appendMessage(assistant(usage(10, 1)));
    h.ctx.sessionManager.appendCompaction("Summary", first, 500, undefined, false, usage(40, 4));
    await h.emit("session_compact");
    expect(h.view().status).toMatchObject({ kind: "tool", tool: "bash" });
    expect(h.view().usage).toMatchObject({ input: 50, output: 5 });
  });

  it("waits on a native dialog above everything else", async () => {
    const h = harness();
    await h.start();
    await h.emit("agent_start");
    await h.emit("session_before_compact");
    await h.emit("ui_prompt_start", { kind: "confirm", title: "Overwrite plan.md?" });
    expect(h.view().status).toMatchObject({ kind: "waiting", title: "Overwrite plan.md?" });
    await h.emit("ui_prompt_end", { kind: "confirm" });
    expect(h.view().status.kind).toBe("compacting");
  });
});

describe("waiting on surface forms", () => {
  async function withForm() {
    const h = harness();
    await h.start();
    await h.emit("agent_start");
    let form: FormModel | undefined;
    const remove = defineView(h.bus, {
      id: FORM_VIEW_ID,
      kind: "form",
      title: "Questions",
      model: () => form,
    });
    const set = (next: FormModel | undefined) => {
      form = next;
      h.bus.emit(VIEW_CHANGED_EVENT, { version: 1, id: FORM_VIEW_ID });
    };
    return { ...h, set, remove };
  }

  it("waits while an ask.questions form has an open questionnaire, with no native dialog", async () => {
    const h = await withForm();
    expect(h.view().status.kind).toBe("working");
    h.tick(5);
    h.set({ questionnaires: [questionnaire("call-1", "Pick a database", 3)] });
    expect(h.view().status).toEqual({ kind: "waiting", title: "Pick a database", since: 1_005 });
    h.tick(5);
    h.set({ questionnaires: [] });
    expect(h.view().status).toEqual({ kind: "working", since: 1_010 });
    h.set({ questionnaires: [questionnaire("call-2")] });
    // Without a title, the first question's header names what asks.
    expect(h.view().status).toMatchObject({ kind: "waiting", title: "Database" });
    h.remove();
    expect(h.view().status.kind).toBe("working");
  });

  it("names the oldest questionnaire across form views", async () => {
    const h = await withForm();
    defineView(h.bus, {
      id: "other.form",
      kind: "form",
      title: "Other",
      model: () => ({ questionnaires: [questionnaire("x", "Older", 1)] }),
    });
    h.set({ questionnaires: [questionnaire("y", "Newer", 2)] });
    expect(h.view().status).toMatchObject({ kind: "waiting", title: "Older" });
  });

  it("sees a form that was open before the observer started", async () => {
    const h = harness();
    defineView(h.bus, {
      id: FORM_VIEW_ID,
      kind: "form",
      title: "Questions",
      model: () => ({ questionnaires: [questionnaire("call-1", "Already asked")] }),
    });
    await h.start();
    expect(h.view().status).toMatchObject({ kind: "waiting", title: "Already asked" });
  });

  it("announces once per waiting change and never wakes on its own announcements", async () => {
    const h = await withForm();
    const read = vi.fn(() => ({ questionnaires: [questionnaire("q", "Asked")] }));
    h.remove();
    defineView(h.bus, { id: FORM_VIEW_ID, kind: "form", title: "Questions", model: read });
    expect(h.view().status).toMatchObject({ kind: "waiting", title: "Asked" });
    const reads = read.mock.calls.length;
    // Our own announcement does not make the observer read forms again.
    h.bus.emit(VIEW_CHANGED_EVENT, { version: 1, id: SESSION_VIEW_ID });
    expect(read.mock.calls.length).toBe(reads);
    const announced = h.announcements();
    // An unrelated announcement re-reads forms but announces only on a change.
    h.bus.emit(VIEW_CHANGED_EVENT, { version: 1, id: "todo.widget" });
    expect(h.announcements()).toBe(announced);
    h.view();
    expect(h.announcements()).toBe(announced);
  });

  it("ignores a failing or empty form view", async () => {
    const h = await withForm();
    h.remove();
    defineView(h.bus, {
      id: FORM_VIEW_ID,
      kind: "form",
      title: "Questions",
      model: () => {
        throw new Error("broken");
      },
    });
    expect(h.view().status.kind).toBe("working");
  });

  it("stops observing forms after shutdown", async () => {
    const h = await withForm();
    await h.emit("session_shutdown", { reason: "quit" });
    const before = h.bus.published(VIEW_CHANGED_EVENT).length;
    h.set({ questionnaires: [questionnaire("late")] });
    expect(h.bus.published(VIEW_CHANGED_EVENT)).toHaveLength(before + 1);
  });
});

describe("session lifecycle", () => {
  it("removes the view at shutdown without announcing it", async () => {
    const h = harness();
    await h.start();
    const before = h.bus.published(VIEW_CHANGED_EVENT).length;
    await h.emit("session_shutdown", { reason: "quit" });
    expect(listViews(h.bus)).toEqual([]);
    expect(h.bus.published(VIEW_CHANGED_EVENT)).toHaveLength(before);
    await h.emit("turn_end");
    expect(h.bus.published(VIEW_CHANGED_EVENT)).toHaveLength(before);
  });

  it("starts over on reload: one provider, idle, no activity", async () => {
    const h = harness();
    await h.start();
    await h.emit("agent_start");
    await h.emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: {} });
    await h.emit("session_shutdown", { reason: "reload" });
    // Pi tears the old runtime down and runs the factory again on the same bus.
    const reloaded = harness({
      fake: fakePi({ events: h.bus, getSessionName: () => "x", getThinkingLevel: () => "off" }),
    });
    reloaded.tick(50);
    await reloaded.start("reload", h.ctx);
    expect(listViews(h.bus)).toHaveLength(1);
    const model = h.view();
    expect(model.status).toEqual({ kind: "idle", since: 1_050 });
    expect(model).not.toHaveProperty("activity");
  });

  it("starts over when the session is replaced, rebuilding usage from the new history", async () => {
    const h = harness();
    await h.start();
    await h.emit("agent_start");
    await h.emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: {} });
    await h.emit("session_before_compact");
    await h.emit("ui_prompt_start", { kind: "select", title: "Pick" });
    await h.emit("session_shutdown", { reason: "resume" });

    // The resumed session ended with a tool call that never got its result.
    const resumed = SessionManager.inMemory("/project");
    resumed.appendMessage(assistant(usage(100, 10, 0.25)));
    resumed.appendMessage({
      ...assistant(usage(5, 1)),
      content: [{ type: "toolCall", id: "old", name: "bash", arguments: {} }],
      stopReason: "toolUse",
    });
    h.tick(100);
    await h.start("resume", context(resumed));
    const model = h.view();
    expect(model.sessionId).toBe(resumed.getSessionId());
    expect(model.sessionId).not.toBe(h.ctx.sessionManager.getSessionId());
    expect(model.status).toEqual({ kind: "idle", since: 1_100 });
    expect(model).not.toHaveProperty("activity");
    expect(model.usage).toEqual({
      input: 105,
      output: 11,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.25,
    });
    expect(listViews(h.bus)).toHaveLength(1);
  });

  it("gives each child session its own observer on its own bus", async () => {
    const parent = harness();
    const child = harness();
    await parent.start();
    await child.start("startup", context(SessionManager.inMemory("/project/child")));
    await child.emit("agent_start");
    await child.emit("tool_execution_start", { toolCallId: "c", toolName: "read", args: {} });
    expect(child.view().status).toMatchObject({ kind: "tool", tool: "read" });
    expect(parent.view().status.kind).toBe("idle");
    expect(parent.view().sessionId).not.toBe(child.view().sessionId);
    await child.emit("session_shutdown", { reason: "quit" });
    expect(listViews(child.bus)).toEqual([]);
    expect(listViews(parent.bus)).toHaveLength(1);
  });
});

describe("usage totals", () => {
  it("counts every branch and compaction record, like /session", async () => {
    const h = harness();
    const manager = h.ctx.sessionManager;
    const root = manager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
    manager.appendMessage(assistant(usage(100, 20, 0.5, 1_000, 50)));
    // An abandoned branch still billed.
    manager.branch(root);
    manager.appendMessage(assistant(usage(30, 3, 0.1)));
    manager.branchWithSummary(root, "Tried another way", undefined, false, usage(1, 1, 0.01));
    manager.appendCompaction("Summary", root, 900, undefined, false, usage(40, 10, 0.2));
    manager.appendUsage("cache_warm", "test", "test", usage(7, 3, 0.02));
    manager.appendCustomEntry("other", { usage: usage(999, 999, 99) });
    await h.start();
    expect(h.view().usage).toEqual({
      input: 178,
      output: 37,
      cacheRead: 1_000,
      cacheWrite: 50,
      cost: expect.closeTo(0.83, 10),
    });
  });

  it("scans history only after it changes, not on status-only refreshes", async () => {
    const h = harness();
    const getEntries = vi.spyOn(h.ctx.sessionManager, "getEntries");
    await h.start();
    h.view();
    expect(getEntries).toHaveBeenCalledOnce();
    await h.emit("agent_start");
    await h.emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: {} });
    await h.emit("tool_execution_end", { toolCallId: "a", toolName: "bash", isError: false });
    await h.emit("ui_prompt_start", { kind: "input" });
    await h.emit("ui_prompt_end", { kind: "input" });
    await h.emit("turn_end");
    h.view();
    h.view();
    expect(getEntries).toHaveBeenCalledOnce();

    h.ctx.sessionManager.appendMessage(assistant(usage(10, 2)));
    await h.emit("message_end");
    expect(h.view().usage).toMatchObject({ input: 10, output: 2 });
    h.view();
    expect(getEntries).toHaveBeenCalledTimes(2);

    h.ctx.sessionManager.branchWithSummary(null, "Back", undefined, false, usage(3, 1));
    await h.emit("session_tree");
    expect(h.view().usage).toMatchObject({ input: 13, output: 3 });
    expect(getEntries).toHaveBeenCalledTimes(3);
  });
});
