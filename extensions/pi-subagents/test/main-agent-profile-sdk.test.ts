import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIN_AGENT_ENTRY, MAIN_AGENT_REQUIRED_TOOLS, MAIN_AGENT_SECTION, registerMainAgentProfile } from "#src/main-agent-profile";
import type { AgentConfig } from "#src/types";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function fixture(options: {
  mode?: ExtensionContext["mode"];
  failure?: "startup" | "turn" | "context";
  flag?: string | null;
  snapshot?: { version: 1; profile: AgentConfig };
  toolNames?: string[];
  tools?: string[];
  responses?: ReturnType<typeof fauxAssistantMessage>[];
  trusted?: boolean;
  source?: AgentConfig["source"];
  summaryHistory?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "main-profile-sdk-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const faux = createFauxCore({ provider: "main-profile-test", models: [{ id: "first", reasoning: true }, { id: "other", reasoning: true }] });
  const calls = vi.fn(faux.streamSimple);
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "cache"), refreshOnCreate: false });
  modelRuntime.registerProvider("main-profile-test", {
    api: faux.api, apiKey: "test-key", models: faux.models, streamSimple: calls,
  });
  const secret = vi.fn(async () => ({ content: [{ type: "text" as const, text: "SECRET" }], details: undefined }));
  const diagnostic = vi.fn();
  const shutdown = vi.fn();
  const errors = vi.fn();
  const signals: Array<{ stage: string; live: boolean; aborted: boolean }> = [];
  const profile: AgentConfig = {
    name: "reader", description: "main", promptMode: "replace", systemPrompt: "ONLY MAIN",
    toolNames: options.toolNames ?? ["read"], source: options.source,
  };
  let extensionPi: ExtensionAPI;
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory({}, { projectTrusted: options.trusted ?? true }),
    noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => "PARENT BASE", appendSystemPromptOverride: () => ["PARENT ADDENDUM"],
    extensionFactories: [
      pi => {
        extensionPi = pi;
        for (const name of MAIN_AGENT_REQUIRED_TOOLS) pi.registerTool({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }) });
        pi.registerTool({ name: "secret", label: "secret", description: "secret", exposure: "deferred", parameters: Type.Object({}), execute: secret });
        if (options.failure === "context") {
          pi.on("context_with_system", async () => { await pi.setModel(faux.getModel("other")!); });
        }
        registerMainAgentProfile(pi, { resolveProfile: () => {
          if (options.failure === "startup") throw new Error("Unknown profile");
          return profile;
        }, diagnostic });
      },
      createCodemodeExtension(),
      pi => {
        if (options.failure === "turn") {
          // Before-agent-start errors/opaque replacement don't cancel Pi. The
          // profile must catch the final override at its live context gate.
          pi.on("before_agent_start", event => { event.systemPromptOptions.forceSystemPrompt = "BROKEN"; });
        }
        pi.on("turn_start", (_event, ctx) => { signals.push({ stage: "turn", live: !!ctx.signal, aborted: !!ctx.signal?.aborted }); });
        pi.on("context_with_system", (_event, ctx) => { signals.push({ stage: "context", live: !!ctx.signal, aborted: !!ctx.signal?.aborted }); });
      },
    ],
  });
  await loader.reload();
  if (options.flag !== null) loader.getExtensions().runtime.flagValues.set("agent", options.flag ?? "reader");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, ...(options.summaryHistory ? { keepRecentTokens: 1 } : {}) }, retry: { enabled: false } }, { projectTrusted: options.trusted ?? true });
  const sessionManager = SessionManager.inMemory(dir);
  if (options.summaryHistory) {
    sessionManager.appendMessage({ role: "user", content: "Prior task with enough context to summarize", timestamp: 1 });
    sessionManager.appendMessage(fauxAssistantMessage("Prior answer", { timestamp: 2 }));
    sessionManager.appendMessage({ role: "user", content: "Recent task", timestamp: 3 });
    sessionManager.appendMessage(fauxAssistantMessage("Recent answer", { timestamp: 4 }));
  }
  if (options.snapshot) sessionManager.appendCustomEntry(MAIN_AGENT_ENTRY, options.snapshot);
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel(), thinkingLevel: "medium", resourceLoader: loader, settingsManager, sessionManager, tools: options.tools });
  cleanups.push(() => session.dispose());
  await session.bindExtensions({ mode: options.mode ?? "print", shutdownHandler: shutdown, onError: errors });
  faux.setResponses(options.responses ?? [fauxAssistantMessage("done")]);
  return { session, faux, calls, secret, shutdown, errors, diagnostic, signals, pi: extensionPi!, loader };
}

describe("main profile / installed SDK", () => {
  it.each(["tui", "print", "rpc", "json"] as const)("preserves structured profile body while manual selection reaches real request (%s)", async mode => {
    const h = await fixture({ mode });
    await h.session.setModel(h.faux.getModel("other")!);
    h.session.setThinkingLevel("off");
    h.session.setActiveToolsByName(["write", ...MAIN_AGENT_REQUIRED_TOOLS]);
    await h.session.prompt("hello");
    expect(h.calls).toHaveBeenCalledTimes(1);
    expect(h.calls.mock.calls[0]![0].id).toBe("other");
    expect(h.calls.mock.calls[0]![2]?.reasoning).toBeUndefined();
    const request = JSON.stringify(h.calls.mock.calls[0]![1]);
    expect(request).toContain("PARENT BASE");
    expect(request).toContain("PARENT ADDENDUM");
    expect(request).toContain(`<${MAIN_AGENT_SECTION}>`);
    expect(h.session.getActiveToolNames()).toEqual(["write", ...MAIN_AGENT_REQUIRED_TOOLS]);
    expect(h.session.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === MAIN_AGENT_ENTRY)).toHaveLength(1);
    expect(h.shutdown).not.toHaveBeenCalled();
    expect(h.errors).not.toHaveBeenCalled();
  });

  it("startup failure handles every input, no provider call even when SDK shutdown callback is inert", async () => {
    const h = await fixture({ failure: "startup" });
    await h.session.prompt("first"); await h.session.prompt("second");
    expect(h.calls).not.toHaveBeenCalled(); expect(h.shutdown).toHaveBeenCalled();
    expect(h.session.messages.filter(m => m.role === "assistant")).toHaveLength(0);
  });

  it("blocked startup cancels manual compaction and tree summaries before provider dispatch", async () => {
    const h = await fixture({ mode: "rpc", failure: "startup", summaryHistory: true });
    const manager = h.session.sessionManager;
    const originalLeaf = manager.getLeafId();
    const target = manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user")!;
    await expect(h.session.compact()).rejects.toThrow("Compaction cancelled");
    expect(await h.session.navigateTree(target.id, { summarize: true })).toEqual(expect.objectContaining({ cancelled: true }));
    expect(manager.getLeafId()).toBe(originalLeaf);
    expect(h.calls).not.toHaveBeenCalled();
  });

  it("structured prompt removed after our hook aborts live context, swallowed events never reach provider", async () => {
    const h = await fixture({ failure: "turn" });
    await h.session.prompt("first").catch(() => undefined);
    expect(h.calls).not.toHaveBeenCalled(); expect(h.shutdown).toHaveBeenCalled();
    expect(h.signals).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "context", live: true, aborted: true })]));
    await h.session.prompt("second"); expect(h.calls).not.toHaveBeenCalled();
  });

  it("late model selection no longer triggers a profile lock", async () => {
    const h = await fixture({ failure: "context" });
    await h.session.prompt("hello");
    expect(h.calls).toHaveBeenCalledTimes(1);
    expect(h.session.model?.id).toBe("other");
    expect(h.shutdown).not.toHaveBeenCalled();
  });

  it("restores exact profile body without reapplying unavailable defaults", async () => {
    const snapshot = { version: 1 as const, profile: { name: "saved", description: "snapshot", promptMode: "append" as const, systemPrompt: "EXACT SAVED BODY", model: "missing/model", thinking: "max" as const, toolNames: ["missing-tool"] } };
    const h = await fixture({ flag: null, snapshot });
    await h.session.setModel(h.faux.getModel("other")!);
    h.session.setThinkingLevel("high");
    h.session.setActiveToolsByName(["write"]);
    await h.session.prompt("hello");
    expect(h.calls.mock.calls[0]![0].id).toBe("other");
    expect(h.calls.mock.calls[0]![2]?.reasoning).toBe("high");
    expect(h.session.getActiveToolNames()).toEqual(["write"]);
    expect(JSON.stringify(h.calls.mock.calls[0]![1])).toContain("EXACT SAVED BODY");
    expect(h.shutdown).not.toHaveBeenCalled();
    expect(h.session.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === MAIN_AGENT_ENTRY)).toHaveLength(1);
  });

  it("strong construction-time --tools restriction fails closed if orchestration tool missing", async () => {
    const h = await fixture({ tools: ["read"] });
    await h.session.prompt("hello");
    expect(h.calls).not.toHaveBeenCalled(); expect(h.shutdown).toHaveBeenCalled();
    expect(h.diagnostic).toHaveBeenCalledWith(expect.stringContaining("Unavailable profile tools"));
  });

  it("project trust refusal blocks main but performs no child-loader change", async () => {
    const h = await fixture({ source: "project", trusted: false });
    await h.session.prompt("hello"); expect(h.calls).not.toHaveBeenCalled();
    expect(h.diagnostic).toHaveBeenCalledWith(expect.stringContaining("requires Pi project trust"));
  });

  it("real codemode can call deferred tools outside startup defaults; no capability deny gate", async () => {
    const h = await fixture({ toolNames: ["read", "codemode"], responses: [
      fauxAssistantMessage(fauxToolCall("codemode", { code: "return await tools.secret({});" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ] });
    await h.session.prompt("try nested tool");
    expect(h.secret).toHaveBeenCalledTimes(1);
    const result = h.session.messages.find(m => m.role === "toolResult" && m.toolName === "codemode");
    expect(JSON.stringify(result)).toContain("SECRET");
    expect(h.calls).toHaveBeenCalledTimes(2);
  }, 20_000);
});
