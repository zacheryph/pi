import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { resolveSpawnConfig } from "#src/tools/spawn-config";
import { makeModel } from "#test/helpers/make-model";

/** Minimal registry with default agents only. */
const testRegistry = new AgentTypeRegistry(() => new Map());

/** Shorthand for building ModelInfo. */
function makeModelInfo(overrides: Partial<Parameters<typeof resolveSpawnConfig>[2]> = {}) {
  return {
    parentModel: makeModel({ id: "claude-sonnet", name: "Claude Sonnet" }),
    modelRegistry: { find: () => undefined, getAll: () => [], getAvailable: () => [] },
    ...overrides,
  };
}

const defaultSettings = { defaultMaxTurns: undefined as number | undefined };

describe("resolveSpawnConfig — type resolution", () => {
  it("resolves a known agent type", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    expect("error" in result && result.error).toBeFalsy();
    if ("error" in result) return;
    expect(result.identity.subagentType).toBe("general-purpose");
    expect(result.identity.fellBack).toBe(false);
  });

  it("falls back to general-purpose for unknown agent type", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "unknown-type", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    expect("error" in result && result.error).toBeFalsy();
    if ("error" in result) return;
    expect(result.identity.subagentType).toBe("general-purpose");
    expect(result.identity.fellBack).toBe(true);
  });

  it("sets displayName from registry", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "Explore", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.identity.displayName).toBe("Explore");
  });

  it("uses displayName from agent config when available", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    // general-purpose config has displayName: "Agent"
    expect(result.identity.displayName).toBe("Agent");
  });
});

describe("resolveSpawnConfig — model resolution", () => {
  it("inherits parent model when no model specified", () => {
    const parentModel = makeModel({ id: "claude-sonnet", name: "Claude Sonnet" });
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo({ parentModel }),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.model).toBe(parentModel);
  });

  it("returns error when user-specified model cannot be resolved", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d", model: "nonexistent-xyz" },
      testRegistry,
      makeModelInfo({ modelRegistry: { find: () => undefined, getAll: () => [], getAvailable: () => [] } }),
      defaultSettings,
    );
    expect("error" in result && result.error).toBeTruthy();
  });
});

describe("resolveSpawnConfig — model label", () => {
  const parentModel = makeModel({ provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" });
  const haiku = makeModel({ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" });
  const registryWithHaiku = {
    find: (provider: string, id: string) => (provider === haiku.provider && id === haiku.id ? haiku : undefined),
    getAll: () => [haiku],
    getAvailable: () => [haiku],
  };

  function modelNameFor(params: Record<string, unknown>, modelInfo: Parameters<typeof resolveSpawnConfig>[2]) {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d", ...params },
      testRegistry,
      modelInfo,
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    return result.presentation.detailBase.modelName;
  }

  it("labels an inherited model even though it matches the parent's", () => {
    expect(modelNameFor({}, makeModelInfo({ parentModel }))).toBe("anthropic/claude-sonnet-5-5");
  });

  it("labels a requested model as provider/id, not its display name", () => {
    expect(
      modelNameFor({ model: "anthropic/claude-haiku-4-5" }, makeModelInfo({ parentModel, modelRegistry: registryWithHaiku })),
    ).toBe("anthropic/claude-haiku-4-5");
  });

  it("leaves the label unset when no model resolved", () => {
    expect(modelNameFor({}, makeModelInfo({ parentModel: undefined }))).toBeUndefined();
  });
});

describe("resolveSpawnConfig — max turns normalization", () => {
  it("normalizes max_turns from params", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d", max_turns: 10 },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.effectiveMaxTurns).toBe(10);
  });

  it("uses settings defaultMaxTurns when no max_turns in params", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      { defaultMaxTurns: 25 },
    );
    if ("error" in result) return;
    expect(result.execution.effectiveMaxTurns).toBe(25);
  });

  it("returns undefined effectiveMaxTurns when neither params nor settings specify", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.effectiveMaxTurns).toBeUndefined();
  });
});

describe("resolveSpawnConfig — invocation fields", () => {
  it("sets runInBackground from params", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d", run_in_background: true },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.runInBackground).toBe(true);
  });

  it("builds agentInvocation snapshot", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d", thinking: "high" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.agentInvocation).toEqual({
      thinking: "high",
      maxTurns: undefined,
      inheritContext: false,
      runInBackground: false,
    });
  });
});

describe("resolveSpawnConfig — detailBase and tags", () => {
  it("builds detailBase with description from params", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "my task" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.presentation.detailBase.description).toBe("my task");
    expect(result.presentation.detailBase.subagentType).toBe("general-purpose");
    expect(result.presentation.detailBase.displayName).toBe("Agent");
  });

  it("includes thinking tag when thinking is set", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d", thinking: "high" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.presentation.agentTags).toContain("thinking: high");
  });

  it("omits mode label for replace-mode agents", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "Explore", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    // Explore has promptMode: "replace" → no mode label, no invocation overrides
    expect(result.presentation.agentTags).toEqual([]);
  });

  it("includes twin tag for append-mode agents like general-purpose", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "general-purpose", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    // general-purpose has promptMode: "append" → gets "twin" label
    expect(result.presentation.agentTags).toContain("twin");
  });

  it("sets tags to undefined on detailBase for replace-mode agents with no invocation overrides", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "Explore", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    // Explore has promptMode: "replace" and no invocation overrides → no tags
    expect(result.presentation.detailBase.tags).toBeUndefined();
  });
});

describe("resolveSpawnConfig — thinking level", () => {
  it("returns an error naming the valid levels for an unrecognized thinking param", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "Explore", prompt: "test", description: "d", thinking: "turbo" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    expect(result).toEqual({
      error:
        'Invalid thinking level "turbo". Valid levels: off, minimal, low, medium, high, xhigh, max.',
    });
  });

  it("resolves a recognized thinking param", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "Explore", prompt: "test", description: "d", thinking: "xhigh" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.execution.thinking).toBe("xhigh");
  });
});

describe("resolveSpawnConfig — minimum turns note", () => {
  const MINIMUM_NOTE =
    "Note: max_turns 1 is below the minimum of 2 (one turn to work, one to answer), so the subagent runs with 2.";

  it("notes a max_turns parameter below the minimum and runs with 2", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "Explore", prompt: "test", description: "d", max_turns: 1 },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.notes).toEqual([MINIMUM_NOTE]);
    expect(result.execution.effectiveMaxTurns).toBe(2);
  });

  it("notes an agent file's max_turns below the minimum", () => {
    const registry = new AgentTypeRegistry(
      () =>
        new Map([
          ["terse", { name: "terse", description: "Terse", systemPrompt: "", promptMode: "append" as const, maxTurns: 1 }],
        ]),
    );
    const result = resolveSpawnConfig(
      { subagent_type: "terse", prompt: "test", description: "d" },
      registry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.notes).toEqual([MINIMUM_NOTE]);
  });

  it("adds no note at the minimum", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "Explore", prompt: "test", description: "d", max_turns: 2 },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.notes).toEqual([]);
  });
});

describe("resolveSpawnConfig — notes", () => {
  it("carries no note for a known agent type", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "Explore", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.notes).toEqual([]);
  });

  it("carries a lock note naming the discarded parameters", () => {
    const lockedRegistry = new AgentTypeRegistry(
      () =>
        new Map([
          [
            "pinned",
            {
              name: "pinned",
              description: "Pinned",
              systemPrompt: "",
              promptMode: "append" as const,
              model: "provider/pinned",
              maxTurns: 7,
              locked: true as const,
            },
          ],
        ]),
    );
    const result = resolveSpawnConfig(
      {
        subagent_type: "pinned",
        prompt: "test",
        description: "d",
        model: "other",
        max_turns: 3,
      },
      lockedRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.notes).toEqual([
      'Note: agent "pinned" locks model, max_turns, so those parameters were ignored.',
    ]);
  });

  it("names a single discarded parameter in the singular", () => {
    const lockedRegistry = new AgentTypeRegistry(
      () =>
        new Map([
          [
            "pinned",
            {
              name: "pinned",
              description: "Pinned",
              systemPrompt: "",
              promptMode: "append" as const,
              model: "provider/pinned",
              locked: ["model"] as const,
            },
          ],
        ]),
    );
    const result = resolveSpawnConfig(
      { subagent_type: "pinned", prompt: "test", description: "d", model: "other" },
      lockedRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.notes).toEqual([
      'Note: agent "pinned" locks model, so the model parameter was ignored.',
    ]);
  });

  it("carries the unknown-type note when the type fell back", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "unknown-type", prompt: "test", description: "d" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.notes).toEqual([
      'Note: Unknown agent type "unknown-type" — using general-purpose.',
    ]);
  });

  it("reports the fallback before the lock when a project pins the fallback agent", () => {
    const pinnedFallback = new AgentTypeRegistry(
      () =>
        new Map([
          [
            "general-purpose",
            {
              name: "general-purpose",
              description: "Pinned general-purpose",
              systemPrompt: "",
              promptMode: "append" as const,
              maxTurns: 7,
              locked: true as const,
            },
          ],
        ]),
    );
    const result = resolveSpawnConfig(
      { subagent_type: "unknown-type", prompt: "test", description: "d", max_turns: 3 },
      pinnedFallback,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.notes).toEqual([
      'Note: Unknown agent type "unknown-type" — using general-purpose.',
      'Note: agent "general-purpose" locks max_turns, so the max_turns parameter was ignored.',
    ]);
  });
});

describe("resolveSpawnConfig — prompt and rawType passthrough", () => {
  it("passes through prompt and rawType", () => {
    const result = resolveSpawnConfig(
      { subagent_type: "Explore", prompt: "search for bugs", description: "bug search" },
      testRegistry,
      makeModelInfo(),
      defaultSettings,
    );
    if ("error" in result) return;
    expect(result.execution.prompt).toBe("search for bugs");
    expect(result.identity.rawType).toBe("Explore");
  });
});
