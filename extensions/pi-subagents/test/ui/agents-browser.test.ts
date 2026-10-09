import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry, BUILTIN_TOOL_NAMES } from "#src/config/agent-types";
import { loadCustomAgents } from "#src/config/custom-agents";
import type { AgentConfig } from "#src/types";
import { buildAgentsView, showAgentsBrowser, type AgentsBrowserOptions } from "#src/ui/agents-browser";
import { ReadOnlyBrowser } from "#src/ui/read-only-browser";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "auditor", displayName: "Auditor", description: "First line\nSecond line",
    systemPrompt: "# Instructions\n  Keep indentation.\n\n**Literal Markdown**\nLast instruction.",
    promptMode: "append", ...overrides,
  };
}
const registry = (config = agent()) => new AgentTypeRegistry(() => new Map([[config.name, config]]));
const detail = (config = agent(), defaults = {}, options: AgentsBrowserOptions = {}) =>
  buildAgentsView(registry(config), defaults, options).items.at(-1)!.detail;
const field = (text: string, label: string) => new RegExp(`^${label}: +(.+)$`, "m").exec(text)?.[1];

describe("effective agent definitions", () => {
  it("lists defaults and disabled overrides without description rows", () => {
    const r = registry(agent({ name: "Explore", enabled: false, source: "project", toolNames: [] }));
    const view = buildAgentsView(r);
    expect(view.items.map(item => item.label)).toEqual(["general-purpose", "Explore", "Plan"]);
    expect(view.items.find(item => item.label === "Explore")).toMatchObject({
      status: "disabled", badge: { label: "[disabled]", color: "dim" }, description: "First line\nSecond line",
    });
    expect(view.items[0].badge).toEqual({ label: "[enabled]", color: "success" });
    const config = view.items.find(item => item.label === "Explore")!.detail;
    expect(field(config, "Enabled")).toBe("false");
    expect(field(config, "Source")).toBe("project");
    expect(field(config, "Tools")).toBe("(none)");
    expect(r.isValidType("Explore")).toBe(false);
    expect(r.getAvailableTypes()).not.toContain("Explore");
  });

  it("orders Name, effective fields, Description, then full-width Body on following line", () => {
    const config = agent({
      source: "project", sourcePath: "/project/.pi/agents/auditor.md", toolNames: ["read", "mcp__github__*"],
      model: "provider/model", thinking: "high", maxTurns: 30, inheritContext: true, runInBackground: false,
      locked: ["model", "thinking"], toolGuideline: "Pick auditor for reviews.",
    });
    const text = detail(config);
    expect(text.split("\n")[0]).toMatch(/^Name: +auditor$/);
    expect(field(text, "Display name")).toBe("Auditor");
    expect(field(text, "Source path")).toBe(config.sourcePath);
    expect(field(text, "Tools")).toBe("read, mcp__github__*");
    expect(field(text, "Model")).toBe("provider/model");
    expect(field(text, "Thinking")).toBe("high");
    expect(field(text, "Max turns")).toBe("30");
    expect(field(text, "Prompt mode")).toBe("append");
    expect(field(text, "Inherit context")).toBe("true");
    expect(field(text, "Run in background")).toBe("false");
    expect(field(text, "Locked")).toBe("model, thinking");
    expect(field(text, "Tool guideline")).toBe(config.toolGuideline);
    const lines = text.split("\n");
    const description = lines.findIndex(line => line.startsWith("Description:"));
    const heading = lines.indexOf("Body");
    expect(description).toBeGreaterThan(lines.findIndex(line => line.startsWith("Locked:")));
    expect(lines[description + 1]).toMatch(/^ +Second line$/);
    expect(heading).toBe(description + 3); // continuation, blank, Body
    expect(lines.slice(heading + 1).join("\n")).toBe(config.systemPrompt);
    expect(lines[heading + 1]).toBe("# Instructions");
    expect(text).not.toMatch(/^Body: +\S/m);
  });

  it("shows inherited/default fields honestly, normalized limits and empty Body", () => {
    const text = detail(agent({ systemPrompt: "", displayName: undefined }));
    expect(field(text, "Display name")).toBe("auditor");
    expect(field(text, "Tools")).toBe(BUILTIN_TOOL_NAMES.join(", "));
    expect(field(text, "Model")).toBe("(inherit parent)");
    expect(field(text, "Thinking")).toBe("(inherit parent)");
    expect(field(text, "Max turns")).toBe("unlimited");
    expect(field(text, "Inherit context")).toBe("false (tool default; caller decides)");
    expect(field(text, "Run in background")).toBe("false (tool default; caller decides)");
    expect(field(text, "Locked")).toBe("(none)");
    expect(field(text, "Source path")).toBe("(not available)");
    expect(text.endsWith("\n\nBody\n(empty)")).toBe(true);
    expect(field(detail(agent({ maxTurns: 1 })), "Max turns")).toBe("2 (configured: 1)");
    expect(field(detail(agent({ maxTurns: 0 }), { defaultMaxTurns: 20 }), "Max turns")).toBe("unlimited (configured: 0)");
    expect(field(detail(agent(), { defaultMaxTurns: 1 }), "Max turns")).toBe("2 (configured: 1) (extension default)");
    const embedded = buildAgentsView(registry()).items[0].detail;
    expect(field(embedded, "Source")).toBe("default (embedded)");
    expect(field(embedded, "Source path")).toBe("(embedded)");
  });

  it("whole-file locks only claim declared fields, explicit lists also lock absent fields", () => {
    expect(field(detail(agent({ locked: true, model: "m", inheritContext: false, maxTurns: 0 })), "Locked"))
      .toBe("true (declared fields: model, max_turns, inherit_context)");
    expect(field(detail(agent({ locked: true })), "Locked")).toBe("true (declared fields: none)");
    expect(field(detail(agent({ locked: ["thinking"] })), "Locked")).toBe("thinking");
  });

  it("snapshots plain strings; registry mutations cannot change an open view", () => {
    const config = agent({ toolNames: ["read"], locked: ["model"] });
    const r = registry(config);
    const view = buildAgentsView(r);
    config.toolNames!.push("write");
    config.systemPrompt = "changed";
    config.enabled = false;
    config.description = "changed";
    expect(view.items.at(-1)!.detail).not.toContain("changed");
    expect(field(view.items.at(-1)!.detail, "Tools")).toBe("read");
    expect(view.items.at(-1)!.status).toBe("enabled");
  });

  it("preserves body whitespace/literal Markdown, strips unsafe terminal text before alignment", () => {
    const text = detail(agent({
      description: "Review\x1b]52;c;bad\x07\nContinue", model: "ok\x1b[2J", sourcePath: "/safe\u202efile",
      systemPrompt: "  instruction\n\n```text\n\tKeep literal.\n```\x1b]0;unfinished",
    }));
    expect(text).not.toMatch(/[\x1b\x07\u202e]/);
    expect(field(text, "Model")).toBe("ok");
    expect(field(text, "Source path")).toBe("/safefile");
    expect(text.endsWith("\nBody\n  instruction\n\n```text\n    Keep literal.\n```")).toBe(true);
  });

  it("shows raw Body, ordered source-local provenance and composed instructions without mutating config", () => {
    const config = agent({ source: "global", sourcePath: "/global/agents/auditor.md", fragments: ["aws", "audit", "aws"], systemPrompt: "RAW BODY" });
    const readFile = vi.fn((path: string) => path.endsWith("aws.md") ? "AWS\x1b[31m" : "AUDIT\x1b]52;c;payload\x07");
    const text = detail(config, {}, { readFile });
    expect(text).toContain("\nBody\nRAW BODY\n\nFragments\n1. aws\n   /global/agents/fragments/aws.md\n2. audit\n   /global/agents/fragments/audit.md");
    expect(text).toContain("\nComposed instructions\nAWS\n\n---\n\nAUDIT\n\n---\n\nRAW BODY");
    expect(text).not.toMatch(/[\x1b\x07]/);
    expect(readFile.mock.calls.map(([path]) => path)).toEqual(["/global/agents/fragments/aws.md", "/global/agents/fragments/audit.md"]);
    expect(config.systemPrompt).toBe("RAW BODY");
    expect(config.fragments).toEqual(["aws", "audit", "aws"]);
  });

  it("keeps provenance and Body when missing fragment blocks composition; sanitizes error", () => {
    const readFile = vi.fn(() => { throw new Error("ENOENT\x1b]0;fake title\x07"); });
    const text = detail(agent({ fragments: ["missing"], sourcePath: "/project/.pi/agents/auditor.md", systemPrompt: "RAW BODY" }), {}, { readFile });
    expect(text).toContain("\nBody\nRAW BODY");
    expect(text).toContain("1. missing\n   /project/.pi/agents/fragments/missing.md");
    expect(text).toContain("Composed instructions\nError:");
    expect(text).toContain("ENOENT");
    expect(text).not.toMatch(/[\x1b\x07]/);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it.each([false, undefined])("blocks untrusted project preview without fragment IO (%s)", projectTrusted => {
    const readFile = vi.fn(() => "SECRET");
    const config = agent({ source: "project", sourcePath: "/project/.pi/agents/auditor.md", fragments: ["aws"], systemPrompt: "RAW BODY" });
    const text = detail(config, {}, { projectTrusted, readFile });
    expect(text).toContain("\nBody\nRAW BODY");
    expect(text).toContain("1. aws\n   /project/.pi/agents/fragments/aws.md");
    expect(text).toContain("Composed instructions\nError:");
    expect(text).toContain("require Pi project trust");
    expect(text).not.toContain("SECRET");
    expect(readFile).not.toHaveBeenCalled();
    expect(detail(config, {}, { projectTrusted: true, readFile })).toContain("SECRET\n\n---\n\nRAW BODY");
  });

  it("shows invalid declarations/errors without fragment IO and leaves no-fragment view unchanged", () => {
    const readFile = vi.fn(() => "UNEXPECTED");
    for (const overrides of [{ fragmentError: "Invalid fragment declaration" }, { fragments: ["../aws"] }]) {
      const text = detail(agent(overrides), {}, { projectTrusted: true, readFile });
      expect(text).toContain("Composed instructions\nError:");
      expect(text).toContain("Invalid fragment");
      expect(text).not.toContain("UNEXPECTED");
    }
    const config = agent({ fragments: [], source: "project" });
    const text = detail(config, {}, { projectTrusted: false, readFile });
    expect(text).toBe(detail(agent({ source: "project" })));
    expect(text).not.toContain("Composed instructions");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("snapshots composed preview even if fragment reader later changes", () => {
    const config = agent({ sourcePath: "/global/agents/auditor.md", fragments: ["aws"] });
    const readFile = vi.fn(() => "ORIGINAL");
    const view = buildAgentsView(registry(config), {}, { readFile });
    readFile.mockReturnValue("EDITED");
    expect(view.items.at(-1)!.detail).toContain("ORIGINAL");
    expect(view.items.at(-1)!.detail).not.toContain("EDITED");
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("loader captures winning path; new registry reflects edits and cwd without mutating old registry", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agents-browser-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "global");
    const project = join(root, "project");
    try {
      const globalDir = join(root, "global", "agents");
      const projectDir = join(project, ".pi", "agents");
      mkdirSync(globalDir, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(globalDir, "Explore.md"), "Global body");
      const path = join(projectDir, "Explore.md");
      writeFileSync(path, "---\nenabled: false\n---\nProject body");
      const old = new AgentTypeRegistry(() => loadCustomAgents(project));
      const view = buildAgentsView(old);
      expect(field(view.items[1].detail, "Source path")).toBe(path);
      expect(field(view.items[1].detail, "Source")).toBe("project");
      expect(view.items[1].detail.endsWith("\nBody\nProject body")).toBe(true);
      writeFileSync(path, "New project body");
      const fresh = new AgentTypeRegistry(() => loadCustomAgents(project));
      expect(buildAgentsView(fresh).items[1].detail.endsWith("\nBody\nNew project body")).toBe(true);
      expect(old.resolveAgentConfig("Explore").enabled).toBe(false);
      const global = new AgentTypeRegistry(() => loadCustomAgents(root));
      expect(field(buildAgentsView(global).items[1].detail, "Source path")).toBe(join(globalDir, "Explore.md"));
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("showAgentsBrowser", () => {
  it.each(["rpc", "json", "print"] as const)("guards %s before reading registry", async mode => {
    const r = registry();
    const read = vi.spyOn(r, "getAllTypes");
    const ui = { notify: vi.fn(), custom: vi.fn() };
    await showAgentsBrowser({ mode, hasUI: true, ui: ui as unknown as ExtensionContext["ui"] }, r);
    expect(read).not.toHaveBeenCalled();
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Agent definitions browser requires TUI mode.", "warning");
  });

  it.each([false, true])("uses live project trust for composed browser preview (%s)", async trusted => {
    const root = mkdtempSync(join(tmpdir(), "pi-browser-trust-"));
    try {
      mkdirSync(join(root, "fragments"));
      writeFileSync(join(root, "fragments", "aws.md"), "TRUSTED FRAGMENT CONTENT");
      const r = registry(agent({ source: "project", sourcePath: join(root, "auditor.md"), fragments: ["aws"], systemPrompt: "RAW BODY" }));
      type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
      const { KeybindingsManager, TUI_KEYBINDINGS } = await import("@earendil-works/pi-tui");
      const components: Awaited<ReturnType<Factory>>[] = [];
      const ui = { notify: vi.fn(), custom: vi.fn(async (factory: Factory) => {
        let result: unknown;
        components.push(await factory({ mode: "regular", terminal: { rows: 100, columns: 160 }, requestRender() {} } as Parameters<Factory>[0], {
          fg: (_token: string, text: string) => text, bold: (text: string) => text,
        } as Parameters<Factory>[1], new KeybindingsManager(TUI_KEYBINDINGS) as Parameters<Factory>[2], value => { result = value; }));
        return result;
      }) };
      const isProjectTrusted = vi.fn(() => trusted);
      await showAgentsBrowser({ mode: "tui", hasUI: true, ui: ui as unknown as ExtensionContext["ui"], isProjectTrusted }, r);
      const browser = components[1] as ReadOnlyBrowser;
      browser.handleInput("auditor");
      browser.handleInput("\r");
      const text = browser.render(160).join("\n");
      expect(isProjectTrusted).toHaveBeenCalledTimes(1);
      expect(text).toContain("Composed instructions");
      if (trusted) expect(text).toContain("TRUSTED FRAGMENT CONTENT");
      else {
        expect(text).toContain("require Pi project trust");
        expect(text).not.toContain("TRUSTED FRAGMENT CONTENT");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("handles no UI and passes effective snapshot to actual browser factory", async () => {
    const r = registry();
    type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
    const { KeybindingsManager, TUI_KEYBINDINGS } = await import("@earendil-works/pi-tui");
    const components: Awaited<ReturnType<Factory>>[] = [];
    const ui = { notify: vi.fn(), custom: vi.fn(async (factory: Factory) => {
      const tui = { mode: "regular", terminal: { rows: 100, columns: 120 }, requestRender() {} };
      let result: unknown;
      components.push(await factory(tui as Parameters<Factory>[0], {
        fg: (_token: string, text: string) => text, bold: (text: string) => text,
      } as Parameters<Factory>[1], new KeybindingsManager(TUI_KEYBINDINGS) as Parameters<Factory>[2], value => { result = value; }));
      return result;
    }) };
    const ctx = { mode: "tui" as const, hasUI: false, ui: ui as unknown as ExtensionContext["ui"] };
    await showAgentsBrowser(ctx, r);
    expect(ui.custom).not.toHaveBeenCalled();
    await showAgentsBrowser({ ...ctx, hasUI: true }, r, { defaultMaxTurns: 20 });
    const browser = components[1] as ReadOnlyBrowser;
    expect(browser).toBeInstanceOf(ReadOnlyBrowser);
    browser.handleInput("auditor");
    browser.handleInput("\r");
    expect(browser.render(120).join("\n")).toContain("20 (extension default)");
    expect(browser.render(120).join("\n")).toContain("# Instructions");
  });
});
