import type { ExtensionAPI, ExtensionCommandContext, Skill, ToolInfo, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import systemInsights from "#src/index";
import { SKILL_READ_ENTRY } from "#src/skills";
import { showInsightView } from "#src/viewer";

vi.mock("#src/viewer", () => ({ showInsightView: vi.fn(async () => {}) }));

const source = { path: "/project/skills/example/SKILL.md", source: "local", scope: "project", origin: "top-level" } as const;
const skill: Skill = {
  name: "example", description: "Example skill description", filePath: source.path,
  baseDir: "/project/skills/example", sourceInfo: source, disableModelInvocation: false,
};
const tool: ToolInfo = {
  name: "read", description: "Registry read description", exposure: "direct",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  sourceInfo: { ...source, path: "builtin:read" },
};

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type ResultHandler = (event: ToolResultEvent, ctx: ExtensionCommandContext) => unknown;

function harness() {
  const commands = new Map<string, Command>();
  const events = new Map<string, ResultHandler>();
  const appendEntry = vi.fn();
  const getAllTools = vi.fn(() => [tool]);
  const getActiveTools = vi.fn(() => ["read"]);
  const getCommands = vi.fn(() => [{ name: "skill:example", source: "skill", sourceInfo: source }]);
  const pi = {
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    on: (name: string, handler: ResultHandler) => events.set(name, handler),
    appendEntry, getAllTools, getActiveTools, getCommands,
  } as unknown as ExtensionAPI;
  const sessionManager = SessionManager.inMemory("/project");
  const ctx = {
    mode: "tui", hasUI: true, cwd: "/project", sessionManager,
    getSystemPrompt: vi.fn(() => "Exact current prompt\n<rules>custom</rules>"),
    getSystemPromptOptions: vi.fn(() => ({ cwd: "/project", skills: [skill], selectedTools: ["read"] })),
    ui: { notify: vi.fn() },
  } as unknown as ExtensionCommandContext;
  systemInsights(pi);
  return { commands, events, appendEntry, getAllTools, getActiveTools, getCommands, ctx, sessionManager };
}

const result = (overrides: Partial<ToolResultEvent> = {}): ToolResultEvent => ({
  type: "tool_result", toolName: "read", toolCallId: "parent/1", parentToolCallId: "parent",
  input: { path: "skills/example/SKILL.md" }, content: [{ type: "text", text: "Instructions" }],
  details: undefined, isError: false, ...overrides,
} as ToolResultEvent);

beforeEach(() => vi.clearAllMocks());

describe("system insights commands", () => {
  it("registers exactly three commands and one metadata-only result observer", () => {
    const h = harness();
    expect([...h.commands.keys()]).toEqual(["system:prompt", "system:tools", "system:skills"]);
    expect([...h.events.keys()]).toEqual(["tool_result"]);
    expect(h.getAllTools).not.toHaveBeenCalled();
    expect(h.appendEntry).not.toHaveBeenCalled();
  });

  it("takes current effective prompt from getter, not base options", async () => {
    const h = harness();
    await h.commands.get("system:prompt")!.handler("", h.ctx);
    expect(showInsightView).toHaveBeenCalledWith(h.ctx, expect.objectContaining({
      text: "Exact current prompt\n<rules>custom</rules>",
    }));
    expect(h.ctx.getSystemPromptOptions).not.toHaveBeenCalled();
    expect(h.appendEntry).not.toHaveBeenCalled();
  });

  it("prefers one latest branch tool declaration over duplicate registry content", async () => {
    const h = harness();
    h.sessionManager.appendMessage({ role: "system", content: "", timestamp: 1,
      toolsAdded: [{ name: "read", description: "Rewritten model declaration", parameters: tool.parameters }],
    });
    await h.commands.get("system:tools")!.handler("", h.ctx);
    const view = vi.mocked(showInsightView).mock.calls[0][1];
    expect(view.items).toHaveLength(1);
    expect(view.items![0].detail).not.toContain("Registry read description");
    expect(view.items![0].detail).toContain("Rewritten model declaration");
    expect(h.getActiveTools).toHaveBeenCalledOnce();
    expect(h.appendEntry).not.toHaveBeenCalled();
  });

  it("redacts tools and skills only in prompt display, without changing session getter", async () => {
    const h = harness();
    const original = "Before\n\n<tools>\nTool descriptions\n</tools>\n\n<skills>\nSkill catalog\n</skills>\n\nAfter";
    vi.mocked(h.ctx.getSystemPrompt).mockReturnValue(original);
    await h.commands.get("system:prompt")!.handler("", h.ctx);
    const view = vi.mocked(showInsightView).mock.calls[0][1];
    expect(view.text).toBe("Before\n\n--- TOOLS [redacted] ---\n\n--- SKILLS [redacted] ---\n\nAfter");
    expect(h.ctx.getSystemPrompt()).toBe(original);
    expect(h.ctx.getSystemPromptOptions).not.toHaveBeenCalled();
    expect(h.appendEntry).not.toHaveBeenCalled();
  });

  it("lists current discovered skills without reading files or adding evidence", async () => {
    const h = harness();
    await h.commands.get("system:skills")!.handler("", h.ctx);
    const view = vi.mocked(showInsightView).mock.calls[0][1];
    expect(view.items).toHaveLength(1);
    expect(view.items![0].description).toBe(skill.description);
    expect(view.items![0].detail).toContain(skill.filePath);
    expect(h.appendEntry).not.toHaveBeenCalled();
  });

  it("returns fresh/uncertain skill badge snapshots without viewer-triggered loading", async () => {
    const h = harness();
    const open = () => h.commands.get("system:skills")!.handler("", h.ctx);
    await open();
    expect(vi.mocked(showInsightView).mock.lastCall![1].items![0].badge).toEqual({ label: "[loaded]", color: "dim" });
    const marker = h.sessionManager.appendCustomEntry(SKILL_READ_ENTRY, { path: source.path, partial: false });
    await open();
    expect(vi.mocked(showInsightView).mock.lastCall![1].items![0].badge).toEqual({ label: "[loaded]", color: "success" });
    h.sessionManager.appendCompaction("Summary", marker, 100);
    await open();
    expect(vi.mocked(showInsightView).mock.lastCall![1].items![0].badge).toEqual({ label: "[loaded]", color: "dim" });
    expect(vi.mocked(showInsightView).mock.lastCall![1].legend).toEqual([
      { label: "[loaded]", color: "success", meaning: "fresh observation" },
      { label: "[loaded]", color: "dim", meaning: "unobserved/dirty" },
    ]);
    expect(h.appendEntry).not.toHaveBeenCalled();
  });

  for (const mode of ["rpc", "print", "json"] as const) {
    it(`guards ${mode} before snapshot or custom UI`, async () => {
      const h = harness();
      Object.assign(h.ctx, { mode });
      for (const command of h.commands.values()) await command.handler("", h.ctx);
      expect(h.ctx.ui.notify).toHaveBeenCalledTimes(3);
      expect(showInsightView).not.toHaveBeenCalled();
      expect(h.ctx.getSystemPrompt).not.toHaveBeenCalled();
      expect(h.ctx.getSystemPromptOptions).not.toHaveBeenCalled();
      expect(h.getAllTools).not.toHaveBeenCalled();
    });
  }

  it("guards missing UI even in TUI mode", async () => {
    const h = harness();
    Object.assign(h.ctx, { hasUI: false });
    await h.commands.get("system:prompt")!.handler("", h.ctx);
    expect(showInsightView).not.toHaveBeenCalled();
  });
});

describe("nested skill read evidence", () => {
  it("persists only canonical path and partial flag, never tool contents", () => {
    const h = harness();
    h.events.get("tool_result")!(result(), h.ctx);
    expect(h.appendEntry).toHaveBeenCalledExactlyOnceWith(SKILL_READ_ENTRY, { path: source.path, partial: false });
    expect(JSON.stringify(h.appendEntry.mock.calls)).not.toContain("Instructions");
  });

  it("records partial reads as partial", () => {
    const h = harness();
    h.events.get("tool_result")!(result({ input: { path: source.path, limit: 10 } }), h.ctx);
    expect(h.appendEntry).toHaveBeenCalledWith(SKILL_READ_ENTRY, { path: source.path, partial: true });
  });

  for (const [label, event] of [
    ["failed", result({ isError: true })],
    ["direct", result({ parentToolCallId: undefined })],
    ["unrelated file", result({ input: { path: "/project/README.md" } })],
    ["non-read tool", result({ toolName: "bash", input: { command: "echo hello" } })],
  ] as const) {
    it(`does not persist ${label} reads`, () => {
      const h = harness();
      h.events.get("tool_result")!(event, h.ctx);
      expect(h.appendEntry).not.toHaveBeenCalled();
    });
  }

  it("refreshes discovered paths on every observation, not session_start", () => {
    const h = harness();
    h.getCommands.mockReturnValue([]);
    h.events.get("tool_result")!(result(), h.ctx);
    expect(h.appendEntry).not.toHaveBeenCalled();
    h.getCommands.mockReturnValue([{ name: "skill:example", source: "skill", sourceInfo: source }]);
    h.events.get("tool_result")!(result(), h.ctx);
    expect(h.appendEntry).toHaveBeenCalledOnce();
  });
});
