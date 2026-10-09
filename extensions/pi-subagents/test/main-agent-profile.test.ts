import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// Installed renderer is not public SDK API; tests only.
import { buildSystemPrompt, normalizeBuildSystemPromptOptions } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIN_AGENT_ENTRY, MAIN_AGENT_REQUIRED_TOOLS, MAIN_AGENT_SECTION, registerMainAgentProfile, resolveMainAgentProfile } from "#src/main-agent-profile";
import { buildParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { buildAgentPrompt } from "#src/session/prompts";
import { loadCustomAgents } from "#src/config/custom-agents";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { AgentConfig } from "#src/types";
import { makeModel } from "#test/helpers/make-model";

function harness(mode: ExtensionContext["mode"] = "tui") {
  const handlers = new Map<string, Function[]>();
  const model = makeModel({ reasoning: true });
  const other = makeModel({ id: "other", reasoning: true });
  const state = {
    flag: "reader" as string | undefined,
    modelOverride: undefined as string | undefined,
    profile: { name: "reader", description: "read", systemPrompt: "ONLY MAIN", promptMode: "append", toolNames: ["read"] } as AgentConfig,
    model, thinking: "medium", active: ["read", "write", ...MAIN_AGENT_REQUIRED_TOOLS] as string[],
    all: ["read", "write", "codemode", "tool_search", "secret", ...MAIN_AGENT_REQUIRED_TOOLS].map(name => ({ name, exposure: name === "secret" ? "deferred" : "direct" })),
    branch: [] as any[], available: [model, other], trusted: true,
    clamp: false, auth: true, cannotActivate: false,
  };
  const ctx = {
    mode, hasUI: mode === "tui" || mode === "rpc", cwd: "/different/session",
    get model() { return state.model; }, get signal() { return undefined; },
    sessionManager: { getBranch: () => state.branch },
    modelRegistry: { find: (p: string, id: string) => state.available.find(m => m.provider === p && m.id === id), getAvailable: () => state.available, getAll: () => state.available },
    ui: { notify: vi.fn(), setStatus: vi.fn() }, getSystemPrompt: () => "",
    isProjectTrusted: () => state.trusted, abort: vi.fn(), shutdown: vi.fn(),
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, fn: Function) => { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    registerFlag: vi.fn(), getFlag: (name: string) => name === "agent" ? state.flag : name === "agent-model" ? state.modelOverride : undefined,
    getActiveTools: () => [...state.active], getAllTools: () => state.all,
    getThinkingLevel: () => state.thinking,
    setThinkingLevel: vi.fn((level: string) => { state.thinking = state.clamp ? "off" : level; }),
    setActiveTools: vi.fn((tools: string[]) => { state.active = state.cannotActivate ? [] : tools; }),
    setModel: vi.fn(async (m: typeof model) => { if (!state.auth) return false; state.model = m; state.thinking = "off"; return true; }),
    appendEntry: vi.fn((customType: string, data: unknown) => { state.branch.push({ type: "custom", customType, data }); }),
  };
  const diagnostic = vi.fn(); const resolve = vi.fn(() => state.profile);
  registerMainAgentProfile(pi as unknown as ExtensionAPI, { resolveProfile: resolve, diagnostic });
  const fire = async (name: string, event: any = {}, context = ctx) => {
    let result: any; for (const fn of handlers.get(name) ?? []) result = await fn(event, context); return result;
  };
  const start = (reason = "startup") => fire("session_start", { reason });
  const prompt = async () => {
    const systemPromptOptions = normalizeBuildSystemPromptOptions({ cwd: ctx.cwd, customPrompt: "PARENT BASE", appendSystemPrompt: "PARENT ADDENDUM", contextFiles: [{ path: "/parent/AGENTS.md", content: "PROJECT" }], selectedTools: state.active });
    await fire("before_agent_start", { systemPromptOptions });
    ctx.getSystemPrompt = () => buildSystemPrompt(systemPromptOptions);
    return systemPromptOptions;
  };
  const manual = () => { state.model = other; state.thinking = "high"; state.active = ["write", "tool_search"]; };
  return { state, ctx, pi, diagnostic, resolve, fire, start, prompt, other, manual, handlers };
}

describe("main profile defaults and persistent body", () => {
  it.each(["tui", "print", "rpc", "json"] as const)("applies explicit startup defaults once; manual settings remain (%s)", async mode => {
    const h = harness(mode); Object.assign(h.state.profile, { model: "anthropic/other", thinking: "high" });
    await h.start();
    expect(h.pi.registerFlag).toHaveBeenCalledWith("agent", expect.objectContaining({ type: "string" }));
    expect(h.state.model.id).toBe("other"); expect(h.state.thinking).toBe("high");
    expect(h.state.active).toEqual(["read", ...MAIN_AGENT_REQUIRED_TOOLS]);
    expect(h.pi.setModel.mock.invocationCallOrder[0]).toBeLessThan(h.pi.setThinkingLevel.mock.invocationCallOrder[0]!);
    expect(h.state.branch[0].data).toEqual({ version: 1, profile: h.state.profile });
    h.manual(); h.state.model = makeModel(); h.state.thinking = "off";
    await h.fire("input"); await h.fire("turn_start"); const options = await h.prompt();
    expect(h.state.model.id).toBe("test-model"); expect(h.state.thinking).toBe("off"); expect(h.state.active).toEqual(["write", "tool_search"]);
    expect(options.selectedTools).toEqual(["write", "tool_search"]); expect(options.sections[MAIN_AGENT_SECTION]).toContain("ONLY MAIN");
    expect(h.pi.setActiveTools).toHaveBeenCalledTimes(1); expect(h.pi.setModel).toHaveBeenCalledTimes(1);
    expect(mode === "tui" || mode === "rpc" ? h.ctx.ui.notify : h.diagnostic).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "anthropic/test-model", "anthropic/missing"])("explicit model replaces profile default %s in snapshot only", async profileModel => {
    const h = harness();
    Object.assign(h.state.profile, { model: profileModel, thinking: "high" });
    const original = structuredClone(h.state.profile);
    h.state.modelOverride = "  anthropic/other  ";
    await h.start();
    expect(h.pi.registerFlag).toHaveBeenCalledWith("agent-model", expect.objectContaining({ type: "string" }));
    expect(h.pi.setModel).toHaveBeenCalledWith(h.other);
    expect(h.state.model.id).toBe("other");
    expect(h.state.thinking).toBe("high");
    expect(h.state.active).toEqual(["read", ...MAIN_AGENT_REQUIRED_TOOLS]);
    expect(h.state.branch[0].data.profile).toEqual({ ...original, model: "anthropic/other" });
    expect(h.state.profile).toEqual(original);
    expect(h.ctx.shutdown).not.toHaveBeenCalled();
  });

  it("model override uses existing fuzzy resolution and preserves omitted thinking", async () => {
    const h = harness(); h.state.modelOverride = "other";
    await h.start();
    expect(h.state.model.id).toBe("other");
    expect(h.state.thinking).toBe("off");
    expect(h.pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(h.state.branch[0].data.profile.model).toBe("other");
  });

  it("override matching current model still replaces unavailable profile default", async () => {
    const h = harness(); h.state.profile.model = "anthropic/missing";
    h.state.modelOverride = "anthropic/test-model";
    await h.start();
    expect(h.pi.setModel).not.toHaveBeenCalled();
    expect(h.state.thinking).toBe("medium");
    expect(h.state.branch[0].data.profile.model).toBe("anthropic/test-model");
    expect(h.ctx.shutdown).not.toHaveBeenCalled();
  });

  it.each(["", "  ", "anthropic/missing", "missing"])("invalid override fails before any defaults mutate: %j", async modelOverride => {
    const h = harness("print"); h.state.modelOverride = modelOverride;
    Object.assign(h.state.profile, { model: "anthropic/other", thinking: "high" });
    await h.start();
    expect(h.ctx.shutdown).toHaveBeenCalled();
    expect(await h.fire("input")).toEqual({ action: "handled" });
    expect(h.pi.setModel).not.toHaveBeenCalled();
    expect(h.pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(h.pi.setActiveTools).not.toHaveBeenCalled();
    expect(h.pi.appendEntry).not.toHaveBeenCalled();
    expect(h.diagnostic).toHaveBeenCalledWith(modelOverride.trim()
      ? `Main agent blocked: Unavailable profile model: ${modelOverride}.`
      : "Main agent blocked: --agent-model requires a non-empty model.");
  });

  it("thinking validation checks override model before defaults mutate", async () => {
    const h = harness("print");
    h.state.available = [h.state.model, makeModel({ id: "other", reasoning: false })];
    Object.assign(h.state.profile, { model: "anthropic/test-model", thinking: "high" });
    h.state.modelOverride = "anthropic/other";
    await h.start();
    expect(h.diagnostic).toHaveBeenCalledWith("Main agent blocked: Thinking level high is unavailable for anthropic/other.");
    expect(h.pi.setModel).not.toHaveBeenCalled();
    expect(h.pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(h.pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("override authentication failure blocks selection", async () => {
    const h = harness("print"); h.state.modelOverride = "anthropic/other"; h.state.auth = false;
    await h.start();
    expect(h.pi.setModel).toHaveBeenCalledWith(h.other);
    expect(h.diagnostic).toHaveBeenCalledWith("Main agent blocked: Cannot authenticate profile model: anthropic/other.");
    expect(await h.fire("input")).toEqual({ action: "handled" });
    expect(h.pi.setActiveTools).not.toHaveBeenCalled();
    expect(h.pi.appendEntry).not.toHaveBeenCalled();
  });

  it.each(["", "anthropic/missing", "anthropic/other"])("model override has no effect without explicit agent: %j", async modelOverride => {
    const h = harness(); h.state.flag = undefined; h.state.modelOverride = modelOverride;
    await h.start();
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.pi.setModel).not.toHaveBeenCalled();
    expect(h.pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(h.pi.setActiveTools).not.toHaveBeenCalled();
    expect(h.pi.appendEntry).not.toHaveBeenCalled();
    expect(h.ctx.shutdown).not.toHaveBeenCalled();
  });

  it("retained override never reapplies on turns, new, resume, reload, fork or tree", async () => {
    const h = harness(); h.state.modelOverride = "anthropic/other";
    Object.assign(h.state.profile, { model: "anthropic/missing", thinking: "high" });
    await h.start();
    const saved = structuredClone(h.state.branch);
    h.manual(); h.state.model = makeModel(); h.state.thinking = "off";
    // Even a now-invalid flag is ignored on every restoration path.
    h.state.modelOverride = ""; h.state.available = [];
    await h.fire("input"); await h.prompt();
    for (const reason of ["reload", "resume", "fork"]) await h.start(reason);
    await h.fire("session_tree");
    expect(h.state.branch).toEqual(saved);
    expect((await h.prompt()).sections[MAIN_AGENT_SECTION]).toContain("ONLY MAIN");
    h.state.branch = [];
    await h.start("new");
    expect((await h.prompt()).sections[MAIN_AGENT_SECTION]).toBeUndefined();
    h.state.branch = saved; await h.start("resume"); await h.fire("session_tree");
    expect((await h.prompt()).sections[MAIN_AGENT_SECTION]).toContain("ONLY MAIN");
    expect(h.state.model.id).toBe("test-model");
    expect(h.state.thinking).toBe("off");
    expect(h.state.active).toEqual(["write", "tool_search"]);
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.pi.setModel).toHaveBeenCalledTimes(1);
    expect(h.pi.setThinkingLevel).toHaveBeenCalledTimes(1);
    expect(h.pi.setActiveTools).toHaveBeenCalledTimes(1);
    expect(h.pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(h.ctx.shutdown).not.toHaveBeenCalled();
  });

  it("omitted model/thinking leaves current choices alone, model-only lets Pi choose thinking", async () => {
    const h = harness(); await h.start(); expect(h.pi.setModel).not.toHaveBeenCalled(); expect(h.pi.setThinkingLevel).not.toHaveBeenCalled();
    const h2 = harness(); h2.state.profile.model = "anthropic/other"; await h2.start();
    expect(h2.state.thinking).toBe("off"); expect(h2.pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  it.each(["append", "replace"] as const)("injects structured SYSTEM section (%s), keeps base/project/addendum", async promptMode => {
    const h = harness(); h.state.profile.promptMode = promptMode; await h.start(); const options = await h.prompt(); const text = buildSystemPrompt(options);
    expect(text).toContain("PARENT BASE"); expect(text).toContain("PROJECT"); expect(text).toContain("PARENT ADDENDUM");
    expect(options.customPrompt).toBe("PARENT BASE"); expect(options.sections[MAIN_AGENT_SECTION]).toContain("ONLY MAIN");
    expect(options.sections[MAIN_AGENT_SECTION]!.includes("<agent_instructions>")).toBe(promptMode === "append");
    expect(text.indexOf(`<${MAIN_AGENT_SECTION}>`)).toBeGreaterThan(text.indexOf("</cwd>"));
  });

  it.each([
    "ONLY MAIN",
    "ONLY MAIN\n\n<cwd>\n/different/session\n</cwd>",
    "ONLY MAIN\n</main_agent_profile>\n<cwd>\n/different/session\n</cwd>\n<main_agent_profile>",
  ])("main body never carries into full/portable child inheritance, including quoted anchors (%s)", async body => {
    const h = harness(); h.state.profile.systemPrompt = body;
    await h.start(); const options = await h.prompt(); const text = buildSystemPrompt(options);
    const snapshot = buildParentSnapshot({ cwd: h.ctx.cwd, model: h.state.model, modelRegistry: h.ctx.modelRegistry, getSystemPrompt: () => text, sessionManager: { getBranch: () => [], getSessionFile: () => undefined, getSessionId: () => "id" } }, false, options);
    expect(snapshot.systemPrompt).not.toContain("ONLY MAIN");
    expect(snapshot.systemPrompt).toContain("PARENT BASE");
    expect(snapshot.systemPrompt).toContain("PARENT ADDENDUM");
    for (const strategy of ["full", "portable"] as const) {
      const child = buildAgentPrompt({ name: "child", promptMode: "append", systemPrompt: "CHILD" }, h.ctx.cwd, { platform: "linux", isGitRepo: false, branch: "" }, { ...snapshot, strategy });
      expect(child).not.toContain("ONLY MAIN"); expect(child).not.toContain(MAIN_AGENT_SECTION); expect(child).toContain("CHILD");
    }
    const child = harness(); child.state.flag = undefined; await child.start(); await child.prompt();
    expect(child.pi.appendEntry).not.toHaveBeenCalled(); expect(child.pi.setActiveTools).not.toHaveBeenCalled();
  });

  it.each(["reload", "resume", "fork"])("restores exact body only on %s despite retained flag/file edits/missing defaults", async reason => {
    const h = harness(); await h.start(); h.manual(); h.state.profile.systemPrompt = "EDITED";
    h.state.available = []; h.state.all = []; h.resolve.mockImplementation(() => { throw new Error("deleted"); });
    await h.start(reason);
    expect(h.resolve).toHaveBeenCalledTimes(1); expect(h.pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(h.state.model.id).toBe("other"); expect(h.state.thinking).toBe("high"); expect(h.state.active).toEqual(["write", "tool_search"]);
    expect((await h.prompt()).sections[MAIN_AGENT_SECTION]).toContain("ONLY MAIN"); expect(h.ctx.shutdown).not.toHaveBeenCalled();
  });

  it("retained flag never applies to /new or /resume; tree body follows branch without resetting settings", async () => {
    const h = harness(); await h.start(); const saved = structuredClone(h.state.branch); h.manual(); h.state.branch = [];
    await h.start("new"); expect(h.state.flag).toBe("reader"); expect(h.resolve).toHaveBeenCalledTimes(1);
    expect((await h.prompt()).sections[MAIN_AGENT_SECTION]).toBeUndefined(); expect(h.state.active).toEqual(["write", "tool_search"]);
    h.state.branch = saved; await h.start("resume"); expect((await h.prompt()).sections[MAIN_AGENT_SECTION]).toContain("ONLY MAIN");
    h.state.branch = []; await h.fire("session_tree"); expect((await h.prompt()).sections[MAIN_AGENT_SECTION]).toBeUndefined();
    h.state.branch = saved; await h.fire("session_tree"); expect((await h.prompt()).sections[MAIN_AGENT_SECTION]).toContain("ONLY MAIN");
    expect(h.pi.setActiveTools).toHaveBeenCalledTimes(1); expect(h.state.model.id).toBe("other");
  });

  it("explicit initial flag overrides saved content, recovers corrupt snapshot, deduplicates unchanged reload", async () => {
    const h = harness(); h.state.branch = [{ type: "custom", customType: MAIN_AGENT_ENTRY, data: { version: 9 } }]; await h.start();
    expect(h.ctx.shutdown).not.toHaveBeenCalled(); await h.start("reload"); expect(h.pi.appendEntry).toHaveBeenCalledTimes(1);
    h.state.profile.systemPrompt = "NEW SELECTION"; await h.start("startup");
    expect((await h.prompt()).sections[MAIN_AGENT_SECTION]).toContain("NEW SELECTION"); expect(h.pi.appendEntry).toHaveBeenCalledTimes(2);
  });

  it("tool defaults are not policy; deferred/codemode and manually added tools have no deny gate", async () => {
    const h = harness(); await h.start(); h.manual();
    for (const toolName of ["write", "secret", "codemode", "tool_search"]) expect(await h.fire("tool_call", { toolName, parentToolCallId: "nested" })).toBeUndefined();
    expect(h.handlers.has("tool_call")).toBe(false); expect(h.handlers.has("turn_start")).toBe(false); expect(h.handlers.has("cache_warming_decision")).toBe(false);
  });

  it.each(["unknown", "disabled", "unavailable model", "unavailable tools", "missing orchestration", "thinking mismatch", "clamped thinking", "auth false", "auth throws", "cannot activate", "untrusted", "malformed snapshot"])("invalid selection fails closed: %s", async scenario => {
    const h = harness("print");
    switch (scenario) {
      case "unknown": h.resolve.mockImplementation(() => { throw new Error("Unknown profile"); }); break;
      case "disabled": h.state.profile.enabled = false; break;
      case "unavailable model": h.state.profile.model = "anthropic/missing"; break;
      case "unavailable tools": h.state.profile.toolNames = ["missing"]; break;
      case "missing orchestration": h.state.all = h.state.all.filter(t => t.name !== "subagent"); break;
      case "thinking mismatch": h.state.profile.thinking = "max"; break;
      case "clamped thinking": h.state.profile.thinking = "high"; h.state.clamp = true; break;
      case "auth false": h.state.profile.model = "anthropic/other"; h.state.auth = false; break;
      case "auth throws": h.state.profile.model = "anthropic/other"; h.pi.setModel.mockRejectedValue(new Error("No API key")); break;
      case "cannot activate": h.state.cannotActivate = true; break;
      case "untrusted": h.state.profile.source = "project"; h.state.trusted = false; break;
      case "malformed snapshot": h.state.flag = undefined; h.state.branch = [{ type: "custom", customType: MAIN_AGENT_ENTRY, data: { version: 9 } }]; break;
    }
    await h.start(); expect(h.ctx.shutdown).toHaveBeenCalled(); expect(await h.fire("input")).toEqual({ action: "handled" });
    expect(await h.fire("session_before_compact")).toEqual({ cancel: true }); expect(await h.fire("session_before_tree")).toEqual({ cancel: true });
    expect(h.pi.appendEntry).not.toHaveBeenCalled(); expect(h.diagnostic).toHaveBeenCalledTimes(1);
  });

  it("forced/stripped profile section aborts live context, does not silently run unprofiled", async () => {
    const h = harness(); await h.start(); const options = await h.prompt(); options.forceSystemPrompt = "opaque";
    const live = Object.create(h.ctx); Object.defineProperty(live, "signal", { value: new AbortController().signal });
    await h.fire("context_with_system", { messages: [{ role: "system", sections: { [MAIN_AGENT_SECTION]: `<${MAIN_AGENT_SECTION}>\n${options.sections[MAIN_AGENT_SECTION]}\n</${MAIN_AGENT_SECTION}>` } }] }, live);
    expect(h.ctx.abort).toHaveBeenCalled(); expect(await h.fire("input")).toEqual({ action: "handled" });
  });

  it("sanitizes profile labels and diagnostics before terminal display", async () => {
    const h = harness();
    h.state.profile.name = "reader\x1b]52;c;payload\x07\nprofile";
    await h.start();
    expect(h.ctx.ui.setStatus).toHaveBeenCalledWith("main-agent", "Agent · reader profile");
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Agent reader profile · defaults applied"), "info");
    const failed = harness("print");
    failed.resolve.mockImplementation(() => { throw new Error("Unknown profile\x1b[31m\x1b]0;fake title\x07"); });
    await failed.start();
    expect(failed.diagnostic).toHaveBeenCalledWith("Main agent blocked: Unknown profile");
  });

  it("child-only fields produce compact skipped notice, never turn restrictions", async () => {
    const h = harness(); Object.assign(h.state.profile, { maxTurns: 1, runInBackground: true, inheritContext: false });
    await h.start(); for (let i = 0; i < 5; i++) await h.fire("turn_start");
    expect(h.ctx.ui.notify).toHaveBeenCalledTimes(1); expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Subagent-only fields skipped: max_turns, run_in_background, inherit_context"), "info");
    expect(h.ctx.abort).not.toHaveBeenCalled();
  });
});

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("main profile discovery", () => {
  function project(content: string) {
    const cwd = mkdtempSync(join(tmpdir(), "main-profile-")); dirs.push(cwd);
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true }); writeFileSync(join(cwd, ".pi", "agents", "unique-main-reader.md"), content);
    const h = harness(); Object.assign(h.ctx, { cwd });
    return { cwd, ctx: h.ctx, h };
  }
  it("resolves ctx.cwd, requires Pi trust and rejects unknown without fallback", () => {
    const { ctx } = project("---\ntools: none\n---\nSESSION PROJECT");
    expect(resolveMainAgentProfile("unique-main-reader", ctx).systemPrompt).toBe("SESSION PROJECT");
    expect(() => resolveMainAgentProfile("does-not-exist-unique", ctx)).toThrow("Unknown");
    expect(() => resolveMainAgentProfile("unique-main-reader", { ...ctx, isProjectTrusted: () => false })).toThrow("requires Pi project trust");
  });
  it("composes ordered, deduplicated source-local fragments with fresh body last", () => {
    const { cwd, ctx } = project("---\nfragments: [aws, audit, aws]\n---\nPROFILE BODY");
    const fragments = join(cwd, ".pi", "agents", "fragments");
    mkdirSync(fragments);
    writeFileSync(join(fragments, "aws.md"), "  AWS INSTRUCTIONS\n");
    writeFileSync(join(fragments, "audit.md"), "AUDIT INSTRUCTIONS");
    const profile = resolveMainAgentProfile("unique-main-reader", ctx);
    expect(profile.fragments).toEqual(["aws", "audit"]);
    expect(profile.systemPrompt).toBe("AWS INSTRUCTIONS\n\n---\n\nAUDIT INSTRUCTIONS\n\n---\n\nPROFILE BODY");
    expect(loadCustomAgents(cwd).get("unique-main-reader")?.systemPrompt).toBe("PROFILE BODY");
  });

  it.each(["[aws]", "[]"])("rereads body and fragments together, clearing stale discovery errors (%s)", declaration => {
    const { cwd, ctx } = project(`---\nfragments: ${declaration}\n---\nFRESH BODY`);
    const agents = join(cwd, ".pi", "agents");
    mkdirSync(join(agents, "fragments"));
    writeFileSync(join(agents, "fragments", "aws.md"), "FRESH AWS");
    const stale: AgentConfig = {
      name: "unique-main-reader", description: "read", source: "project", sourcePath: join(agents, "unique-main-reader.md"),
      systemPrompt: "STALE BODY", promptMode: "append", fragments: ["missing"], fragmentError: "Stale invalid schema",
    };
    const read = vi.spyOn(AgentTypeRegistry.prototype, "resolveAgentConfig").mockReturnValueOnce(stale);
    try {
      const profile = resolveMainAgentProfile("unique-main-reader", ctx);
      expect(profile.systemPrompt).toBe(declaration === "[]" ? "FRESH BODY" : "FRESH AWS\n\n---\n\nFRESH BODY");
      expect(profile.fragmentError).toBeUndefined();
      expect(stale.systemPrompt).toBe("STALE BODY");
      expect(stale.fragmentError).toBe("Stale invalid schema");
    } finally { read.mockRestore(); }
  });

  it.each(["[missing]", "[../aws]", "[aws.md]", "aws", "[42]"])("blocks missing/invalid fragments on explicit selection: %s", async declaration => {
    const { ctx, h } = project(`---\nfragments: ${declaration}\n---\nPROFILE BODY`);
    h.resolve.mockImplementation(() => resolveMainAgentProfile("unique-main-reader", ctx));
    await h.start();
    expect(h.ctx.shutdown).toHaveBeenCalled();
    expect(h.pi.appendEntry).not.toHaveBeenCalled();
    expect(h.pi.setActiveTools).not.toHaveBeenCalled();
    expect(await h.fire("input")).toEqual({ action: "handled" });
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("fragment"), "error");
  });

  it("rejects untrusted project before looking for missing fragments", () => {
    const { ctx } = project("---\nfragments: [missing]\n---\nBODY");
    expect(() => resolveMainAgentProfile("unique-main-reader", { ...ctx, isProjectTrusted: () => false }))
      .toThrow("requires Pi project trust");
  });

  it("looks only beside winning global/project profile, never falls back across scopes", () => {
    const { cwd, ctx } = project("---\nfragments: [aws]\n---\nPROJECT BODY");
    const previous = process.env.PI_CODING_AGENT_DIR;
    const global = join(cwd, "global");
    process.env.PI_CODING_AGENT_DIR = global;
    try {
      const globalAgents = join(global, "agents");
      const projectAgents = join(cwd, ".pi", "agents");
      mkdirSync(join(globalAgents, "fragments"), { recursive: true });
      writeFileSync(join(globalAgents, "unique-main-reader.md"), "---\nfragments: [aws]\n---\nGLOBAL BODY");
      writeFileSync(join(globalAgents, "fragments", "aws.md"), "GLOBAL AWS");
      expect(() => resolveMainAgentProfile("unique-main-reader", ctx)).toThrow(join(projectAgents, "fragments", "aws.md"));
      mkdirSync(join(projectAgents, "fragments"));
      writeFileSync(join(projectAgents, "fragments", "aws.md"), "PROJECT AWS");
      expect(resolveMainAgentProfile("unique-main-reader", ctx).systemPrompt).toBe("PROJECT AWS\n\n---\n\nPROJECT BODY");
      rmSync(join(projectAgents, "unique-main-reader.md"));
      expect(resolveMainAgentProfile("unique-main-reader", { ...ctx, isProjectTrusted: () => false }).systemPrompt)
        .toBe("GLOBAL AWS\n\n---\n\nGLOBAL BODY");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  it("restores frozen expanded instructions after fragment edits/deletion, without resolving again", async () => {
    const { cwd, ctx, h } = project("---\ntools: none\nfragments: [aws]\n---\nFROZEN BODY");
    const fragments = join(cwd, ".pi", "agents", "fragments");
    mkdirSync(fragments);
    const path = join(fragments, "aws.md");
    writeFileSync(path, "FROZEN AWS");
    h.resolve.mockImplementation(() => resolveMainAgentProfile("unique-main-reader", ctx));
    await h.start();
    const frozen = "FROZEN AWS\n\n---\n\nFROZEN BODY";
    expect(h.state.branch[0].data.profile.systemPrompt).toBe(frozen);
    h.manual();
    for (const reason of ["reload", "resume", "fork"]) {
      writeFileSync(path, "EDITED AWS");
      if (reason !== "reload") rmSync(path);
      await h.start(reason);
      expect((await h.prompt()).sections[MAIN_AGENT_SECTION]).toContain(frozen);
      expect((await h.prompt()).sections[MAIN_AGENT_SECTION]).not.toContain("EDITED AWS");
    }
    rmSync(join(cwd, ".pi", "agents", "unique-main-reader.md"));
    await h.fire("session_tree");
    expect((await h.prompt()).sections[MAIN_AGENT_SECTION]).toContain(frozen);
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(h.pi.setActiveTools).toHaveBeenCalledTimes(1);
    expect(h.ctx.shutdown).not.toHaveBeenCalled();
  });

  it("strict main thinking does not change tolerant child loader", () => {
    const { ctx, cwd } = project("---\nthinking: banana\n---\nBODY");
    expect(() => resolveMainAgentProfile("unique-main-reader", ctx)).toThrow("Invalid thinking level"); expect(loadCustomAgents(cwd).get("unique-main-reader")?.thinking).toBeUndefined();
  });
});
