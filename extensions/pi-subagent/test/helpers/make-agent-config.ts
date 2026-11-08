import type { AgentConfig } from "#src/types";

/** An agent definition with inert defaults: a read-only, replace-mode test agent. */
export function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "Test agent",
    toolNames: ["read", "grep"],
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    inheritContext: false,
    ...overrides,
  };
}
