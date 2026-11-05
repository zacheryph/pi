import { describe, expect, it } from "vitest";
import type { TypeListRegistry } from "#src/tools/helpers";
import {
  buildDetails,
  buildTypeListText,
  formatLifetimeTokens,
  getModelLabelFromConfig,
  textResult,
} from "#src/tools/helpers";
import type { AgentConfig } from "#src/types";
import type { AgentDetails } from "#src/ui/display";
import { createTestSubagent } from "#test/helpers/make-subagent";

/** Build a minimal TypeListRegistry stub: `listed` in order, each resolving to its config. */
function makeRegistry(agents: Record<string, Partial<AgentConfig>>): TypeListRegistry {
  return {
    getListedTypes: () => Object.keys(agents),
    resolveAgentConfig: (name: string) => ({
      name,
      description: "",
      promptMode: "replace",
      systemPrompt: "",
      ...agents[name],
    }),
    getToolNamesForType: () => [],
  };
}

describe("textResult", () => {
  it("wraps a message in the tool result shape", () => {
    const result = textResult("hello");
    expect(result).toEqual({
      content: [{ type: "text", text: "hello" }],
      details: undefined,
    });
  });

  it("includes details when provided", () => {
    const details: AgentDetails = {
      displayName: "agent",
      description: "",
      subagentType: "general-purpose",
      toolUses: 0,
      tokens: "",
      durationMs: 0,
      status: "completed",
    };
    const result = textResult("done", details);
    expect(result.details).toBe(details);
  });
});

describe("formatLifetimeTokens", () => {
  it("returns formatted string when tokens > 0", () => {
    const result = formatLifetimeTokens({
      lifetimeUsage: { input: 500, output: 500, cacheWrite: 0 },
    });
    expect(result).toBe("1.0k token");
  });

  it('returns "" when total is zero', () => {
    const result = formatLifetimeTokens({ lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } });
    expect(result).toBe("");
  });

  it("formats large token counts with k suffix", () => {
    const result = formatLifetimeTokens({
      lifetimeUsage: { input: 15000, output: 18800, cacheWrite: 0 },
    });
    expect(result).toBe("33.8k token");
  });
});

describe("getModelLabelFromConfig", () => {
  it("strips provider prefix", () => {
    expect(getModelLabelFromConfig("anthropic/claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("strips trailing date suffix", () => {
    expect(getModelLabelFromConfig("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("strips both provider prefix and date suffix", () => {
    expect(getModelLabelFromConfig("anthropic/claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("returns the string as-is when no prefix or suffix", () => {
    expect(getModelLabelFromConfig("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("handles model with multiple slashes", () => {
    expect(getModelLabelFromConfig("provider/sub/model-name")).toBe("model-name");
  });
});

describe("buildTypeListText", () => {
  it("renders one line per listed agent, in registry order", () => {
    const text = buildTypeListText(
      makeRegistry({
        explore: { description: "Fast exploration" },
        auditor: { description: "Security auditor" },
      }),
    );
    expect(text).toBe("- explore: Fast exploration\n- auditor: Security auditor");
  });

  it("follows the description with the guidance, so the name appears once", () => {
    const text = buildTypeListText(
      makeRegistry({ explore: { description: "Fast exploration", guidance: "Use for searches." } }),
    );
    expect(text).toBe("- explore: Fast exploration. Use for searches.");
  });

  it("does not double a description's own trailing period", () => {
    const text = buildTypeListText(
      makeRegistry({ Plan: { description: "Architect.", guidance: "Use for designs." } }),
    );
    expect(text).toBe("- Plan: Architect. Use for designs.");
  });

  it("collapses a multi-line description and guidance onto one line", () => {
    const text = buildTypeListText(
      makeRegistry({
        Plan: { description: "Software\narchitect", guidance: "Use for\n  designs." },
      }),
    );
    expect(text).toBe("- Plan: Software architect. Use for designs.");
  });

  it("shows the model for any agent that pins one, built-in or custom", () => {
    const text = buildTypeListText(
      makeRegistry({
        explore: { description: "Fast", model: "anthropic/claude-haiku-4-5-20251001" },
        auditor: { description: "Audits", model: "anthropic/claude-opus-4-6" },
      }),
    );
    expect(text).toContain("- explore (claude-haiku-4-5): Fast");
    expect(text).toContain("- auditor (claude-opus-4-6): Audits");
  });

  it("has no section headings and no agent-authoring instructions", () => {
    const text = buildTypeListText(makeRegistry({ auditor: { description: "Audits" } }));
    expect(text).not.toMatch(/Default agents|Custom agents|\.pi\/agents/);
  });

  it("is empty when nothing is listed", () => {
    expect(buildTypeListText(makeRegistry({}))).toBe("");
  });
});

describe("buildDetails", () => {
  const base = {
    displayName: "TestAgent",
    description: "does stuff",
    subagentType: "general-purpose",
    modelName: undefined,
    tags: undefined,
  };
  const record = {
    toolUses: 3,
    startedAt: 1000,
    completedAt: 5000,
    status: "completed",
    error: undefined,
    id: "agent-42",
    lifetimeUsage: { input: 100, output: 50, cacheWrite: 0 },
  };

  it("maps record fields to AgentDetails shape", () => {
    const details = buildDetails(base, record);
    expect(details.toolUses).toBe(3);
    expect(details.durationMs).toBe(4000);
    expect(details.status).toBe("completed");
    expect(details.agentId).toBe("agent-42");
  });

  it("leaves the turn budget undefined when the record has none", () => {
    expect(buildDetails(base, record).turnBudget).toBeUndefined();
  });

  it("carries the record's turn budget", () => {
    const details = buildDetails(
      base,
      createTestSubagent({ turnBudget: { maxTurns: 2, used: 3, phase: "warned" } }),
    );
    expect(details.turnBudget).toEqual({ maxTurns: 2, used: 3, phase: "warned" });
  });

  it("applies overrides on top of computed fields", () => {
    const details = buildDetails(base, record, { tokens: "99.9k token" });
    expect(details.tokens).toBe("99.9k token");
  });

  it("uses Date.now() for durationMs when completedAt is absent", () => {
    const openRecord = { ...record, completedAt: undefined };
    const before = Date.now();
    const details = buildDetails(base, openRecord);
    const after = Date.now();
    expect(details.durationMs).toBeGreaterThanOrEqual(before - openRecord.startedAt);
    expect(details.durationMs).toBeLessThanOrEqual(after - openRecord.startedAt);
  });

  describe("model label", () => {
    const spawnBase = { ...base, modelName: "anthropic/claude-sonnet-5-5" };

    it("labels the model the record runs, over the one resolved at spawn", () => {
      const details = buildDetails(spawnBase, {
        ...record,
        model: { provider: "openai", id: "gpt-5" },
      });
      expect(details.modelName).toBe("openai/gpt-5");
    });

    it("keeps the spawn-time label while the record's model is unknown", () => {
      const details = buildDetails(spawnBase, record);
      expect(details.modelName).toBe("anthropic/claude-sonnet-5-5");
    });
  });
});
