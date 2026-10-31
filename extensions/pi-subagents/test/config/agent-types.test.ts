import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { AgentConfig } from "#src/types";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "Test agent",
    toolNames: ["read", "grep"],
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    ...overrides,
  };
}

describe("AgentTypeRegistry", () => {
  function makeRegistry(userAgents: Map<string, AgentConfig> = new Map()): AgentTypeRegistry {
    return new AgentTypeRegistry(() => userAgents);
  }

  describe("construction and reload", () => {
    it("loads default agents on construction", () => {
      const registry = makeRegistry();
      expect(registry.isValidType("general-purpose")).toBe(true);
      expect(registry.isValidType("orchestrator")).toBe(true);
      expect(registry.isValidType("Explore")).toBe(true);
      expect(registry.isValidType("Plan")).toBe(true);
    });

    it("does not call loadUserAgents until construction", () => {
      let callCount = 0;
      const registry = new AgentTypeRegistry(() => {
        callCount++;
        return new Map();
      });
      // constructor calls reload() once
      expect(callCount).toBe(1);
      registry.reload();
      expect(callCount).toBe(2);
    });

    it("reload picks up new agents from loader", () => {
      let userAgents = new Map<string, AgentConfig>();
      const registry = new AgentTypeRegistry(() => userAgents);

      expect(registry.isValidType("auditor")).toBe(false);

      userAgents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      registry.reload();

      expect(registry.isValidType("auditor")).toBe(true);
    });

    it("reload clears previous user agents", () => {
      const userAgents = new Map([["auditor", makeAgentConfig({ name: "auditor" })]]);
      const registry = new AgentTypeRegistry(() => userAgents);
      expect(registry.isValidType("auditor")).toBe(true);

      userAgents.clear();
      registry.reload();

      expect(registry.isValidType("auditor")).toBe(false);
      expect(registry.isValidType("general-purpose")).toBe(true);
    });
  });

  describe("resolveType", () => {
    it("returns canonical key for exact match", () => {
      const registry = makeRegistry();
      expect(registry.resolveType("Explore")).toBe("Explore");
      expect(registry.resolveType("general-purpose")).toBe("general-purpose");
    });

    it("returns canonical key for case-insensitive match", () => {
      const registry = makeRegistry();
      expect(registry.resolveType("explore")).toBe("Explore");
      expect(registry.resolveType("GENERAL-PURPOSE")).toBe("general-purpose");
    });

    it("returns undefined for unknown type", () => {
      const registry = makeRegistry();
      expect(registry.resolveType("nonexistent")).toBeUndefined();
    });
  });

  describe("resolveAgentConfig", () => {
    it("returns config for a known enabled type", () => {
      const registry = makeRegistry();
      const config = registry.resolveAgentConfig("Explore");
      expect(config.name).toBe("Explore");
      expect(config.promptMode).toBe("replace");
    });

    it("performs case-insensitive lookup", () => {
      const registry = makeRegistry();
      const config = registry.resolveAgentConfig("explore");
      expect(config.name).toBe("Explore");
    });

    it("falls back to general-purpose for unknown type", () => {
      const registry = makeRegistry();
      const config = registry.resolveAgentConfig("nonexistent");
      expect(config.name).toBe("general-purpose");
    });

    it("returns config for disabled type (no fallback for existing disabled)", () => {
      const registry = makeRegistry(
        new Map([["Plan", makeAgentConfig({ name: "Plan", description: "Disabled", enabled: false })]])
      );
      const config = registry.resolveAgentConfig("Plan");
      expect(config.name).toBe("Plan");
      expect(config.enabled).toBe(false);
    });

    it("returns user-defined agent config", () => {
      const registry = makeRegistry(
        new Map([["auditor", makeAgentConfig({ name: "auditor", description: "Security auditor" })]])
      );
      const config = registry.resolveAgentConfig("auditor");
      expect(config.name).toBe("auditor");
      expect(config.description).toBe("Security auditor");
    });
  });

  describe("getAvailableTypes", () => {
    it("includes all enabled defaults", () => {
      const registry = makeRegistry();
      const types = registry.getAvailableTypes();
      expect(types).toContain("general-purpose");
      expect(types).toContain("Explore");
      expect(types).toContain("Plan");
    });

    it("excludes disabled agents", () => {
      const registry = makeRegistry(
        new Map([["Plan", makeAgentConfig({ name: "Plan", enabled: false })]])
      );
      expect(registry.getAvailableTypes()).not.toContain("Plan");
    });

    it("includes user agents", () => {
      const registry = makeRegistry(
        new Map([["auditor", makeAgentConfig({ name: "auditor" })]])
      );
      expect(registry.getAvailableTypes()).toContain("auditor");
    });
  });

  describe("getAllTypes", () => {
    it("includes disabled agents", () => {
      const registry = makeRegistry(
        new Map([["Plan", makeAgentConfig({ name: "Plan", enabled: false })]])
      );
      expect(registry.getAllTypes()).toContain("Plan");
    });
  });

  describe("getDefaultAgentNames", () => {
    it("returns only default agents", () => {
      const registry = makeRegistry(
        new Map([["auditor", makeAgentConfig({ name: "auditor" })]])
      );
      const names = registry.getDefaultAgentNames();
      expect(names).toContain("general-purpose");
      expect(names).toContain("Explore");
      expect(names).toContain("Plan");
      expect(names).not.toContain("auditor");
    });
  });

  describe("getUserAgentNames", () => {
    it("returns only user agents", () => {
      const registry = makeRegistry(
        new Map([
          ["auditor", makeAgentConfig({ name: "auditor" })],
          ["linter", makeAgentConfig({ name: "linter" })],
        ])
      );
      const names = registry.getUserAgentNames();
      expect(names).toEqual(["auditor", "linter"]);
      expect(names).not.toContain("general-purpose");
    });
  });

  describe("isValidType", () => {
    it("returns true for enabled defaults", () => {
      const registry = makeRegistry();
      expect(registry.isValidType("general-purpose")).toBe(true);
      expect(registry.isValidType("Explore")).toBe(true);
    });

    it("returns true case-insensitively", () => {
      const registry = makeRegistry();
      expect(registry.isValidType("explore")).toBe(true);
      expect(registry.isValidType("PLAN")).toBe(true);
    });

    it("returns false for disabled agents", () => {
      const registry = makeRegistry(
        new Map([["Plan", makeAgentConfig({ name: "Plan", enabled: false })]])
      );
      expect(registry.isValidType("Plan")).toBe(false);
    });

    it("returns false for unknown types", () => {
      const registry = makeRegistry();
      expect(registry.isValidType("nonexistent")).toBe(false);
      expect(registry.isValidType("")).toBe(false);
    });
  });

  describe("getToolNamesForType", () => {
    it("selects all available tools for general-purpose", () => {
      const registry = makeRegistry();
      const names = registry.getToolNamesForType("general-purpose");
      expect(names).toEqual(["all"]);
    });

    it("returns restricted tools for Explore", () => {
      const registry = makeRegistry();
      const names = registry.getToolNamesForType("Explore");
      expect(names).toEqual(["read", "bash", "grep", "find", "ls", "stash_get", "stash_list", "stash_put"]);
    });

    it("lets Plan read the stash but not write to it", () => {
      const registry = makeRegistry();
      expect(registry.getToolNamesForType("Plan")).toEqual(["read", "bash", "grep", "find", "ls", "stash_get", "stash_list"]);
    });

    it("lets reviewer read and run checks without stash or edit tools", () => {
      const registry = makeRegistry();
      expect(registry.getToolNamesForType("reviewer")).toEqual(["read", "bash", "grep", "find", "ls", "stash_get", "stash_list"]);
    });

    it("returns custom tool names for user agent", () => {
      const registry = makeRegistry(
        new Map([["auditor", makeAgentConfig({ name: "auditor", toolNames: ["read", "grep"] })]])
      );
      expect(registry.getToolNamesForType("auditor")).toEqual(["read", "grep"]);
    });

    it("returns BUILTIN_TOOL_NAMES for unknown type", () => {
      const registry = makeRegistry();
      const names = registry.getToolNamesForType("nonexistent");
      expect(names).toEqual(["all"]);
    });

    it("returns an empty list for an agent that declared tools: none", () => {
      const registry = makeRegistry(
        new Map([["silent", makeAgentConfig({ name: "silent", toolNames: [] })]])
      );
      expect(registry.getToolNamesForType("silent")).toEqual([]);
    });

    it("selects all available tools for a user agent with no tools key", () => {
      const registry = makeRegistry(
        new Map([["unrestricted", makeAgentConfig({ name: "unrestricted", toolNames: undefined })]])
      );
      expect(registry.getToolNamesForType("unrestricted")).toEqual(["all"]);
    });

    it("returns a disabled agent's own list rather than the built-ins", () => {
      const registry = makeRegistry(
        new Map([
          ["retired", makeAgentConfig({ name: "retired", toolNames: ["read"], enabled: false })],
        ])
      );
      expect(registry.getToolNamesForType("retired")).toEqual(["read"]);
    });
  });

  describe("DEFAULT_AGENT_NAMES static property", () => {
    it("is defined on the class", () => {
      expect(AgentTypeRegistry.DEFAULT_AGENT_NAMES).toBeDefined();
    });

    it("contains the built-in default names", () => {
      expect(AgentTypeRegistry.DEFAULT_AGENT_NAMES).toEqual(["general-purpose", "orchestrator", "Explore", "Plan", "reviewer"]);
    });

    it("is no longer exported from types.ts", async () => {
      // DEFAULT_AGENT_NAMES was moved to AgentTypeRegistry; it must NOT appear
      // as a named export from types.ts anymore.
      const typesModule = await import("#src/types");
      expect((typesModule as Record<string, unknown>).DEFAULT_AGENT_NAMES).toBeUndefined();
    });
  });

  describe("orchestrator profile", () => {
    it("is discoverable case-insensitively with explicit delegation and todo tools", () => {
      const registry = makeRegistry();
      expect(registry.resolveType("Orchestrator")).toBe("orchestrator");
      expect(registry.getDefaultAgentNames()).toContain("orchestrator");
      expect(registry.resolveAgentConfig("orchestrator")).toMatchObject({
        name: "orchestrator", displayName: "Orchestrator", isDefault: true,
        promptMode: "replace",
        toolNames: ["all", "todo", "subagent", "get_subagent_result", "steer_subagent"],
      });
    });

    it("can be overridden or disabled like every other built-in", () => {
      const custom = makeAgentConfig({ name: "orchestrator", systemPrompt: "Custom PM", enabled: false });
      const registry = makeRegistry(new Map([["orchestrator", custom]]));
      expect(registry.resolveAgentConfig("orchestrator")).toBe(custom);
      expect(registry.isValidType("orchestrator")).toBe(false);
      expect(registry.getAvailableTypes()).not.toContain("orchestrator");
    });
  });

  describe("reviewer profile", () => {
    it("is a read-only built-in that reports a verdict without fixing", () => {
      const registry = makeRegistry();
      expect(registry.resolveType("Reviewer")).toBe("reviewer");
      const config = registry.resolveAgentConfig("reviewer");
      expect(config).toMatchObject({ name: "reviewer", displayName: "Reviewer", isDefault: true, promptMode: "replace" });
      expect(config.model).toBeUndefined();
      expect(config.toolNames).not.toContain("edit");
      expect(config.toolNames).not.toContain("write");
      expect(config.systemPrompt).toContain("Verdict: PASS");
      expect(config.systemPrompt).toContain("You do NOT fix anything");
    });

    it("is the orchestrator's verifier", () => {
      const prompt = makeRegistry().resolveAgentConfig("orchestrator").systemPrompt;
      expect(prompt).toContain("reviewer for verification");
      expect(prompt).toContain("Verify implementation tasks with a reviewer worker that did not do the work");
    });

    it("yields to a user definition with the same name", () => {
      const custom = makeAgentConfig({ name: "reviewer", systemPrompt: "My review rules" });
      expect(makeRegistry(new Map([["reviewer", custom]])).resolveAgentConfig("reviewer")).toBe(custom);
    });
  });

  describe("instance isolation", () => {
    it("two registries have independent state", () => {
      const r1 = makeRegistry(new Map([["auditor", makeAgentConfig({ name: "auditor" })]]));
      const r2 = makeRegistry();

      expect(r1.isValidType("auditor")).toBe(true);
      expect(r2.isValidType("auditor")).toBe(false);
    });
  });
});
