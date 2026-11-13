import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { describe, expect, it, onTestFinished } from "vitest";
import { registerAgentModels } from "#src/agent-models";
import {
  MAIN_AGENT_ENTRY,
  MAIN_AGENT_REQUIRED_TOOLS,
  registerMainAgentProfile,
} from "#src/main-agent-profile";
import type { AgentConfig } from "#src/types";
import { fauxSession, toolCall } from "#test-helpers";

const profile = (name: string, extra: Partial<AgentConfig> = {}): AgentConfig => ({
  name,
  description: name,
  promptMode: "replace",
  systemPrompt: `${name.toUpperCase()} BODY`,
  toolNames: ["read"],
  ...extra,
});

/** A real session with the agent models and main profile wired as pi-subagent wires them. */
async function session(profiles: AgentConfig[], options: { mode?: "rpc" | "print" } = {}) {
  const h = await fauxSession({
    cleanup: onTestFinished,
    provider: "agent-models-test",
    models: [
      { id: "first", reasoning: true },
      { id: "other", reasoning: true },
    ],
    bind: { mode: options.mode ?? "rpc", onError: (error) => h.errors.push(error) },
    extensions: [
      (pi) => {
        for (const name of MAIN_AGENT_REQUIRED_TOOLS)
          pi.registerTool({
            name,
            label: name,
            description: name,
            parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
          });
        const models = registerAgentModels(pi, {
          enabled: true,
          source: { cwd: "/unused", isProjectTrusted: () => true },
          deps: { profiles: () => profiles },
        });
        registerMainAgentProfile(pi, {
          resolveProfile: (name) => structuredClone(profiles.find((p) => p.name === name)!),
          agentModel: (model) => models.profileOf(model),
          diagnostic: () => {},
        });
      },
    ],
  });
  const agentModel = (name: string) => {
    const model = h.modelRuntime.getModel("agent", name);
    if (!model) throw new Error(`agent/${name} is not registered`);
    return model;
  };
  return { ...h, agentModel };
}

const names = (h: Awaited<ReturnType<typeof session>>) =>
  h.sessionManager
    .getBranch()
    .filter((e) => e.type === "custom" && e.customType === MAIN_AGENT_ENTRY)
    .map((e) => (e as unknown as { data: { profile: { name: string } } }).data.profile.name);

describe("agent models / installed SDK", () => {
  it("lists a virtual model per profile in the registry a host reads", async () => {
    const h = await session([profile("alpha"), profile("beta")]);
    const listed = h.modelRuntime
      .getAvailableSnapshot()
      .filter((m) => m.provider === "agent")
      .map((m) => `${m.provider}/${m.id}:${m.name}`)
      .sort();
    expect(listed).toEqual(["agent/alpha:Agent · alpha", "agent/beta:Agent · beta"]);
  });

  it("runs the picked agent on the profile's model, with its instructions and tools", async () => {
    const h = await session([profile("alpha", { model: "agent-models-test/other" })]);
    await h.session.setModel(h.agentModel("alpha"));
    expect(h.session.model).toMatchObject({ provider: "agent", id: "alpha" });
    expect(names(h)).toEqual(["alpha"]);
    await h.session.prompt("hello");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]![0]).toMatchObject({ provider: "agent-models-test", id: "other" });
    expect(JSON.stringify(h.calls[0]![1])).toContain("ALPHA BODY");
    expect(new Set(h.session.getActiveToolNames())).toEqual(
      new Set(["read", ...MAIN_AGENT_REQUIRED_TOOLS]),
    );
    expect(h.errors).toEqual([]);
  });

  it("shows the active agent in the transcript for a host that drops notify, but not to the model", async () => {
    const h = await session([profile("alpha")]);
    await h.session.setModel(h.agentModel("alpha"));
    await h.session.prompt("hello");
    const shown = h.session.messages.filter(
      (m) => m.role === "custom" && m.customType === "agent:notice",
    );
    expect(shown).toHaveLength(1);
    expect(JSON.stringify(shown[0])).toContain("Agent alpha · defaults applied");
    expect(JSON.stringify(h.calls[0]![1])).not.toContain("defaults applied");
  });

  it("answers a new turn on the session's last model when the profile names none", async () => {
    const h = await session([profile("alpha")]);
    await h.session.setModel(h.modelRuntime.getModel("agent-models-test", "other")!);
    await h.session.prompt("first turn");
    await h.session.setModel(h.agentModel("alpha"));
    h.faux.setResponses([fauxAssistantMessage("again")]);
    await h.session.prompt("second turn");
    expect(h.calls.map(([model]) => model.id)).toEqual(["other", "other"]);
  });

  it("keeps tool follow-ups on the model that handled the turn", async () => {
    const h = await session([profile("alpha", { model: "agent-models-test/other" })]);
    await h.session.setModel(h.agentModel("alpha"));
    h.faux.setResponses([toolCall("subagent_get", {}), fauxAssistantMessage("finished")]);
    await h.session.prompt("go");
    expect(h.calls.map(([model]) => model.id)).toEqual(["other", "other"]);
  });

  it("switches profile when another agent is picked", async () => {
    const h = await session([profile("alpha"), profile("beta")]);
    await h.session.setModel(h.agentModel("alpha"));
    await h.session.setModel(h.agentModel("beta"));
    expect(names(h)).toEqual(["alpha", "beta"]);
    await h.session.prompt("hello");
    const request = JSON.stringify(h.calls[0]![1]);
    expect(request).toContain("BETA BODY");
    expect(request).not.toContain("ALPHA BODY");
  });

  it("leaves the applied profile in place when a physical model is picked", async () => {
    const h = await session([profile("alpha")]);
    await h.session.setModel(h.agentModel("alpha"));
    h.session.setActiveToolsByName(["read"]);
    await h.session.setModel(h.modelRuntime.getModel("agent-models-test", "first")!);
    await h.session.prompt("hello");
    expect(h.calls[0]![0].id).toBe("first");
    expect(JSON.stringify(h.calls[0]![1])).toContain("ALPHA BODY");
    expect(names(h)).toEqual(["alpha"]);
  });

  it("does not offer a profile that cannot load", async () => {
    const h = await session([profile("alpha")]);
    expect(h.modelRuntime.getModel("agent", "ghost")).toBeUndefined();
  });
});
