import type { Skill, ToolInfo } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { buildPromptView, buildSkillsView, buildToolsView } from "#src/insights";
import { SKILL_READ_ENTRY } from "#src/skills";
import type { InsightView } from "#src/types";
import { InsightViewer, sanitizeInsightText } from "#src/viewer";

const source = { path: "/work/demo/SKILL.md", source: "local", scope: "project", origin: "top-level" } as const;
const skill: Skill = { name: "demo", description: "SECRET_DESCRIPTION for skill", filePath: source.path,
  baseDir: "/work/demo", sourceInfo: source, disableModelInvocation: false };
const palette: Record<string, number> = { success: 32, dim: 90, accent: 36, border: 37, muted: 37 };
function viewer(view: InsightView) {
  return new InsightViewer({
    tui: { mode: "fullscreen", terminal: { rows: 40, columns: 100 }, requestRender() {} },
    theme: { fg: (token, text) => `\x1b[${palette[token] ?? 37}m${text}\x1b[0m`, bold: text => text },
    keys: new KeybindingsManager(TUI_KEYBINDINGS), view, done() {},
  });
}
const output = (component: InsightViewer) => component.render(80).map(sanitizeInsightText).join("\n");

describe("production snapshots through viewer", () => {
  it("renders exactly one pair of badge brackets, same fresh color in list/detail and real footer legend", () => {
    const session = SessionManager.inMemory("/work");
    session.appendCustomEntry(SKILL_READ_ENTRY, { path: source.path, partial: false });
    const component = viewer(buildSkillsView([skill], session.getBranch(), "/work"));
    const list = component.render(80);
    const name = list.find(line => sanitizeInsightText(line).includes("Name:"))!;
    expect(name).toContain("\x1b[32m[loaded]\x1b[0m");
    expect(sanitizeInsightText(name)).toMatch(/Name: demo +\[loaded\] │ $/);
    expect(output(component)).not.toContain("[[loaded]]");
    expect(output(component)).not.toContain(skill.description);
    expect(output(component)).toContain("[loaded]=fresh observation");
    expect(output(component)).toContain("[loaded]=unobserved/dirty");
    component.handleInput("\r");
    const detailName = component.render(80).find(line => sanitizeInsightText(line).includes("Name:"))!;
    expect(detailName).toContain("\x1b[32m[loaded]\x1b[0m");
    expect(output(component)).toContain(skill.description);
    expect(output(component)).toContain("Esc to go back");
    expect(output(component)).not.toContain('"source":');
  });

  it("renders actual compact tool detail with a single schema, no index description or metadata JSON", () => {
    const tool: ToolInfo = { name: "read", description: "SECRET_DESCRIPTION for tool", exposure: "direct",
      parameters: { type: "object", properties: { path: { type: "string" } } }, sourceInfo: source };
    const component = viewer(buildToolsView([tool], ["read"], { cwd: "/work" }, []));
    expect(output(component)).not.toContain(tool.description);
    component.handleInput("\r");
    const detail = output(component);
    expect(detail).toContain(tool.description);
    expect(detail).toContain("Input schema:");
    expect(detail.match(/"type": "object"/g)).toHaveLength(1);
    expect(detail).not.toContain('"scope":');
    expect(detail).not.toContain("Registry annotations");
  });

  it("renders catalog markers instead of prompt sections while retaining unrelated rules", () => {
    const original = "Preamble\n\n<tools>\nSECRET_TOOL\n</tools>\n\n<rules>\nKeep rule\n</rules>\n\n<skills>\nSECRET_SKILL\n</skills>";
    const component = viewer(buildPromptView(original));
    const rendered = output(component);
    expect(rendered).toContain("--- TOOLS [redacted] ---");
    expect(rendered).toContain("--- SKILLS [redacted] ---");
    expect(rendered).toContain("Keep rule");
    expect(rendered).not.toContain("SECRET_");
    expect(original).toContain("SECRET_SKILL");
  });
});
