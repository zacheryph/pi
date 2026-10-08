import type { Tool } from "@earendil-works/pi-ai";
import type { BuildSystemPromptOptions, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { buildPromptView, buildToolsView, redactPromptDisplay } from "../src/insights.js";

// Pi's real prompt builder is internal, not exported from the package entry.
const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { buildSystemPrompt } = await import(new URL("./core/system-prompt.js", entry).href) as {
  buildSystemPrompt(options: BuildSystemPromptOptions): string;
};

function tool(name: string, exposure: ToolInfo["exposure"] = "direct"): ToolInfo {
  return {
    name, exposure, description: `Registry ${name}`,
    parameters: Type.Object({ path: Type.String() }),
    sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" },
  };
}
const options = { cwd: "/work" };

function field(detail: string | undefined, label: string): string | undefined {
  return detail?.split("\n").find((line) => line.startsWith(`${label}:`))?.slice(label.length + 1).trim();
}

describe("buildPromptView", () => {
  it.each(["", "  exact\r\n<system>\ntext\n</system>\n", "# Markdown is plain text\n\u001b[31m", "opaque override: <tools>keep</tools>"]) (
    "preserves unrecognized text: %j", (prompt) => {
      const view = buildPromptView(prompt);
      expect(view.text).toBe(prompt);
      expect(view.items).toBeUndefined();
      expect(view.note).toContain("Redacted display");
      expect(view.note).toContain("Not verbatim");
    },
  );

  it("redacts realistic default prompt sections only, without modifying input/options", () => {
    const input: BuildSystemPromptOptions = {
      cwd: "/work", selectedTools: ["read", "bash"],
      toolSnippets: { read: "Read files", bash: "Run commands" },
      toolGuidelines: { read: ["Use read for skill files"] },
      contextFiles: [{ path: "/work/AGENTS.md", content: "Use read here.\n<tools>\nproject example\n</tools>\n<skills>\nliteral skills\n</skills>\n<tools>\nunmatched example" }],
      skills: [{ name: "demo", description: "Skill metadata", filePath: "/work/demo/SKILL.md", baseDir: "/work/demo", disableModelInvocation: false,
        sourceInfo: { path: "/work/demo/SKILL.md", source: "project", scope: "project", origin: "top-level" } }],
    };
    const snapshot = structuredClone(input);
    const prompt = buildSystemPrompt(input);
    expect(prompt).toContain("<tools>\n- read: Read files");
    expect(prompt).toContain("<skills>\n");
    const expected = prompt.replace(/<tools>\n- read:[\s\S]*?\n<\/tools>/, "--- TOOLS [redacted] ---")
      .replace(/<skills>\nThe following skills[\s\S]*?\n<\/skills>/, "--- SKILLS [redacted] ---");
    const display = buildPromptView(prompt).text;
    expect(display).toBe(expected);
    expect(display).toContain("--- SKILLS [redacted] ---");
    expect(display).toContain("Use read for skill files");
    expect(display).toContain(input.contextFiles![0].content);
    expect(display).toContain("<docs>");
    expect(display).toContain("<cwd>\n/work\n</cwd>");
    expect(input).toEqual(snapshot);
    expect(buildSystemPrompt(input)).toBe(prompt);
  });

  it.each(["tools", "skills", "available_skills"])("redacts standalone %s, including empty content", (name) => {
    const label = name === "tools" ? "TOOLS" : "SKILLS";
    for (const contents of ["secret", ""]) {
      const prompt = `<${name}>\n${contents}\n</${name}>`;
      expect(redactPromptDisplay(prompt)).toBe(`--- ${label} [redacted] ---`);
    }
  });

  it("preserves unrelated bytes, CRLF, and repeated regions in place", () => {
    const prompt = "before\r\n\r\n<tools>\r\nsecret\r\n</tools>\r\n\r\nmiddle \t\r\n\r\n<skills>\r\nsecret2\r\n</skills>\r\n\r\n<tools>\r\nsecret3\r\n</tools>\r\n\r\nafter\r\n";
    expect(redactPromptDisplay(prompt)).toBe("before\r\n\r\n--- TOOLS [redacted] ---\r\n\r\nmiddle \t\r\n\r\n--- SKILLS [redacted] ---\r\n\r\n--- TOOLS [redacted] ---\r\n\r\nafter\r\n");
  });

  it("leaves nested examples, fences, inline code, comments, and rule mentions intact", () => {
    const protectedText = [
      '<project_context>\n<project_instructions path="/work/AGENTS.md">\n<tools>\nexample\n</tools>\n<available_skills>\nlegacy example\n</available_skills>\n</project_instructions>\n</project_context>',
      '<rules>\nUse read and bash.\n<skills>\nexample\n</skills>\n</rules>',
      '<custom_context>\n<tools>\nexample\n</tools>\n</custom_context>',
      '```xml\n<tools>\nfenced\n</tools>\n```',
      '~~~\n<skills>\nfenced\n</skills>\n~~~',
      '`<tools>` and `<skills>` are example tags.',
      '    <tools>\n    indented code\n    </tools>',
      '<!--\n<tools>\ncomment\n</tools>\n-->',
    ].join("\n\n");
    expect(redactPromptDisplay(protectedText)).toBe(protectedText);
    expect(redactPromptDisplay(`${protectedText}\n\n<tools>\nreal\n</tools>\n`)).toBe(`${protectedText}\n\n--- TOOLS [redacted] ---\n`);
  });

  it.each([
    "<tools>\nunmatched\n\nkeep remainder\n<skills>\nambiguous scope\n</skills>",
    "<skills>\nwrong closer\n</tools>\n\nkeep remainder",
    "<tools>\n<tools>\nnested unmatched\n</tools>\n\nkeep remainder",
    "</tools>\nkeep remainder",
    "<tools>\ninline closing </tools>\nkeep remainder",
    "opaque override without Pi boundaries\n<tools>\nliteral\n</tools>\nrest",
  ])("preserves malformed/ambiguous regions, never swallows suffix: %j", (prompt) => {
    expect(redactPromptDisplay(prompt)).toBe(prompt);
  });

  it("preserves opaque forced override and custom-prompt examples", () => {
    const opaque = "Use <tools>read</tools> literally.\n<skills>not a section</skills>";
    expect(buildPromptView(buildSystemPrompt({ ...options, forceSystemPrompt: opaque })).text).toBe(opaque);
    const custom = buildSystemPrompt({ ...options, customPrompt: "Example:\n```xml\n<tools>\nexample\n</tools>\n```" });
    expect(buildPromptView(custom).text).toBe(custom);
  });
});

describe("buildToolsView", () => {
  it("includes reachable active tools plus inactive codemode/deferred, never hidden or inactive direct/model-only", () => {
    const tools = [tool("read"), tool("orchestrator", "model-only"), tool("script", "codemode"),
      tool("searchable", "deferred"), tool("inactive"), tool("inactive-model", "model-only"),
      tool("withdrawn", "hidden"), tool("active-script", "codemode"), tool("active-deferred", "deferred")];
    const view = buildToolsView(tools, ["read", "orchestrator", "withdrawn", "active-script", "active-deferred"], options, []);
    expect(view.items?.map((item) => item.label)).toEqual(["active-deferred", "active-script", "orchestrator", "read", "script", "searchable"]);
    expect(view.items?.find((item) => item.label === "script")?.status).toContain("inactive · indirect · callable · discoverable");
    expect(view.items?.find((item) => item.label === "orchestrator")?.detail).toContain("no (model-only)");
    expect(field(view.items?.find((item) => item.label === "searchable")?.detail, "Exposure")).toBe("deferred");
  });

  it("distinguishes hidden declarations from hidden exposure, active set from selected construction tools", () => {
    const view = buildToolsView([tool("read"), tool("write"), tool("hidden", "hidden")], ["read", "write", "hidden"], {
      ...options, selectedTools: ["write"], hiddenTools: ["read"],
    }, []);
    expect(view.items).toHaveLength(2);
    expect(view.items?.[0]?.status).toContain("active · indirect · callable");
    expect(view.items?.[0]?.detail).toContain("Active; declaration hidden (indirect)");
    expect(view.items?.[1]?.status).toContain("active · directly declared");
  });

  it("excludes model-only tools with hidden declarations: neither declared nor callable", () => {
    const view = buildToolsView([tool("orchestrator", "model-only"), tool("read")], ["orchestrator", "read"], {
      ...options, hiddenTools: ["orchestrator", "read"],
    }, []);
    expect(view.items?.map((item) => item.label)).toEqual(["read"]);
    expect(view.note).toContain("indirect access needs an orchestrator");
  });

  it("uses latest recorded description/schema once, with concise metadata and deduplicated guidelines", () => {
    const current = { ...tool("read"), promptGuidelines: ["Registry guideline", "Shared rule", "Shared rule"],
      namespace: { name: "fs", description: "Files", instructions: "Namespace guidance" },
      annotations: { readOnlyHint: true, openWorldHint: false } };
    const recorded: Tool[] = [
      { name: "read", description: "Older", parameters: Type.Object({ old: Type.String() }) },
      { name: "read", description: "Latest recorded\nSecond line", parameters: Type.Object({ recorded: Type.Number() }) },
    ];
    const item = buildToolsView([current], ["read"], { ...options, toolSnippets: { read: "Read snippet" },
      toolGuidelines: { read: ["Construction rule", "Shared rule", "  Construction rule  ", ""] } }, recorded).items![0];
    expect(item.description).toBe("Registry read");
    expect(field(item.detail, "Description")).toBe("Latest recorded");
    expect(field(item.detail, "Declaration source")).toBe("Latest recorded (historical)");
    expect(field(item.detail, "Namespace")).toBe("fs — Files");
    expect(field(item.detail, "Source")).toBe("builtin:read · temporary · builtin");
    expect(item.detail).toContain("\n                    Second line");
    expect(item.detail.split("\n")[0]).toBe("Name:               read");
    expect(item.detail).toContain("Namespace instructions:\nNamespace guidance");
    expect(item.detail).toContain("Tool snippet (construction metadata):\nRead snippet");
    expect(item.detail).toContain("Guidelines (construction metadata):\n- Registry: Registry guideline");
    expect(item.detail).toContain("- Registry + Prompt: Shared rule");
    expect(item.detail.match(/Shared rule/g)).toHaveLength(1);
    expect(item.detail.match(/Construction rule/g)).toHaveLength(1);
    expect(item.detail.match(/Input schema:/g)).toHaveLength(1);
    expect(item.detail).toContain('"recorded":');
    for (const absent of ["Registry read", '"path":', "Older", "annotations", "readOnlyHint", '"scope":', "Current registry", "Discovery:"]) expect(item.detail).not.toContain(absent);
  });

  it("uses registered fallback without duplicate schema/description, handles absent metadata", () => {
    const minimal = { name: "bare", description: "Bare\nMore detail", parameters: Type.Object({}), exposure: "direct" } as unknown as ToolInfo;
    const view = buildToolsView([minimal], ["bare"], options, []);
    const detail = view.items![0].detail;
    expect(field(detail, "Declaration source")).toBe("Registered fallback (no branch recording)");
    expect(field(detail, "Source")).toBe("(not available)");
    expect(detail).toContain("Description:        Bare\n                    More detail");
    expect(detail.match(/Input schema:/g)).toHaveLength(1);
    expect(detail).not.toContain("Namespace:");
    expect(detail).not.toContain("Tool snippet");
    expect(detail).not.toContain("Guidelines");
    expect(buildToolsView([], [], options, []).items).toEqual([]);
  });

  it("keeps input data unchanged", () => {
    const tools = [tool("z"), tool("a")];
    const snapshot = structuredClone(tools);
    buildToolsView(tools, ["a", "z"], options, []);
    expect(tools).toEqual(snapshot);
  });
});
