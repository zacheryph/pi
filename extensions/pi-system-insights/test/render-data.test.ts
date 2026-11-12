import type { Skill, ToolInfo } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { DetailView, Explorer, sanitizeText, type DisposableComponent } from "#ui";
import { buildPromptView, buildSkillsView, buildToolsView } from "#src/insights";
import { SKILL_READ_ENTRY } from "#src/skills";
import type { InsightView } from "#src/types";
import { insightTitle, toExplorerView } from "#src/viewer";

const source = {
  path: "/work/demo/SKILL.md",
  source: "local",
  scope: "project",
  origin: "top-level",
} as const;
const skill: Skill = {
  name: "demo",
  description: "SECRET_DESCRIPTION for skill",
  filePath: source.path,
  baseDir: "/work/demo",
  sourceInfo: source,
  disableModelInvocation: false,
};
const palette: Record<string, number> = { success: 32, dim: 90, accent: 36, border: 37, muted: 37 };
const base = {
  tui: { terminal: { rows: 40, columns: 100 }, requestRender() {} },
  theme: {
    fg: (token: string, text: string) => `\x1b[${palette[token] ?? 37}m${text}\x1b[0m`,
    bold: (text: string) => text,
  },
  keys: new KeybindingsManager(TUI_KEYBINDINGS),
  done() {},
};
const explorer = (view: InsightView) => new Explorer({ ...base, view: toExplorerView(view) });
const output = (component: DisposableComponent) =>
  component.render(80).map(sanitizeText).join("\n");

describe("production snapshots through the shared views", () => {
  it("renders one pair of badge brackets, the same fresh color in list/detail and a legend notice", () => {
    const session = SessionManager.inMemory("/work");
    session.appendCustomEntry(SKILL_READ_ENTRY, { path: source.path, partial: false });
    const component = explorer(buildSkillsView([skill], session.getBranch(), "/work"));
    const row = component.render(80).find((line) => sanitizeText(line).includes("→ demo"))!;
    expect(row).toContain("\x1b[32m[loaded]\x1b[0m");
    expect(output(component)).not.toContain("[[loaded]]");
    expect(output(component)).not.toContain(skill.description);
    expect(output(component)).toContain("[loaded]=fresh observation");
    expect(output(component)).toContain("[loaded]=unobserved/dirty");
    component.handleInput("\r");
    const header = component.render(80).find((line) => /demo +\[loaded\]/.test(sanitizeText(line)));
    expect(header).toContain("\x1b[32m[loaded]\x1b[0m");
    expect(output(component)).toContain(skill.description);
    expect(output(component)).toContain("Esc back");
    expect(output(component)).not.toContain('"source":');
  });

  it("renders compact tool detail with a single schema, no index description or metadata JSON", () => {
    const tool: ToolInfo = {
      name: "read",
      description: "SECRET_DESCRIPTION for tool",
      exposure: "direct",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      sourceInfo: source,
    };
    const component = explorer(buildToolsView([tool], ["read"], { cwd: "/work" }, []));
    expect(output(component)).not.toContain(tool.description);
    expect(output(component)).toContain("active · directly declared · callable");
    component.handleInput("\r");
    const detail = output(component);
    expect(detail).toContain(tool.description);
    expect(detail).toContain("Input schema");
    expect(detail.match(/"type": "object"/g)).toHaveLength(1);
    expect(detail).not.toContain('"scope":');
    expect(detail).not.toContain("Registry annotations");
  });

  it("renders catalog markers instead of prompt sections while retaining unrelated rules", () => {
    const original =
      "Preamble\n\n<tools>\nSECRET_TOOL\n</tools>\n\n<rules>\nKeep rule\n</rules>\n\n<skills>\nSECRET_SKILL\n</skills>";
    const view = buildPromptView(original);
    const component = new DetailView({
      ...base,
      title: insightTitle(view.title),
      content: view.text!,
    });
    const rendered = output(component);
    expect(rendered).toContain("--- TOOLS [redacted] ---");
    expect(rendered).toContain("--- SKILLS [redacted] ---");
    expect(rendered).toContain("Keep rule");
    expect(rendered).not.toContain("SECRET_");
    expect(original).toContain("SECRET_SKILL");
  });
});
