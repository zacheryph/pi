import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piTldr from "../src/index.js";
import { runTldrModel } from "../src/core.js";
import { loadTldrConfig } from "../src/config.js";
import { showTldr } from "../src/viewer.js";

vi.mock("../src/core.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/core.js")>();
  return {
    ...actual,
    runTldrModel: vi.fn(async (_ctx, _model, _prompt, task) =>
      task === "title"
        ? "routing-migration-plan"
        : JSON.stringify({
            title: "routing-rollout-progress",
            premise: "Move routes",
            findings: "Identified dependencies",
            status: "Awaiting PR",
          }),
    ),
  };
});
vi.mock("../src/config.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/config.js")>()),
  loadTldrConfig: vi.fn(() => ({ model: "auto", setSessionName: true })),
}));
vi.mock("../src/viewer.js", () => ({
  showTldr: vi.fn(async (_ctx, load) => {
    await load(new AbortController().signal);
  }),
}));

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
function harness(setSessionName: boolean, existing?: string) {
  vi.mocked(loadTldrConfig).mockReturnValue({ model: "auto", setSessionName });
  const commands = new Map<string, Command>();
  const events = new Map<string, Function>();
  let title = existing;
  const setName = vi.fn((value: string) => {
    title = value;
  });
  const pi = {
    registerCommand: (name: string, value: Command) => commands.set(name, value),
    on: (name: string, cb: Function) => events.set(name, cb),
    setSessionName: setName,
    getSessionName: () => title,
  } as unknown as ExtensionAPI;
  const user = { type: "message", message: { role: "user", content: "Migrate network routes" } };
  let entries: object[] = [];
  const ctx = {
    cwd: "/project",
    mode: "tui",
    hasUI: true,
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setTitle: vi.fn(),
    },
    model: undefined,
    modelRegistry: {
      getAvailable: () => [
        { provider: "anthropic", id: "claude-haiku-4-5", name: "haiku", type: "chat" },
      ],
    },
    sessionManager: {
      getSessionId: () => "session-1",
      getBranch: () => entries,
      buildSessionProjection: () => ({
        messages: [{ role: "user", content: "Migrate network routes" }],
      }),
    },
  } as unknown as ExtensionCommandContext;
  piTldr(pi);
  const emit = (name: string, event: any = {}) => events.get(name)!(event, ctx);
  return {
    pi,
    ctx,
    commands,
    emit,
    setName,
    setEntries: (next: object[]) => {
      entries = next;
    },
    user,
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("pi-tldr integration", () => {
  it("registers /tldr and auto-names after the first prompt without blocking", async () => {
    const h = harness(true);
    h.emit("session_start");
    const outcome = h.emit("before_agent_start", {
      messageType: "user",
      prompt: "Migrate network routes",
    });
    expect(outcome).toBeUndefined();
    await tick();
    expect(h.setName).toHaveBeenCalledWith("routing-migration-plan");
    expect(h.ctx.ui.setTitle).not.toHaveBeenCalled();
    h.emit("before_agent_start", { messageType: "user", prompt: "Second question" });
    await tick();
    expect(vi.mocked(runTldrModel)).toHaveBeenCalledTimes(1);
  });

  it("setSessionName=false blocks BOTH auto and /tldr naming while still summarizing", async () => {
    const h = harness(false);
    h.emit("session_start");
    h.emit("before_agent_start", { messageType: "user", prompt: "Migrate network routes" });
    h.setEntries([h.user]);
    await h.commands.get("tldr")!.handler("", h.ctx);
    expect(vi.mocked(runTldrModel)).toHaveBeenCalledOnce();
    expect(h.setName).not.toHaveBeenCalled();
    expect(h.ctx.ui.setTitle).not.toHaveBeenCalled();
    expect(showTldr).toHaveBeenCalledWith(h.ctx, expect.any(Function));
  });

  it("preserves manual session names when /tldr runs", async () => {
    const h = harness(true, "manual-name");
    h.setEntries([h.user]);
    h.emit("session_start");
    h.emit("before_agent_start", { messageType: "user", prompt: "Ignored" });
    await tick();
    expect(h.setName).not.toHaveBeenCalled();
    await h.commands.get("tldr")!.handler("", h.ctx);
    expect(h.setName).not.toHaveBeenCalled();
  });
  it("does not make paid title requests for headless sessions", async () => {
    const h = harness(true);
    (h.ctx as any).hasUI = false;
    h.emit("session_start");
    h.emit("before_agent_start", { messageType: "user", prompt: "Headless child" });
    await tick();
    expect(runTldrModel).not.toHaveBeenCalled();
  });

  it("uses raw input before template expansion to name a new session", async () => {
    const h = harness(true);
    h.emit("session_start");
    h.emit("input", { source: "interactive", text: "/skill:migrate routing" });
    h.emit("before_agent_start", {
      messageType: "user",
      prompt: "Skill body expanded with 3000 tokens",
    });
    await tick();
    expect(runTldrModel).toHaveBeenCalledWith(
      h.ctx,
      expect.anything(),
      "/skill:migrate routing",
      "title",
      expect.anything(),
    );
  });

  it("allows /tldr to update a name only when it remains extension-generated", async () => {
    const h = harness(true);
    h.emit("session_start");
    h.emit("before_agent_start", { messageType: "user", prompt: "Migrate routes" });
    await tick();
    h.setEntries([h.user]);
    await h.commands.get("tldr")!.handler("", h.ctx);
    expect(h.setName).toHaveBeenLastCalledWith("routing-rollout-progress");
    expect(h.ctx.ui.setTitle).not.toHaveBeenCalled();
    expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
  });
});
