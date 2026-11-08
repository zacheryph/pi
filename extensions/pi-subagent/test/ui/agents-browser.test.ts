import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi, onTestFinished } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { loadCustomAgents } from "#src/config/custom-agents";
import { BUILTIN_AGENTS_DIR } from "#src/config/default-agents";
import type { AgentConfig } from "#src/types";
import {
  buildAgentsView,
  showAgentsBrowser,
  type AgentsBrowserOptions,
} from "#src/ui/agents-browser";
import { Explorer, renderBlocks, type Block } from "../../../../packages/pi-ui/src/index.ts";
import { plainTheme } from "../../../../packages/pi-test-helpers/src/theme.ts";
import { tempDir } from "../../../../packages/pi-test-helpers/src/temp.ts";
import { fakeCustomUi, fakeTui } from "../../../../packages/pi-test-helpers/src/ui.ts";

const identity = plainTheme;
const plainDetail = (blocks: unknown) => renderBlocks(blocks as Block[], 1000, identity).join("\n");

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "auditor",
    displayName: "Auditor",
    description: "First line\nSecond line",
    systemPrompt: "# Instructions\n  Keep indentation.\n\n**Literal Markdown**\nLast instruction.",
    promptMode: "append",
    ...overrides,
  };
}
const registry = (config = agent()) =>
  new AgentTypeRegistry(() => new Map([[config.name, config]]));
const detail = (config = agent(), defaults = {}, options: AgentsBrowserOptions = {}) =>
  plainDetail(
    buildAgentsView(registry(config), defaults, options).items.find(
      (item) => item.id === config.name,
    )!.detail,
  );
const field = (text: string, label: string) => new RegExp(`^${label} +(.+)$`, "m").exec(text)?.[1];

describe("effective agent definitions", () => {
  it("sorts built-in and custom agents alphabetically, ignoring case, without changing registry order", () => {
    const configs = [
      agent({ name: "zebra" }),
      agent({ name: "Alpha", visibility: "disabled" }),
      agent({ name: "beta" }),
    ];
    const r = new AgentTypeRegistry(() => new Map(configs.map((config) => [config.name, config])));
    const names = r.getAllTypes();
    const originalOrder = [...names];
    vi.spyOn(r, "getAllTypes").mockReturnValue(names);

    expect(buildAgentsView(r).items.map((item) => item.label)).toEqual([
      "Alpha",
      "beta",
      "explore",
      "general-purpose",
      "orchestrate",
      "plan",
      "review",
      "zebra",
    ]);
    expect(names).toEqual(originalOrder);
  });

  it("marks an agent whose file does not parse and shows the error before its description", () => {
    const config = agent({ definitionError: "invalid frontmatter in /p/auditor.md: bad" });
    const item = buildAgentsView(registry(config)).items.find((i) => i.id === "auditor")!;
    expect(item.badge).toEqual({ text: "[invalid]", tone: "error" });
    const lines = plainDetail(item.detail).split("\n");
    const heading = lines.indexOf("Definition error");
    expect(lines[heading + 1]).toBe("invalid frontmatter in /p/auditor.md: bad");
    expect(heading).toBeLessThan(lines.indexOf("Description"));
  });

  it("lists defaults and disabled overrides without description rows", () => {
    const r = registry(
      agent({ name: "explore", visibility: "disabled", source: "project", toolNames: [] }),
    );
    const view = buildAgentsView(r);
    expect(view.items.map((item) => item.label)).toEqual([
      "explore",
      "general-purpose",
      "orchestrate",
      "plan",
      "review",
    ]);
    expect(view.items.find((item) => item.label === "explore")).toMatchObject({
      badge: { text: "[disabled]", tone: "dim" },
      search: "disabled First line\nSecond line",
    });
    expect(view.items.find((item) => item.id === "general-purpose")!.badge).toEqual({
      text: "[visible]",
      tone: "success",
    });
    const config = plainDetail(view.items.find((item) => item.label === "explore")!.detail);
    expect(field(config, "Visibility")).toBe("disabled");
    expect(field(config, "Source")).toBe("project");
    expect(field(config, "Tools")).toBe("(none)");
    expect(r.isValidType("explore")).toBe(false);
  });

  it("orders Name, effective fields, Description, then full-width Body on following line", () => {
    const config = agent({
      source: "project",
      sourcePath: "/project/.pi/agents/auditor.md",
      toolNames: ["read", "mcp__github__*"],
      model: "provider/model",
      thinking: "high",
      maxTurns: 30,
      inheritContext: true,
      locked: ["model", "thinking"],
      guidance: "Pick auditor for reviews.",
    });
    const text = detail(config);
    expect(text.split("\n")[0]).toMatch(/^Name +auditor$/);
    expect(field(text, "Display name")).toBe("Auditor");
    expect(field(text, "Source path")).toBe(config.sourcePath);
    expect(field(text, "Tools")).toBe("read, mcp__github__*");
    expect(field(text, "Delegate")).toBe("no");
    expect(field(text, "Model")).toBe("provider/model");
    expect(field(text, "Thinking")).toBe("high");
    expect(field(text, "Max turns")).toBe("30");
    expect(field(text, "Prompt mode")).toBe("append");
    expect(field(text, "Inherit context")).toBe("true");
    expect(field(text, "Locked")).toBe("model, thinking");
    const lines = text.split("\n");
    expect(lines[lines.indexOf("Guidance") + 1]).toBe(config.guidance);
    const description = lines.indexOf("Description");
    const heading = lines.indexOf("Body");
    expect(description).toBeGreaterThan(lines.findIndex((line) => line.startsWith("Locked ")));
    expect(lines.slice(description + 1, description + 3)).toEqual(["First line", "Second line"]);
    expect(heading).toBeGreaterThan(description);
    expect(lines.slice(heading + 1).join("\n")).toBe(config.systemPrompt);
    expect(lines[heading + 1]).toBe("# Instructions");
    expect(text).not.toMatch(/^Body: +\S/m);
  });

  it("shows inherited/default fields honestly, normalized limits and empty Body", () => {
    const text = detail(agent({ systemPrompt: "", displayName: undefined }));
    expect(field(text, "Display name")).toBe("auditor");
    expect(field(text, "Tools")).toBe("all");
    expect(field(text, "Model")).toBe("(inherit parent)");
    expect(field(text, "Thinking")).toBe("(inherit parent)");
    expect(field(text, "Max turns")).toBe("unlimited");
    expect(field(text, "Inherit context")).toBe("false (tool default; caller decides)");
    expect(field(text, "Locked")).toBe("(none)");
    expect(field(text, "Source path")).toBe("(not available)");
    expect(text.endsWith("\n\nBody\n(empty)")).toBe(true);
    expect(field(detail(agent({ maxTurns: 1 })), "Max turns")).toBe("2 (configured: 1)");
    expect(field(detail(agent({ maxTurns: 0 }), { defaultMaxTurns: 20 }), "Max turns")).toBe(
      "unlimited (configured: 0)",
    );
    expect(field(detail(agent(), { defaultMaxTurns: 1 }), "Max turns")).toBe(
      "2 (configured: 1) (extension default)",
    );
    const embedded = plainDetail(
      buildAgentsView(registry()).items.find((item) => item.id === "general-purpose")!.detail,
    );
    expect(field(embedded, "Source")).toBe("built-in");
    expect(field(embedded, "Source path")).toBe(join(BUILTIN_AGENTS_DIR, "general-purpose.md"));
  });

  it("whole-file locks only claim declared fields, explicit lists also lock absent fields", () => {
    expect(
      field(
        detail(agent({ locked: true, model: "m", inheritContext: false, maxTurns: 0 })),
        "Locked",
      ),
    ).toBe("true (declared fields: model, max_turns, inherit_context)");
    expect(field(detail(agent({ locked: true })), "Locked")).toBe("true (declared fields: none)");
    expect(field(detail(agent({ locked: ["thinking"] })), "Locked")).toBe("thinking");
  });

  it("snapshots plain strings; registry mutations cannot change an open view", () => {
    const config = agent({ toolNames: ["read"], locked: ["model"] });
    const r = registry(config);
    const view = buildAgentsView(r);
    config.toolNames!.push("write");
    config.systemPrompt = "changed";
    config.visibility = "disabled";
    config.description = "changed";
    const item = view.items.find((item) => item.id === config.name)!;
    expect(plainDetail(item.detail)).not.toContain("changed");
    expect(field(plainDetail(item.detail), "Tools")).toBe("read");
    expect(item.badge!.text).toBe("[visible]");
  });

  it("preserves body whitespace/literal Markdown, strips unsafe terminal text before alignment", () => {
    const text = detail(
      agent({
        description: "Review\x1b]52;c;bad\x07\nContinue",
        model: "ok\x1b[2J",
        sourcePath: "/safe\u202efile",
        systemPrompt: "  instruction\n\n```text\n\tKeep literal.\n```\x1b]0;unfinished",
      }),
    );
    // oxlint-disable-next-line no-control-regex -- Intentionally matches terminal control characters.
    expect(text).not.toMatch(/[\x1b\x07\u202e]/);
    expect(field(text, "Model")).toBe("ok");
    expect(field(text, "Source path")).toBe("/safefile");
    expect(text.endsWith("\nBody\n  instruction\n\n```text\n    Keep literal.\n```")).toBe(true);
  });

  it("shows raw Body, ordered source-local provenance and composed instructions without mutating config", () => {
    const config = agent({
      source: "global",
      sourcePath: "/global/agents/auditor.md",
      fragments: ["aws", "audit", "aws"],
      systemPrompt: "RAW BODY",
    });
    const readFile = vi.fn((path: string) =>
      path.endsWith("aws.md") ? "AWS\x1b[31m" : "AUDIT\x1b]52;c;payload\x07",
    );
    const text = detail(config, {}, { readFile });
    expect(text).toContain(
      "\nBody\nRAW BODY\n\nFragments\n1. aws\n   /global/agents/fragments/aws.md\n2. audit\n   /global/agents/fragments/audit.md",
    );
    expect(text).toContain("\nComposed instructions\nAWS\n\n---\n\nAUDIT\n\n---\n\nRAW BODY");
    // oxlint-disable-next-line no-control-regex -- Intentionally matches terminal control characters.
    expect(text).not.toMatch(/[\x1b\x07]/);
    expect(readFile.mock.calls.map(([path]) => path)).toEqual([
      "/global/agents/fragments/aws.md",
      "/global/agents/fragments/audit.md",
    ]);
    expect(config.systemPrompt).toBe("RAW BODY");
    expect(config.fragments).toEqual(["aws", "audit", "aws"]);
  });

  it("keeps provenance and Body when missing fragment blocks composition; sanitizes error", () => {
    const readFile = vi.fn(() => {
      throw new Error("ENOENT\x1b]0;fake title\x07");
    });
    const text = detail(
      agent({
        fragments: ["missing"],
        sourcePath: "/project/.pi/agents/auditor.md",
        systemPrompt: "RAW BODY",
      }),
      {},
      { readFile },
    );
    expect(text).toContain("\nBody\nRAW BODY");
    expect(text).toContain("1. missing\n   /project/.pi/agents/fragments/missing.md");
    expect(text).toContain("Composed instructions\nError:");
    expect(text).toContain("ENOENT");
    // oxlint-disable-next-line no-control-regex -- Intentionally matches terminal control characters.
    expect(text).not.toMatch(/[\x1b\x07]/);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it.each([false, undefined])(
    "blocks untrusted project preview without fragment IO (%s)",
    (projectTrusted) => {
      const readFile = vi.fn(() => "SECRET");
      const config = agent({
        source: "project",
        sourcePath: "/project/.pi/agents/auditor.md",
        fragments: ["aws"],
        systemPrompt: "RAW BODY",
      });
      const text = detail(config, {}, { projectTrusted, readFile });
      expect(text).toContain("\nBody\nRAW BODY");
      expect(text).toContain("1. aws\n   /project/.pi/agents/fragments/aws.md");
      expect(text).toContain("Composed instructions\nError:");
      expect(text).toContain("require Pi project trust");
      expect(text).not.toContain("SECRET");
      expect(readFile).not.toHaveBeenCalled();
      expect(detail(config, {}, { projectTrusted: true, readFile })).toContain(
        "SECRET\n\n---\n\nRAW BODY",
      );
    },
  );

  it("shows invalid declarations/errors without fragment IO and leaves no-fragment view unchanged", () => {
    const readFile = vi.fn(() => "UNEXPECTED");
    for (const overrides of [
      { fragmentError: "Invalid fragment declaration" },
      { fragments: ["../aws"] },
    ]) {
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
    const item = plainDetail(view.items.find((item) => item.id === config.name)!.detail);
    expect(item).toContain("ORIGINAL");
    expect(item).not.toContain("EDITED");
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("loader captures winning path; new registry reflects edits and cwd without mutating old registry", () => {
    const root = tempDir(onTestFinished, "pi-agents-browser-");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "global");
    const project = join(root, "project");
    try {
      const globalDir = join(root, "global", "agents");
      const projectDir = join(project, ".pi", "agents");
      mkdirSync(globalDir, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(globalDir, "explore.md"), "Global body");
      const path = join(projectDir, "explore.md");
      writeFileSync(path, "---\nvisibility: disabled\n---\nProject body");
      const old = new AgentTypeRegistry(() => loadCustomAgents(project));
      const view = buildAgentsView(old);
      const item = plainDetail(view.items.find((item) => item.id === "explore")!.detail);
      expect(field(item, "Source path")).toBe(path);
      expect(field(item, "Source")).toBe("project");
      expect(item.endsWith("\nBody\nProject body")).toBe(true);
      writeFileSync(path, "New project body");
      const fresh = new AgentTypeRegistry(() => loadCustomAgents(project));
      expect(
        plainDetail(
          buildAgentsView(fresh).items.find((item) => item.id === "explore")!.detail,
        ).endsWith("\nBody\nNew project body"),
      ).toBe(true);
      expect(old.resolveAgentConfig("explore").visibility).toBe("disabled");
      const global = new AgentTypeRegistry(() => loadCustomAgents(root));
      expect(
        field(
          plainDetail(buildAgentsView(global).items.find((item) => item.id === "explore")!.detail),
          "Source path",
        ),
      ).toBe(join(globalDir, "explore.md"));
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

describe("showAgentsBrowser", () => {
  it.each(["rpc", "json", "print"] as const)("guards %s before reading registry", async (mode) => {
    const r = registry();
    const read = vi.spyOn(r, "getAllTypes");
    const ui = { notify: vi.fn(), custom: vi.fn() };
    await showAgentsBrowser({ mode, hasUI: true, ui: ui as unknown as ExtensionContext["ui"] }, r);
    expect(read).not.toHaveBeenCalled();
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(
      "Agent definitions browser requires TUI mode.",
      "warning",
    );
  });

  it.each([false, true])(
    "uses live project trust for composed browser preview (%s)",
    async (trusted) => {
      const root = tempDir(onTestFinished, "pi-browser-trust-");
      mkdirSync(join(root, "fragments"));
      writeFileSync(join(root, "fragments", "aws.md"), "TRUSTED FRAGMENT CONTENT");
      const r = registry(
        agent({
          source: "project",
          sourcePath: join(root, "auditor.md"),
          fragments: ["aws"],
          systemPrompt: "RAW BODY",
        }),
      );
      const mounted = fakeCustomUi<Explorer>({ tui: { ...fakeTui(100, 160), mode: "regular" } });
      const { components } = mounted;
      const ui = { notify: vi.fn(), custom: mounted.custom };
      const isProjectTrusted = vi.fn(() => trusted);
      await showAgentsBrowser(
        {
          mode: "tui",
          hasUI: true,
          ui: ui as unknown as ExtensionContext["ui"],
          isProjectTrusted,
        },
        r,
      );
      const browser = components[0]!;
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
    },
  );

  it("handles no UI and passes effective snapshot to actual browser factory", async () => {
    const r = registry();
    const mounted = fakeCustomUi<Explorer>({ tui: { ...fakeTui(100, 120), mode: "regular" } });
    const { components } = mounted;
    const ui = { notify: vi.fn(), custom: mounted.custom };
    const ctx = { mode: "tui" as const, hasUI: false, ui: ui as unknown as ExtensionContext["ui"] };
    await showAgentsBrowser(ctx, r);
    expect(ui.custom).not.toHaveBeenCalled();
    await showAgentsBrowser({ ...ctx, hasUI: true }, r, { defaultMaxTurns: 20 });
    expect(ui.custom).toHaveBeenCalledOnce();
    expect(ui.custom.mock.calls[0][1]).toMatchObject({ overlay: true });
    const browser = components[0]!;
    browser.handleInput("auditor");
    browser.handleInput("\r");
    expect(browser.render(120).join("\n")).toContain("20 (extension default)");
    expect(browser.render(120).join("\n")).toContain("# Instructions");
  });
});
