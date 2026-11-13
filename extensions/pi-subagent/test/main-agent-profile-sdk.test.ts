import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi, onTestFinished } from "vitest";
import {
  MAIN_AGENT_ENTRY,
  MAIN_AGENT_REQUIRED_TOOLS,
  MAIN_AGENT_SECTION,
  registerMainAgentProfile,
  resolveMainAgentProfile,
  type MainAgentSnapshot,
} from "#src/main-agent-profile";
import type { AgentConfig } from "#src/types";
import { fauxRuntime, toolCall, tempDir, writeFiles } from "#test-helpers";

/**
 * The active tools as a set. Pi keeps tools that stay active in place and
 * appends newly activated ones (since 1.5.0), so their order is Pi's, not ours.
 */
function activeToolSet(session: { getActiveToolNames(): readonly string[] }): Set<string> {
  return new Set(session.getActiveToolNames());
}

async function fixture(
  options: {
    mode?: ExtensionContext["mode"];
    failure?: "startup" | "turn" | "context";
    flag?: string | null;
    env?: string;
    modelOverride?: string;
    profileModel?: string;
    profileThinking?: AgentConfig["thinking"];
    sessionStartReason?: SessionStartEvent["reason"];
    snapshot?: { version: 1; profile: AgentConfig };
    toolNames?: string[];
    tools?: string[];
    responses?: ReturnType<typeof fauxAssistantMessage>[];
    trusted?: boolean;
    source?: AgentConfig["source"];
    summaryHistory?: boolean;
    profileContent?: string;
    fragmentFiles?: Record<string, string>;
  } = {},
) {
  const dir = tempDir(onTestFinished, "main-profile-sdk-");
  if (options.profileContent !== undefined) {
    writeFiles(join(dir, ".pi", "agents"), {
      "reader.md": options.profileContent,
      ...Object.fromEntries(
        Object.entries(options.fragmentFiles ?? {}).map(([name, content]) => [
          `fragments/${name}.md`,
          content,
        ]),
      ),
    });
  }
  const { faux, modelRuntime, calls } = await fauxRuntime({
    dir,
    provider: "main-profile-test",
    models: [
      { id: "first", reasoning: true },
      { id: "other", reasoning: true },
    ],
  });
  const secret = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "SECRET" }],
    details: undefined,
  }));
  const diagnostic = vi.fn();
  const shutdown = vi.fn();
  const errors = vi.fn();
  const signals: Array<{ stage: string; live: boolean; aborted: boolean }> = [];
  const profile: AgentConfig = {
    name: "reader",
    description: "main",
    promptMode: "replace",
    systemPrompt: "ONLY MAIN",
    toolNames: options.toolNames ?? ["read"],
    source: options.source,
    model: options.profileModel,
    thinking: options.profileThinking,
  };
  let extensionPi: ExtensionAPI;
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: SettingsManager.inMemory({}, { projectTrusted: options.trusted ?? true }),
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => "PARENT BASE",
    appendSystemPromptOverride: () => ["PARENT ADDENDUM"],
    extensionFactories: [
      (pi) => {
        extensionPi = pi;
        for (const name of MAIN_AGENT_REQUIRED_TOOLS)
          pi.registerTool({
            name,
            label: name,
            description: name,
            parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
          });
        pi.registerTool({
          name: "secret",
          label: "secret",
          description: "secret",
          exposure: "deferred",
          parameters: Type.Object({}),
          execute: secret,
        });
        if (options.failure === "context") {
          pi.on("context_with_system", async () => {
            await pi.setModel(faux.getModel("other")!);
          });
        }
        registerMainAgentProfile(pi, {
          resolveProfile: (_name, ctx) => {
            if (options.failure === "startup") throw new Error("Unknown profile");
            if (options.profileContent !== undefined) return resolveMainAgentProfile("reader", ctx);
            return profile;
          },
          diagnostic,
          env: () => options.env,
        });
      },
      createCodemodeExtension(),
      (pi) => {
        if (options.failure === "turn") {
          // Before-agent-start errors/opaque replacement don't cancel Pi. The
          // profile must catch the final override at its live context gate.
          pi.on("before_agent_start", (event) => {
            event.systemPromptOptions.forceSystemPrompt = "BROKEN";
          });
        }
        pi.on("turn_start", (_event, ctx) => {
          signals.push({ stage: "turn", live: !!ctx.signal, aborted: !!ctx.signal?.aborted });
        });
        pi.on("context_with_system", (_event, ctx) => {
          signals.push({ stage: "context", live: !!ctx.signal, aborted: !!ctx.signal?.aborted });
        });
      },
    ],
  });
  await loader.reload();
  if (options.flag !== null)
    loader.getExtensions().runtime.flagValues.set("agent", options.flag ?? "reader");
  if (options.modelOverride !== undefined)
    loader.getExtensions().runtime.flagValues.set("agent-model", options.modelOverride);
  const settingsManager = SettingsManager.inMemory(
    {
      compaction: { enabled: false, ...(options.summaryHistory ? { keepRecentTokens: 1 } : {}) },
      retry: { enabled: false },
    },
    { projectTrusted: options.trusted ?? true },
  );
  const sessionManager = SessionManager.inMemory(dir);
  if (options.summaryHistory) {
    sessionManager.appendMessage({
      role: "user",
      content: "Prior task with enough context to summarize",
      timestamp: 1,
    });
    sessionManager.appendMessage(fauxAssistantMessage("Prior answer", { timestamp: 2 }));
    sessionManager.appendMessage({ role: "user", content: "Recent task", timestamp: 3 });
    sessionManager.appendMessage(fauxAssistantMessage("Recent answer", { timestamp: 4 }));
  }
  if (options.snapshot) sessionManager.appendCustomEntry(MAIN_AGENT_ENTRY, options.snapshot);
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    model: faux.getModel(),
    thinkingLevel: "medium",
    resourceLoader: loader,
    settingsManager,
    sessionManager,
    tools: options.tools,
    sessionStartEvent: { type: "session_start", reason: options.sessionStartReason ?? "startup" },
  });
  onTestFinished(() => session.dispose());
  await session.bindExtensions({
    mode: options.mode ?? "print",
    shutdownHandler: shutdown,
    onError: errors,
  });
  faux.setResponses(options.responses ?? [fauxAssistantMessage("done")]);
  return {
    dir,
    session,
    faux,
    calls,
    secret,
    shutdown,
    errors,
    diagnostic,
    signals,
    profile,
    pi: extensionPi!,
    loader,
  };
}

describe("main profile / installed SDK", () => {
  it.each(["tui", "print", "rpc", "json"] as const)(
    "real request starts with zero registered MCP tools (%s)",
    async (mode) => {
      const h = await fixture({
        mode,
        profileContent:
          "---\ntools: [read, codemode, 'mcp__*']\nfragments: [aws]\n---\nPROFILE WITH MCP WILDCARD",
        fragmentFiles: { aws: "FROZEN AWS INSTRUCTIONS" },
      });
      expect(h.pi.getAllTools().some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
      await h.session.prompt("hello");
      expect(h.calls).toHaveLength(1);
      expect(JSON.stringify(h.calls[0]![1])).toContain("PROFILE WITH MCP WILDCARD");
      expect(JSON.stringify(h.calls[0]![1])).toContain("FROZEN AWS INSTRUCTIONS");
      expect(activeToolSet(h.session)).toEqual(
        new Set(["read", "codemode", ...MAIN_AGENT_REQUIRED_TOOLS]),
      );
      expect(h.shutdown).not.toHaveBeenCalled();
      expect(h.errors).not.toHaveBeenCalled();
    },
  );

  it("MCP tool registering after profile startup remains callable through codemode", async () => {
    const h = await fixture({
      toolNames: ["read", "codemode", "mcp__*"],
      responses: [
        toolCall("codemode", { code: "return await tools.mcp__late__read({});" }),
        fauxAssistantMessage("done"),
      ],
    });
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "LATE MCP RESULT" }],
      details: undefined,
    }));
    h.pi.registerTool({
      name: "mcp__late__read",
      label: "Late MCP",
      description: "Simulated asynchronous MCP connection",
      exposure: "deferred",
      parameters: Type.Object({}),
      execute,
    });
    await h.session.prompt("use late MCP tool");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(2);
    expect(h.shutdown).not.toHaveBeenCalled();
    expect(JSON.stringify(h.session.messages)).toContain("LATE MCP RESULT");
  }, 20_000);

  it("exact missing MCP tool still blocks real provider dispatch", async () => {
    const h = await fixture({ toolNames: ["read", "codemode", "mcp__*", "mcp__required__read"] });
    await h.session.prompt("hello");
    expect(h.calls).toHaveLength(0);
    expect(h.shutdown).toHaveBeenCalled();
    expect(h.diagnostic).toHaveBeenCalledWith(
      "Main agent blocked: Unavailable profile tools (check --tools/--exclude-tools): mcp__required__read.",
    );
  });

  it.each(["main-profile-test/first", "missing/profile-model"])(
    "explicit override reaches provider and effective snapshot, not registry (%s)",
    async (profileModel) => {
      const h = await fixture({
        profileModel,
        profileThinking: "high",
        modelOverride: "main-profile-test/other",
      });
      expect(h.session.model?.id).toBe("other");
      expect(h.session.thinkingLevel).toBe("high");
      expect(activeToolSet(h.session)).toEqual(new Set(["read", ...MAIN_AGENT_REQUIRED_TOOLS]));
      await h.session.prompt("chosen config");
      expect(h.calls[0]![0]).toMatchObject({
        provider: "main-profile-test",
        id: "other",
      });
      expect(h.calls[0]![2]?.reasoning).toBe("high");
      const saved = h.session.sessionManager
        .getBranch()
        .find((e) => e.type === "custom" && e.customType === MAIN_AGENT_ENTRY)!;
      expect(saved).toMatchObject({
        data: {
          profile: { model: "main-profile-test/other", thinking: "high", toolNames: ["read"] },
        },
      });
      expect(h.profile.model).toBe(profileModel);
      expect(h.shutdown).not.toHaveBeenCalled();
      expect(h.errors).not.toHaveBeenCalled();

      // Turn-time manual selection remains authoritative, snapshot stays frozen.
      await h.session.setModel(h.faux.getModel("first")!);
      h.session.setThinkingLevel("off");
      h.session.setActiveToolsByName(["write"]);
      h.faux.setResponses([fauxAssistantMessage("manual done")]);
      await h.session.prompt("manual config");
      expect(h.calls[1]![0].id).toBe("first");
      expect(h.calls[1]![2]?.reasoning).toBeUndefined();
      expect(activeToolSet(h.session)).toEqual(new Set(["write"]));
      expect(JSON.stringify(h.calls[1]![1])).toContain("ONLY MAIN");
      expect(
        h.session.sessionManager
          .getBranch()
          .filter((e) => e.type === "custom" && e.customType === MAIN_AGENT_ENTRY),
      ).toEqual([saved]);
    },
  );

  it.each(["", "  ", "main-profile-test/missing"])(
    "invalid explicit override blocks actual provider dispatch (%j)",
    async (modelOverride) => {
      const h = await fixture({
        profileModel: "main-profile-test/other",
        profileThinking: "high",
        modelOverride,
      });
      expect(h.session.model?.id).toBe("first");
      expect(h.session.thinkingLevel).toBe("medium");
      expect(h.session.getActiveToolNames()).toContain("write");
      await h.session.prompt("blocked");
      expect(h.calls).toHaveLength(0);
      expect(h.shutdown).toHaveBeenCalled();
      expect(h.diagnostic).toHaveBeenCalledWith(
        modelOverride.trim()
          ? "Main agent blocked: Unavailable profile model: main-profile-test/missing."
          : "Main agent blocked: --agent-model requires a non-empty model.",
      );
      expect(
        h.session.sessionManager
          .getBranch()
          .some((e) => e.type === "custom" && e.customType === MAIN_AGENT_ENTRY),
      ).toBe(false);
    },
  );

  it.each(["", "main-profile-test/missing", "main-profile-test/other"])(
    "standalone model flag does not select profile or model (%j)",
    async (modelOverride) => {
      const h = await fixture({ flag: null, modelOverride });
      await h.session.prompt("ordinary main");
      expect(h.calls[0]![0].id).toBe("first");
      expect(JSON.stringify(h.calls[0]![1])).not.toContain(MAIN_AGENT_SECTION);
      expect(h.session.getActiveToolNames()).toContain("write");
      expect(
        h.session.sessionManager
          .getBranch()
          .some((e) => e.type === "custom" && e.customType === MAIN_AGENT_ENTRY),
      ).toBe(false);
      expect(h.shutdown).not.toHaveBeenCalled();
    },
  );

  it.each(["reload", "resume", "fork"] as const)(
    "retained flags restore effective snapshot without model/default reapplication (%s)",
    async (sessionStartReason) => {
      const first = await fixture({
        profileModel: "missing/profile",
        profileThinking: "high",
        modelOverride: "main-profile-test/other",
      });
      const saved = first.session.sessionManager
        .getBranch()
        .find((e) => e.type === "custom" && e.customType === MAIN_AGENT_ENTRY)!;
      if (saved.type !== "custom") throw new Error("Missing main profile snapshot");
      const restored = await fixture({
        sessionStartReason,
        snapshot: saved.data as MainAgentSnapshot,
        modelOverride: "",
        profileModel: "missing/new-definition",
      });
      await restored.session.prompt("restore");
      expect(restored.calls[0]![0].id).toBe("first");
      expect(restored.calls[0]![2]?.reasoning).toBe("medium");
      expect(restored.session.getActiveToolNames()).toContain("write");
      expect(JSON.stringify(restored.calls[0]![1])).toContain("ONLY MAIN");
      expect(
        restored.session.sessionManager
          .getBranch()
          .filter((e) => e.type === "custom" && e.customType === MAIN_AGENT_ENTRY),
      ).toEqual([expect.objectContaining({ data: saved.data })]);
      expect(restored.shutdown).not.toHaveBeenCalled();
      expect(restored.errors).not.toHaveBeenCalled();
    },
  );

  it("retained agent/model flags do not apply to new SDK session", async () => {
    const h = await fixture({
      sessionStartReason: "new",
      modelOverride: "main-profile-test/other",
      profileModel: "missing/profile",
    });
    await h.session.prompt("new");
    expect(h.calls[0]![0].id).toBe("first");
    expect(JSON.stringify(h.calls[0]![1])).not.toContain(MAIN_AGENT_SECTION);
    expect(h.shutdown).not.toHaveBeenCalled();
  });

  it.each(["tui", "print", "rpc", "json"] as const)(
    "preserves structured profile body while manual selection reaches real request (%s)",
    async (mode) => {
      const h = await fixture({ mode });
      await h.session.setModel(h.faux.getModel("other")!);
      h.session.setThinkingLevel("off");
      h.session.setActiveToolsByName(["write", ...MAIN_AGENT_REQUIRED_TOOLS]);
      await h.session.prompt("hello");
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]![0].id).toBe("other");
      expect(h.calls[0]![2]?.reasoning).toBeUndefined();
      const request = JSON.stringify(h.calls[0]![1]);
      expect(request).toContain("PARENT BASE");
      expect(request).toContain("PARENT ADDENDUM");
      expect(request).toContain(`<${MAIN_AGENT_SECTION}>`);
      expect(activeToolSet(h.session)).toEqual(new Set(["write", ...MAIN_AGENT_REQUIRED_TOOLS]));
      expect(
        h.session.sessionManager
          .getBranch()
          .filter((e) => e.type === "custom" && e.customType === MAIN_AGENT_ENTRY),
      ).toHaveLength(1);
      expect(h.shutdown).not.toHaveBeenCalled();
      expect(h.errors).not.toHaveBeenCalled();
    },
  );

  it("real requests receive ordered fragment snapshot despite source edits before first prompt", async () => {
    const h = await fixture({
      profileContent: "---\ntools: [read]\nfragments: [aws, git, aws]\n---\nSDK PROFILE BODY",
      fragmentFiles: { aws: "SDK AWS", git: "SDK GIT" },
    });
    writeFileSync(join(h.dir, ".pi", "agents", "fragments", "aws.md"), "EDITED FRAGMENT");
    rmSync(join(h.dir, ".pi", "agents", "fragments", "git.md"));
    await h.session.prompt("hello");
    expect(h.calls).toHaveLength(1);
    const request = JSON.stringify(h.calls[0]![1]);
    expect(request).toContain("SDK AWS");
    expect(request).toContain("SDK GIT");
    expect(request.indexOf("SDK AWS")).toBeLessThan(request.indexOf("SDK GIT"));
    expect(request.indexOf("SDK GIT")).toBeLessThan(request.indexOf("SDK PROFILE BODY"));
    expect(request).not.toContain("EDITED FRAGMENT");
    const saved = h.session.sessionManager
      .getBranch()
      .find((entry) => entry.type === "custom" && entry.customType === MAIN_AGENT_ENTRY);
    expect(saved).toMatchObject({
      data: { profile: { systemPrompt: "SDK AWS\n\n---\n\nSDK GIT\n\n---\n\nSDK PROFILE BODY" } },
    });
    expect(h.shutdown).not.toHaveBeenCalled();
    expect(h.errors).not.toHaveBeenCalled();
  });

  it("saved fragment snapshot restores in another SDK session after all source files disappear", async () => {
    const first = await fixture({
      profileContent: "---\ntools: [read]\nfragments: [aws]\n---\nSDK SAVED BODY",
      fragmentFiles: { aws: "SDK SAVED AWS" },
    });
    const saved = first.session.sessionManager
      .getBranch()
      .find((entry) => entry.type === "custom" && entry.customType === MAIN_AGENT_ENTRY)!;
    if (saved.type !== "custom") throw new Error("Missing main profile snapshot");
    rmSync(join(first.dir, ".pi"), { recursive: true });
    const resumed = await fixture({ flag: null, snapshot: saved.data as MainAgentSnapshot });
    await resumed.session.prompt("resume");
    expect(resumed.calls).toHaveLength(1);
    const request = JSON.stringify(resumed.calls[0]![1]);
    expect(request).toContain("SDK SAVED AWS");
    expect(request).toContain("SDK SAVED BODY");
    expect(resumed.shutdown).not.toHaveBeenCalled();
  });

  it("missing fragments block actual SDK provider dispatch", async () => {
    const h = await fixture({
      profileContent: "---\ntools: [read]\nfragments: [missing]\n---\nSDK BODY",
    });
    await h.session.prompt("hello");
    expect(h.calls).toHaveLength(0);
    expect(h.shutdown).toHaveBeenCalled();
    expect(h.diagnostic).toHaveBeenCalledWith(expect.stringContaining('fragment "missing"'));
    expect(
      h.session.sessionManager
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === MAIN_AGENT_ENTRY),
    ).toBe(false);
  });

  it("startup failure handles every input, no provider call even when SDK shutdown callback is inert", async () => {
    const h = await fixture({ failure: "startup" });
    await h.session.prompt("first");
    await h.session.prompt("second");
    expect(h.calls).toHaveLength(0);
    expect(h.shutdown).toHaveBeenCalled();
    expect(h.session.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
  });

  it("blocked startup cancels manual compaction and tree summaries before provider dispatch", async () => {
    const h = await fixture({ mode: "rpc", failure: "startup", summaryHistory: true });
    const manager = h.session.sessionManager;
    const originalLeaf = manager.getLeafId();
    const target = manager
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user")!;
    await expect(h.session.compact()).rejects.toThrow("Compaction cancelled");
    expect(await h.session.navigateTree(target.id, { summarize: true })).toEqual(
      expect.objectContaining({ cancelled: true }),
    );
    expect(manager.getLeafId()).toBe(originalLeaf);
    expect(h.calls).toHaveLength(0);
  });

  it("structured prompt removed after our hook aborts live context, swallowed events never reach provider", async () => {
    const h = await fixture({ failure: "turn" });
    await h.session.prompt("first").catch(() => undefined);
    expect(h.calls).toHaveLength(0);
    expect(h.shutdown).toHaveBeenCalled();
    expect(h.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "context", live: true, aborted: true }),
      ]),
    );
    await h.session.prompt("second");
    expect(h.calls).toHaveLength(0);
  });

  it("late model selection no longer triggers a profile lock", async () => {
    const h = await fixture({ failure: "context" });
    await h.session.prompt("hello");
    expect(h.calls).toHaveLength(1);
    expect(h.session.model?.id).toBe("other");
    expect(h.shutdown).not.toHaveBeenCalled();
  });

  it("PI_MAIN_AGENT starts a hosted session: instructions and tools apply, the host's model and thinking stay", async () => {
    const h = await fixture({
      mode: "rpc",
      flag: null,
      env: "reader",
      profileModel: "main-profile-test/other",
      profileThinking: "high",
    });
    await h.session.prompt("hello");
    expect(h.calls[0]![0].id).toBe("first");
    expect(h.calls[0]![2]?.reasoning).toBe("medium");
    expect(JSON.stringify(h.calls[0]![1])).toContain("ONLY MAIN");
    expect(activeToolSet(h.session)).toEqual(new Set(["read", ...MAIN_AGENT_REQUIRED_TOOLS]));
    // The user sees which agent is active; the model is not shown the notice.
    const notices = h.session.messages.filter(
      (m) => m.role === "custom" && m.customType === "agent:notice",
    );
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0])).toContain("Agent reader · defaults applied");
    expect(JSON.stringify(h.calls[0]![1])).not.toContain("defaults applied");
    expect(h.shutdown).not.toHaveBeenCalled();
  });

  it("PI_MAIN_AGENT restart restores the saved profile and leaves the user's tools", async () => {
    const snapshot = {
      version: 1 as const,
      profile: {
        name: "reader",
        description: "snapshot",
        promptMode: "append" as const,
        systemPrompt: "EXACT SAVED BODY",
        toolNames: ["read"],
      },
    };
    const h = await fixture({ mode: "rpc", flag: null, env: "reader", snapshot });
    h.session.setActiveToolsByName(["write"]);
    await h.session.prompt("hello");
    expect(JSON.stringify(h.calls[0]![1])).toContain("EXACT SAVED BODY");
    expect(activeToolSet(h.session)).toEqual(new Set(["write"]));
  });

  it("PI_MAIN_AGENT that cannot load blocks input and says why in the transcript", async () => {
    const h = await fixture({ mode: "rpc", flag: null, env: "nope", failure: "startup" });
    await h.session.prompt("first");
    expect(h.calls).toHaveLength(0);
    const notices = h.session.messages.filter(
      (m) => m.role === "custom" && m.customType === "agent:notice",
    );
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0])).toContain("Main agent blocked: Unknown profile");
  });

  it("restores exact profile body without reapplying unavailable defaults", async () => {
    const snapshot = {
      version: 1 as const,
      profile: {
        name: "saved",
        description: "snapshot",
        promptMode: "append" as const,
        systemPrompt: "EXACT SAVED BODY",
        model: "missing/model",
        thinking: "max" as const,
        toolNames: ["missing-tool"],
      },
    };
    const h = await fixture({ flag: null, snapshot });
    await h.session.setModel(h.faux.getModel("other")!);
    h.session.setThinkingLevel("high");
    h.session.setActiveToolsByName(["write"]);
    await h.session.prompt("hello");
    expect(h.calls[0]![0].id).toBe("other");
    expect(h.calls[0]![2]?.reasoning).toBe("high");
    expect(activeToolSet(h.session)).toEqual(new Set(["write"]));
    expect(JSON.stringify(h.calls[0]![1])).toContain("EXACT SAVED BODY");
    expect(h.shutdown).not.toHaveBeenCalled();
    expect(
      h.session.sessionManager
        .getBranch()
        .filter((e) => e.type === "custom" && e.customType === MAIN_AGENT_ENTRY),
    ).toHaveLength(1);
  });

  it("strong construction-time --tools restriction fails closed if orchestration tool missing", async () => {
    const h = await fixture({ tools: ["read"] });
    await h.session.prompt("hello");
    expect(h.calls).toHaveLength(0);
    expect(h.shutdown).toHaveBeenCalled();
    expect(h.diagnostic).toHaveBeenCalledWith(expect.stringContaining("Unavailable profile tools"));
  });

  it("project trust refusal blocks main but performs no child-loader change", async () => {
    const h = await fixture({ source: "project", trusted: false });
    await h.session.prompt("hello");
    expect(h.calls).toHaveLength(0);
    expect(h.diagnostic).toHaveBeenCalledWith(expect.stringContaining("requires Pi project trust"));
  });

  it("real codemode can call deferred tools outside startup defaults; no capability deny gate", async () => {
    const h = await fixture({
      toolNames: ["read", "codemode"],
      responses: [
        toolCall("codemode", { code: "return await tools.secret({});" }),
        fauxAssistantMessage("done"),
      ],
    });
    await h.session.prompt("try nested tool");
    expect(h.secret).toHaveBeenCalledTimes(1);
    const result = h.session.messages.find(
      (m) => m.role === "toolResult" && m.toolName === "codemode",
    );
    expect(JSON.stringify(result)).toContain("SECRET");
    expect(h.calls).toHaveLength(2);
  }, 20_000);
});
