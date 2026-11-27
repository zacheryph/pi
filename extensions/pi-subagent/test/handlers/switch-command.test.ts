import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  handoffInstructions,
  profilesAction,
  runSwitchCommand,
  switchAction,
  type SwitchCommandDeps,
} from "#src/handlers/switch-command";
import type { AgentConfig } from "#src/types";
import { makeAgentConfig } from "#test/helpers/make-agent-config";

const profiles: AgentConfig[] = [
  makeAgentConfig({ name: "orchestrate", description: "Project manager" }),
  makeAgentConfig({ name: "dig", description: "Investigator", handoff: "Known and Open." }),
];

type Compact = Parameters<ExtensionCommandContext["compact"]>[0];

function setup(
  options: {
    current?: string;
    hasUI?: boolean;
    select?: string | undefined;
    compact?: (o: Compact) => void;
    activates?: boolean;
    idle?: boolean;
  } = {},
) {
  const shown: Array<{ text: string; level: string }> = [];
  let current = profiles.find((p) => p.name === (options.current ?? "orchestrate"));
  const compact = vi.fn(options.compact ?? ((o: Compact) => o?.onComplete?.({} as never)));
  const ctx = {
    hasUI: options.hasUI ?? true,
    ui: { select: vi.fn(async () => options.select) },
    waitForIdle: vi.fn(async () => {}),
    isIdle: () => options.idle ?? true,
    compact,
  } as unknown as ExtensionCommandContext;
  const activate = vi.fn(async (_ctx, name: string) => {
    if (options.activates === false) return false;
    current = profiles.find((p) => p.name === name);
    return true;
  });
  const deps: SwitchCommandDeps = {
    profiles: () => profiles,
    resolve: (name) => {
      const found = profiles.find((p) => p.name === name);
      if (!found) throw new Error(`Unknown main agent profile: "${name}".`);
      return found;
    },
    current: () => current,
    activate,
    show: (_ctx, text, level) => shown.push({ text, level }),
  };
  return { ctx, deps, shown, compact, activate };
}

describe("handoffInstructions", () => {
  it("names both profiles, keeps identifiers exactly, and adds the handoff and focus", () => {
    const text = handoffInstructions(
      { name: "dig", handoff: "Known and Open." },
      { name: "orchestrate" },
      "  the rack 12 traceroutes ",
    );
    expect(text).toContain("from the orchestrate agent profile to the dig agent profile");
    expect(text).toContain("Leave out how the previous profile worked");
    expect(text).toContain("Copy these exactly, never paraphrased: stash handles");
    expect(text).toContain("pull request URLs");
    expect(text).toContain("What dig needs from this conversation:\nKnown and Open.");
    expect(text).toContain("The user also asked to keep: the rack 12 traceroutes");
  });

  it("leaves out the parts it has nothing for", () => {
    const text = handoffInstructions({ name: "review" }, undefined, "");
    expect(text).toContain("hands the conversation to the review agent profile");
    expect(text).not.toContain("What review needs");
    expect(text).not.toContain("also asked to keep");
  });
});

describe("runSwitchCommand", () => {
  it("compacts with the target's instructions, then switches", async () => {
    const h = setup();
    await runSwitchCommand("dig the rack 12 notes", h.ctx, h.deps);
    expect(h.ctx.waitForIdle).toHaveBeenCalled();
    const instructions = h.compact.mock.calls[0]![0]!.customInstructions!;
    expect(instructions).toContain("Known and Open.");
    expect(instructions).toContain("The user also asked to keep: the rack 12 notes");
    expect(h.activate).toHaveBeenCalledWith(h.ctx, "dig");
    expect(h.shown.at(-1)).toEqual({ text: "Compacted for dig and switched.", level: "info" });
  });

  it("still switches when the session is too small to compact", async () => {
    const h = setup({
      compact: (o) => o?.onError?.(new Error("Nothing to compact (session too small)")),
    });
    await runSwitchCommand("dig", h.ctx, h.deps);
    expect(h.activate).toHaveBeenCalled();
    expect(h.shown.at(-1)?.text).toBe("Nothing to compact; switched to dig.");
  });

  it("keeps the current profile when compaction fails", async () => {
    const h = setup({ compact: (o) => o?.onError?.(new Error("Compaction cancelled")) });
    await runSwitchCommand("dig", h.ctx, h.deps);
    expect(h.activate).not.toHaveBeenCalled();
    expect(h.shown.at(-1)).toMatchObject({ level: "error" });
    expect(h.shown.at(-1)?.text).toContain("orchestrate keeps running: Compaction cancelled");
    expect(h.shown.at(-1)?.text).toContain("/model agent/dig");
  });

  it("says nothing more when the profile reports its own failure", async () => {
    const h = setup({ activates: false });
    await runSwitchCommand("dig", h.ctx, h.deps);
    expect(h.shown.map((s) => s.text)).toEqual(["Compacting for dig…"]);
  });

  it("does nothing for the profile already running", async () => {
    const h = setup({ current: "dig" });
    await runSwitchCommand("dig", h.ctx, h.deps);
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.shown).toEqual([{ text: "Already running dig.", level: "info" }]);
  });

  it("reports an unknown profile with the ones that exist, before compacting", async () => {
    const h = setup();
    await runSwitchCommand("nope", h.ctx, h.deps);
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.shown[0]?.level).toBe("error");
    expect(h.shown[0]?.text).toContain('Unknown main agent profile: "nope".');
    expect(h.shown[0]?.text).toContain("Profiles: orchestrate (running), dig");
  });

  it("offers the other profiles when no name is given", async () => {
    const h = setup({ select: "dig — Investigator" });
    await runSwitchCommand("", h.ctx, h.deps);
    expect(h.ctx.ui.select).toHaveBeenCalledWith("Compact and switch to", ["dig — Investigator"]);
    expect(h.activate).toHaveBeenCalledWith(h.ctx, "dig");
  });

  it("does nothing when the picker is dismissed", async () => {
    const h = setup({ select: undefined });
    await runSwitchCommand("", h.ctx, h.deps);
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.shown).toEqual([]);
  });

  it("shows usage without a dialog-capable UI", async () => {
    const h = setup({ hasUI: false });
    await runSwitchCommand("  ", h.ctx, h.deps);
    expect(h.ctx.ui.select).not.toHaveBeenCalled();
    expect(h.shown[0]?.text).toContain("Usage: /subagent:switch <profile> [what to keep]");
  });
});

describe("profilesAction", () => {
  it("lists each profile with its description and marks the one running", async () => {
    const h = setup({ current: "dig" });
    const action = profilesAction(() => h.ctx, h.deps);
    expect(action.id).toBe("subagent.profiles");
    expect(await action.handler(action.parse!(undefined))).toEqual({
      profiles: [
        { name: "orchestrate", description: "Project manager", running: false },
        { name: "dig", description: "Investigator", running: true },
      ],
    });
  });
});

describe("switchAction", () => {
  const run = async (h: ReturnType<typeof setup>, args: unknown) => {
    const action = switchAction(() => h.ctx, h.deps);
    return action.handler(action.parse!(args as never));
  };

  it("answers at once, then compacts for the profile and switches", async () => {
    let finish: (() => void) | undefined;
    const h = setup({ compact: (o) => (finish = () => o?.onComplete?.({} as never)) });
    expect(await run(h, { profile: "dig", keep: "the rack 12 notes" })).toEqual({
      switching: "dig",
    });
    const instructions = h.compact.mock.calls[0]![0]!.customInstructions!;
    expect(instructions).toContain("The user also asked to keep: the rack 12 notes");
    expect(h.activate).not.toHaveBeenCalled();
    finish!();
    await vi.waitFor(() => expect(h.shown.at(-1)?.text).toBe("Compacted for dig and switched."));
  });

  it("refuses an unknown profile, the running one, and a busy session before compacting", async () => {
    await expect(run(setup(), { profile: "nope" })).rejects.toThrow(
      'Unknown main agent profile: "nope".',
    );
    await expect(run(setup({ current: "dig" }), { profile: "dig" })).rejects.toThrow(
      "Already running dig.",
    );
    const busy = setup({ idle: false });
    await expect(run(busy, { profile: "dig" })).rejects.toThrow("Pi is working");
    expect(busy.compact).not.toHaveBeenCalled();
  });

  it("refuses a second switch while one is under way", async () => {
    const h = setup({ compact: () => {} });
    const action = switchAction(() => h.ctx, h.deps);
    await action.handler({ profile: "dig", keep: "" });
    expect(() => action.handler({ profile: "dig", keep: "" })).toThrow("Already switching to dig.");
  });

  it("checks its arguments", () => {
    const action = switchAction(() => setup().ctx, setup().deps);
    expect(() => action.parse!({})).toThrow("expected { profile }");
    expect(() => action.parse!({ profile: "dig", keep: 3 })).toThrow("keep must be text");
    expect(action.parse!({ profile: " dig " })).toEqual({ profile: "dig", keep: "" });
  });
});
