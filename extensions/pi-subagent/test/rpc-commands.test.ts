/**
 * The four slash commands in a host without the terminal UI (RPC mode, where `ctx.mode` is "rpc",
 * dialogs work and notifications are dropped): each returns text as a displayed message, or says
 * what to use instead of the overlay.
 */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import subagentsExtension from "#src/index";
import { shownOutput, tempDir } from "#test-helpers";
import { subagentPi } from "#test/helpers/subagent-pi";

/** pi-subagent loaded on a fake `pi` with its settings in a throwaway agent directory. */
function loaded() {
  vi.stubEnv("PI_CODING_AGENT_DIR", tempDir(onTestFinished, "pi-subagent-agent-"));
  // A settings change is saved to the project's .pi directory: keep it out of the repository.
  vi.spyOn(process, "cwd").mockReturnValue(tempDir(onTestFinished, "pi-subagent-project-"));
  onTestFinished(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const { pi } = subagentPi();
  subagentsExtension(pi);
  const handler = (name: string) => {
    const calls = vi.mocked(pi.registerCommand).mock.calls as Array<[string, unknown]>;
    const call = calls.find(([registered]) => registered === name);
    if (!call) throw new Error(`Command not registered: ${name}`);
    return (call[1] as { handler: (args: string, ctx: unknown) => Promise<void> }).handler;
  };
  const shown = () => shownOutput(pi.sendMessage);
  return { pi, handler, shown };
}

/** A command context for `mode`, with dialogs that answer from `choices`. */
function context(mode: "tui" | "rpc" | "print", choices: Array<string | undefined> = []) {
  const ui = {
    notify: vi.fn(),
    custom: vi.fn(async () => undefined),
    select: vi.fn(async (_title: string, options: string[]) => {
      const choice = choices.shift();
      return choice === undefined ? undefined : options.find((option) => option.startsWith(choice));
    }),
    input: vi.fn(async () => undefined),
  };
  const sessionManager = { getEntries: () => [] };
  return {
    ctx: {
      cwd: tempDir(onTestFinished, "pi-subagent-cwd-"),
      mode,
      hasUI: mode !== "print",
      ui,
      sessionManager,
    },
    ui,
  };
}

describe("subagent commands without the terminal UI", () => {
  it("/subagent:watch names the alternatives to the overlay", async () => {
    const { handler, shown } = loaded();
    const { ctx, ui } = context("rpc");
    await handler("subagent:watch")("", ctx);
    expect(ui.notify).not.toHaveBeenCalled();
    expect(shown()).toEqual([
      expect.objectContaining({
        customType: "subagent:output",
        display: true,
        level: "warning",
        text: expect.stringMatching(/needs the terminal UI.*\/subagent:sessions.*subagent_get/),
      }),
    ]);
  });

  it("/subagent:agents lists the agent definitions as text", async () => {
    const { handler, shown } = loaded();
    const { ctx, ui } = context("rpc");
    await handler("subagent:agents")("", ctx);
    expect(ui.custom).not.toHaveBeenCalled();
    const [listing] = shown();
    expect(listing).toMatchObject({ level: "info", display: true });
    expect(listing.text).toMatch(/^Subagent agents \(\d+\), read-only effective definitions:\n- /);
    expect(listing.text).toContain("- general-purpose [visible ·");
  });

  it("/subagent:sessions says there is nothing to view", async () => {
    const { handler, shown } = loaded();
    const { ctx, ui } = context("rpc");
    await handler("subagent:sessions")("", ctx);
    expect(ui.select).not.toHaveBeenCalled();
    expect(shown().map(({ level, text }) => [level, text])).toEqual([
      ["info", "No subagent sessions to view."],
    ]);
  });

  it("/subagent:settings asks through the host's dialogs and reports the change as a message", async () => {
    const { handler, shown } = loaded();
    const { ctx, ui } = context("rpc", ["Mid-run updates"]);
    await handler("subagent:settings")("", ctx);
    expect(ui.select).toHaveBeenCalledOnce();
    expect(ui.notify).not.toHaveBeenCalled();
    const [result] = shown();
    expect(result).toMatchObject({ level: "info", display: true });
    expect(result.text).toMatch(/Mid-run updates/i);
  });

  it("keeps the terminal on notifications for the settings result", async () => {
    const { handler, shown } = loaded();
    const { ctx, ui } = context("tui", ["Mid-run updates"]);
    await handler("subagent:settings")("", ctx);
    expect(ui.notify).toHaveBeenCalledOnce();
    expect(shown()).toEqual([]);
  });

  it("keeps command output out of the model's context", async () => {
    const { pi, handler, shown } = loaded();
    await handler("subagent:watch")("", context("rpc").ctx);
    const [sent] = vi.mocked(pi.sendMessage).mock.calls[0] as [Record<string, unknown>];
    expect(shown()).toHaveLength(1);
    const messages = [
      { role: "user", content: "hi" },
      { role: "custom", ...sent },
      { role: "custom", customType: "subagent:completion", content: "kept", display: true },
    ];
    const registered = vi.mocked(pi.on).mock.calls as Array<[string, unknown]>;
    const contextHandlers = registered
      .filter(([event]) => event === "context")
      .map(([, fn]) => fn as (event: unknown, ctx: unknown) => unknown);
    const results = await Promise.all(contextHandlers.map((fn) => fn({ messages }, {})));
    expect(results).toContainEqual({ messages: [messages[0], messages[2]] });
  });
});
