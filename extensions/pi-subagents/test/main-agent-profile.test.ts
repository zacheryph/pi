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
import type { AgentConfig } from "#src/types";
import { makeModel } from "#test/helpers/make-model";

function harness(mode: ExtensionContext["mode"] = "tui") {
  const handlers = new Map<string, Function[]>();
  const model = makeModel({ reasoning: true });
  const other = makeModel({ id: "other", reasoning: true });
  const state = {
    flag: "reader" as string | undefined,
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
    registerFlag: vi.fn(), getFlag: () => state.flag,
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
    const h = harness(); return { cwd, ctx: { ...h.ctx, cwd } as ExtensionContext };
  }
  it("resolves ctx.cwd, requires Pi trust and rejects unknown without fallback", () => {
    const { ctx } = project("---\ntools: none\n---\nSESSION PROJECT");
    expect(resolveMainAgentProfile("unique-main-reader", ctx).systemPrompt).toBe("SESSION PROJECT");
    expect(() => resolveMainAgentProfile("does-not-exist-unique", ctx)).toThrow("Unknown");
    expect(() => resolveMainAgentProfile("unique-main-reader", { ...ctx, isProjectTrusted: () => false })).toThrow("requires Pi project trust");
  });
  it("strict main thinking does not change tolerant child loader", () => {
    const { ctx, cwd } = project("---\nthinking: banana\n---\nBODY");
    expect(() => resolveMainAgentProfile("unique-main-reader", ctx)).toThrow("Invalid thinking level"); expect(loadCustomAgents(cwd).get("unique-main-reader")?.thinking).toBeUndefined();
  });
});
