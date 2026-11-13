import { describe, expect, it, vi, onTestFinished } from "vitest";
import type { ExtensionContext, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { registerAgentModels, routeAgentModel, sessionModel } from "#src/agent-models";
import { listMainAgentProfiles } from "#src/main-agent-profile";
import type { AgentConfig } from "#src/types";
import { makeModel } from "#test/helpers/make-model";
import { subagentPi } from "#test/helpers/subagent-pi";
import { tempDir, writeFiles } from "#test-helpers";

const profile = (name: string, extra: Partial<AgentConfig> = {}): AgentConfig => ({
  name,
  description: name,
  systemPrompt: `${name} body`,
  promptMode: "append",
  ...extra,
});

describe("agent models: which profiles are offered", () => {
  function project(files: Record<string, string>, trusted = true) {
    const global = tempDir(onTestFinished, "agent-models-global-");
    vi.stubEnv("PI_CODING_AGENT_DIR", global);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const cwd = tempDir(onTestFinished, "agent-models-project-");
    writeFiles(
      cwd,
      Object.fromEntries(Object.entries(files).map(([n, c]) => [`.pi/agents/${n}.md`, c])),
    );
    return { cwd, isProjectTrusted: () => trusted };
  }
  const names = (source: ReturnType<typeof project>) =>
    listMainAgentProfiles(source)
      .map((p) => p.name)
      .sort();

  it("offers the built-in profiles a main session can run", () => {
    expect(names(project({}))).toEqual(
      expect.arrayContaining(["explore", "implement", "orchestrate", "plan", "review"]),
    );
  });

  it("adds project profiles and leaves out disabled, hidden and broken ones", () => {
    const source = project({
      mine: "---\ndescription: mine\n---\nBody",
      off: "---\ndescription: off\nvisibility: disabled\n---\nBody",
      quiet: "---\ndescription: quiet\nvisibility: hidden\n---\nBody",
      cold: "---\ndescription: cold\nthinking: lukewarm\n---\nBody",
      lost: "---\ndescription: lost\nfragments: [missing]\n---\nBody",
    });
    const offered = names(source);
    expect(offered).toContain("mine");
    for (const left of ["off", "quiet", "cold", "lost"]) expect(offered).not.toContain(left);
  });

  it("leaves out project profiles until Pi trusts the project", () => {
    const files = { mine: "---\ndescription: mine\n---\nBody" };
    expect(names(project(files, false))).not.toContain("mine");
    expect(names(project(files, false))).toContain("orchestrate");
    expect(names(project(files, true))).toContain("mine");
  });
});

describe("agent models: registration", () => {
  const register = (
    profiles: AgentConfig[],
    options: { enabled?: boolean; listed?: () => AgentConfig[] } = {},
  ) => {
    const fake = subagentPi();
    const listing = options.listed ?? (() => profiles);
    const models = registerAgentModels(fake.pi, {
      enabled: options.enabled ?? true,
      source: { cwd: "/p", isProjectTrusted: () => true },
      deps: { profiles: () => listing() },
    });
    return { fake, models, pi: fake.pi };
  };

  it("registers one model per profile under provider agent", () => {
    const { fake, models } = register([profile("orchestrate"), profile("review")]);
    expect([...fake.virtualModels.keys()].sort()).toEqual(["agent/orchestrate", "agent/review"]);
    expect(fake.virtualModels.get("agent/orchestrate")).toMatchObject({
      provider: "agent",
      id: "orchestrate",
      name: "Agent · orchestrate",
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    });
    expect(models.names().sort()).toEqual(["orchestrate", "review"]);
  });

  it("recognises only the models it registered", () => {
    const { models } = register([profile("orchestrate")]);
    expect(models.profileOf({ provider: "agent", id: "orchestrate" })).toBe("orchestrate");
    expect(models.profileOf({ provider: "agent", id: "ghost" })).toBeUndefined();
    expect(models.profileOf({ provider: "anthropic", id: "orchestrate" })).toBeUndefined();
    expect(models.profileOf(undefined)).toBeUndefined();
  });

  it("registers nothing when the setting is off", () => {
    const { fake, models } = register([profile("orchestrate")], { enabled: false });
    models.sync({ cwd: "/p", isProjectTrusted: () => true });
    expect(fake.pi.registerVirtualModel).not.toHaveBeenCalled();
    expect(fake.virtualModels.size).toBe(0);
    expect(models.profileOf({ provider: "agent", id: "orchestrate" })).toBeUndefined();
  });

  it("registers again on reload without duplicates and drops profiles that went away", () => {
    let current = [profile("orchestrate"), profile("review")];
    const { fake, models } = register([], { listed: () => current });
    models.sync({ cwd: "/p", isProjectTrusted: () => true });
    expect(fake.virtualModels.size).toBe(2);
    current = [profile("orchestrate")];
    models.sync({ cwd: "/p", isProjectTrusted: () => true });
    expect([...fake.virtualModels.keys()]).toEqual(["agent/orchestrate"]);
    expect(fake.pi.unregisterVirtualModel).toHaveBeenCalledWith("agent", "review");
    expect(models.names()).toEqual(["orchestrate"]);
  });

  it("keeps a selected model whose profile no longer loads, so the failure is explained", () => {
    let current = [profile("orchestrate")];
    const { fake, models } = register([], { listed: () => current });
    current = [];
    models.sync({ cwd: "/p", isProjectTrusted: () => false }, "orchestrate");
    expect([...fake.virtualModels.keys()]).toEqual(["agent/orchestrate"]);
    models.sync({ cwd: "/p", isProjectTrusted: () => false });
    expect(fake.virtualModels.size).toBe(0);
  });

  it("ignores a failure to unregister from an extension that is already gone", () => {
    let current = [profile("orchestrate"), profile("review")];
    const { fake, models } = register([], { listed: () => current });
    fake.pi.unregisterVirtualModel.mockImplementation(() => {
      throw new Error("stale");
    });
    current = [profile("orchestrate")];
    expect(() => models.sync({ cwd: "/p", isProjectTrusted: () => true })).not.toThrow();
    expect(models.names()).toEqual(["orchestrate"]);
  });
});

describe("agent models: routing", () => {
  const first = makeModel({ id: "first", provider: "p" });
  const second = makeModel({ id: "second", provider: "p" });
  const noKey = makeModel({ id: "nokey", provider: "q" });
  const dflt = makeModel({ id: "default", provider: "p" });
  const virtual = makeModel({ id: "orchestrate", provider: "agent", api: "pi-virtual" });

  function context(
    options: { branch?: unknown[]; authed?: string[]; available?: unknown[] } = {},
  ): ExtensionContext {
    const all = [first, second, noKey, dflt, virtual];
    const authed = options.authed ?? ["p"];
    return {
      cwd: "/p",
      isProjectTrusted: () => true,
      sessionManager: { getBranch: () => options.branch ?? [] },
      modelRegistry: {
        find: (provider: string, id: string) =>
          all.find((m) => m.provider === provider && m.id === id),
        hasConfiguredAuth: (m: { provider: string }) => authed.includes(m.provider),
        getAvailable: () => options.available ?? all.filter((m) => authed.includes(m.provider)),
      },
    } as unknown as ExtensionContext;
  }
  const request = (extra: Partial<ModelRouteRequest> = {}): ModelRouteRequest => ({
    model: virtual,
    thinkingLevel: "high",
    reason: "user",
    messages: [],
    ...extra,
  });
  const deps = { defaultModel: () => dflt };
  const answered = (model: { provider: string; id: string }) => ({
    type: "message",
    message: { role: "assistant", provider: model.provider, model: model.id },
  });

  it("continues on the model that handled the turn, with its thinking level", () => {
    const route = routeAgentModel(
      request({
        reason: "continuation",
        previous: { model: second, thinkingLevel: "low" },
      }),
      context(),
      { name: "x", model: "p/first" },
      deps,
    );
    expect(route).toEqual({ model: second, thinkingLevel: "low" });
  });

  it("retries on the model that failed, not the one before it", () => {
    const route = routeAgentModel(
      request({
        reason: "retry",
        previous: { model: first, thinkingLevel: "low" },
        failed: {
          model: second,
          thinkingLevel: "medium",
          message: {} as NonNullable<ModelRouteRequest["failed"]>["message"],
        },
      }),
      context(),
      { name: "x", model: "p/first" },
      deps,
    );
    expect(route).toEqual({ model: second, thinkingLevel: "medium" });
  });

  it("retries on the previous model when routing itself failed", () => {
    const route = routeAgentModel(
      request({ reason: "retry", previous: { model: first } }),
      context(),
      { name: "x" },
      deps,
    );
    expect(route).toEqual({ model: first, thinkingLevel: "high" });
  });

  it.each(["user", "direct"] as const)(
    "sends a %s request to the profile's model when it resolves",
    (reason) => {
      const route = routeAgentModel(
        request({ reason, previous: { model: first } }),
        context(),
        { name: "x", model: "p/second" },
        deps,
      );
      expect(route).toEqual({ model: second, thinkingLevel: "high" });
    },
  );

  it("falls back to the session's last model when the profile's has no credentials", () => {
    const route = routeAgentModel(
      request({ previous: { model: first } }),
      context(),
      { name: "x", model: "q/nokey" },
      deps,
    );
    expect(route.model).toBe(first);
  });

  it("falls back to the session's last model when the profile's does not exist", () => {
    const route = routeAgentModel(
      request({ previous: { model: second } }),
      context(),
      { name: "x", model: "p/missing" },
      deps,
    );
    expect(route.model).toBe(second);
  });

  it("reads the last model from the transcript when the request names none", () => {
    const ctx = context({ branch: [answered(first), { type: "custom" }, answered(second)] });
    expect(routeAgentModel(request(), ctx, { name: "x" }, deps).model).toBe(second);
  });

  it("skips transcript answers it cannot use", () => {
    const ctx = context({ branch: [answered(first), answered(noKey), answered(virtual)] });
    expect(routeAgentModel(request(), ctx, { name: "x" }, deps).model).toBe(first);
  });

  it("uses Pi's configured default for a session with no history", () => {
    expect(routeAgentModel(request(), context(), { name: "x" }, deps).model).toBe(dflt);
  });

  it("ignores a configured default that has no credentials, taking the first usable model", () => {
    const ctx = context({ authed: ["p"] });
    const route = routeAgentModel(request(), ctx, { name: "x" }, { defaultModel: () => noKey });
    expect(route.model).toBe(first);
  });

  it("never routes to another virtual model", () => {
    const ctx = context({ available: [virtual, first] });
    const route = routeAgentModel(request(), ctx, { name: "x" }, { defaultModel: () => virtual });
    expect(route.model).toBe(first);
  });

  it("passes the selected thinking level through for Pi to clamp", () => {
    for (const level of ["off", "xhigh", "max"] as const) {
      const route = routeAgentModel(
        request({ thinkingLevel: level }),
        context(),
        { name: "x", model: "p/first" },
        deps,
      );
      expect(route.thinkingLevel).toBe(level);
    }
  });

  it("fails the request, naming the agent, when no model can answer", () => {
    expect(() =>
      routeAgentModel(
        request(),
        context({ authed: [], available: [] }),
        { name: "orchestrate" },
        { defaultModel: () => undefined },
      ),
    ).toThrow("Agent orchestrate has no model to run on");
  });

  it("resolves a session model the same way for a child that inherits the parent's", () => {
    expect(sessionModel(context({ branch: [answered(second)] }), deps)).toBe(second);
    expect(sessionModel(context(), deps)).toBe(dflt);
  });

  it("routes through the registered definition with the extension's context", async () => {
    const fake = subagentPi();
    registerAgentModels(fake.pi, {
      enabled: true,
      source: { cwd: "/p", isProjectTrusted: () => true },
      deps: { profiles: () => [profile("orchestrate", { model: "p/second" })], ...deps },
    });
    const definition = fake.virtualModels.get("agent/orchestrate");
    expect(await definition.route(request(), context())).toEqual({
      model: second,
      thinkingLevel: "high",
    });
  });
});

describe("agent models: wired into the extension", () => {
  async function load(settingsFile?: object, projectAgents: Record<string, string> = {}) {
    const global = tempDir(onTestFinished, "agent-models-global-");
    vi.stubEnv("PI_CODING_AGENT_DIR", global);
    const cwd = tempDir(onTestFinished, "agent-models-wired-");
    writeFiles(cwd, {
      ...(settingsFile ? { ".pi/subagent.json": settingsFile } : {}),
      ...Object.fromEntries(
        Object.entries(projectAgents).map(([n, c]) => [`.pi/agents/${n}.md`, c]),
      ),
    });
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    onTestFinished(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });
    const fake = subagentPi();
    const { default: extension } = await import("#src/index");
    extension(fake.pi);
    return { fake, cwd };
  }
  const context = (cwd: string, trusted: boolean) => ({
    cwd,
    isProjectTrusted: () => trusted,
    model: undefined,
    ui: { setStatus: vi.fn(), notify: vi.fn() },
    hasUI: false,
    mode: "print",
    sessionManager: { getSessionId: () => "root", getBranch: () => [], getEntries: () => [] },
  });

  it("registers an agent model per profile by default", async () => {
    const { fake } = await load();
    expect(fake.virtualModels.has("agent/orchestrate")).toBe(true);
    expect(fake.virtualModels.has("agent/implement")).toBe(true);
  });

  it("registers none when subagent.json turns agentModels off, leaving --agent alone", async () => {
    const { fake } = await load({ agentModels: false });
    expect(fake.virtualModels.size).toBe(0);
    expect(fake.pi.registerFlag).toHaveBeenCalledWith("agent", expect.anything());
  });

  it("narrows to the session's trust once it starts", async () => {
    const { fake, cwd } = await load(undefined, {
      mine: "---\ndescription: mine\n---\nBody",
    });
    expect(fake.virtualModels.has("agent/mine")).toBe(true);
    await fake.fire("session_start", { reason: "startup" }, context(cwd, false));
    expect(fake.virtualModels.has("agent/mine")).toBe(false);
    expect(fake.virtualModels.has("agent/orchestrate")).toBe(true);
    await fake.fire("session_start", { reason: "reload" }, context(cwd, true));
    expect(fake.virtualModels.has("agent/mine")).toBe(true);
  });
});
