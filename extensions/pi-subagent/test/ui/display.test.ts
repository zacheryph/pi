import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { describe, expect, expectTypeOf, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { AgentConfig } from "#src/types";
import { getDisplayName, modelLabel, type Theme } from "#src/ui/display";
import { makeModel } from "#test/helpers/make-model";

const testRegistry = new AgentTypeRegistry(() => new Map());

describe("Theme", () => {
  it("accepts only Pi theme color names", () => {
    expectTypeOf<Parameters<Theme["fg"]>[0]>().toEqualTypeOf<ThemeColor>();
  });
});

describe("getDisplayName", () => {
  it("returns displayName when set", () => {
    const customAgents = new Map<string, AgentConfig>([
      [
        "my-agent",
        {
          name: "my-agent",
          displayName: "My Agent",
          description: "test",
          systemPrompt: "",
          promptMode: "replace",
        },
      ],
    ]);
    const registry = new AgentTypeRegistry(() => customAgents);
    expect(getDisplayName("my-agent", registry)).toBe("My Agent");
  });

  it("falls back to name when displayName is not set", () => {
    const customAgents = new Map<string, AgentConfig>([
      [
        "my-agent",
        {
          name: "my-agent",
          description: "test",
          systemPrompt: "",
          promptMode: "replace",
        },
      ],
    ]);
    const registry = new AgentTypeRegistry(() => customAgents);
    expect(getDisplayName("my-agent", registry)).toBe("my-agent");
  });

  it.each([
    ["explore", "explore"],
    ["plan", "plan"],
    ["orchestrate", "orchestrate"],
    ["review", "review"],
    ["general-purpose", "agent"],
  ])("displays built-in %s as %s", (type, expected) => {
    expect(getDisplayName(type, testRegistry)).toBe(expected);
  });
});

describe("modelLabel", () => {
  it("labels a model as provider/id", () => {
    expect(modelLabel(makeModel({ provider: "anthropic", id: "claude-haiku-4-5" }))).toBe(
      "anthropic/claude-haiku-4-5",
    );
  });

  it("is undefined while the model is unknown", () => {
    expect(modelLabel(undefined)).toBeUndefined();
  });
});
