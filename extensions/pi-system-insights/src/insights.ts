import type { Tool } from "@earendil-works/pi-ai";
import type { BuildSystemPromptOptions, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { Block } from "#ui";
import { sourceSummary } from "#src/detail-format";
import type { InsightView } from "#src/types";

export { buildSkillsView } from "#src/skills";

/** Display-only redaction of standalone root sections, not arbitrary XML or tag mentions. */
export function redactPromptDisplay(prompt: string): string {
  const lines = [...prompt.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)].filter(
    (match) => match[0].length > 0,
  );
  const tags: { line: number; name: string; closing: boolean; plain: boolean }[] = [];
  let fence: { char: string; length: number } | undefined;
  let comment = false;
  lines.forEach((match, line) => {
    const text = match[1];
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      if (
        delimiter &&
        delimiter[1][0] === fence.char &&
        delimiter[1].length >= fence.length &&
        !delimiter[2].trim()
      )
        fence = undefined;
      return;
    }
    if (comment) {
      if (text.includes("-->")) comment = false;
      return;
    }
    if (text.includes("<!--")) {
      comment = !text.slice(text.indexOf("<!--") + 4).includes("-->");
      return;
    }
    if (delimiter) {
      fence = { char: delimiter[1][0], length: delimiter[1].length };
      return;
    }
    const tag = /^<(\/?)([a-z][a-z0-9_-]*)(?:[ \t]+[^<>]*)?>[ \t]*$/.exec(text);
    if (tag)
      tags.push({
        line,
        name: tag[2],
        closing: tag[1] === "/",
        plain: text.trimEnd() === `<${tag[1]}${tag[2]}>`,
      });
  });

  const replacements: { start: number; end: number; text: string }[] = [];
  for (let index = 0; index < tags.length; index++) {
    const open = tags[index];
    if (open.closing) continue;
    // Other root sections are opaque, particularly project_context: their
    // contents can contain literal tag examples, even without Markdown fences.
    let depth = 1;
    let closeIndex = index + 1;
    for (; closeIndex < tags.length; closeIndex++) {
      const tag = tags[closeIndex];
      if (tag.name === open.name) depth += tag.closing ? -1 : 1;
      if (depth === 0) break;
    }
    // An unmatched opening makes subsequent scope ambiguous. Preserve suffix.
    if (depth !== 0) break;
    const close = tags[closeIndex];
    const before = lines[open.line - 1];
    const after = lines[close.line + 1];
    if (
      open.plain &&
      close.plain &&
      (!before || !before[1].trim()) &&
      (!after || !after[1].trim()) &&
      ["tools", "skills", "available_skills"].includes(open.name)
    ) {
      replacements.push({
        start: lines[open.line].index!,
        end: lines[close.line].index! + lines[close.line][1].length,
        text: `--- ${open.name === "tools" ? "TOOLS" : "SKILLS"} [redacted] ---`,
      });
    }
    index = closeIndex;
  }
  let display = prompt;
  for (const replacement of replacements.reverse()) {
    display =
      display.slice(0, replacement.start) + replacement.text + display.slice(replacement.end);
  }
  return display;
}

export function buildPromptView(prompt: string): InsightView {
  return {
    title: "System prompt",
    note: "Redacted display; model prompt unchanged. Not verbatim.",
    text: redactPromptDisplay(prompt),
  };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "(not available)";
}

export function buildToolsView(
  tools: readonly ToolInfo[],
  activeNames: readonly string[],
  options: BuildSystemPromptOptions,
  recordedTools: readonly Tool[],
): InsightView {
  const active = new Set(activeNames);
  const hiddenDeclarations = new Set(options.hiddenTools ?? []);
  // Last declaration for each name wins if the caller supplies historical duplicates.
  const recorded = new Map(recordedTools.map((tool) => [tool.name, tool]));
  return {
    title: "Tools",
    note: "Recorded declarations may lag; indirect access needs an orchestrator.",
    noun: ["tool", "tools"],
    items: tools
      .filter(
        (tool) =>
          tool.exposure !== "hidden" &&
          (active.has(tool.name) || tool.exposure === "codemode" || tool.exposure === "deferred") &&
          !(tool.exposure === "model-only" && hiddenDeclarations.has(tool.name)),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((tool) => {
        const isActive = active.has(tool.name);
        const indirect = isActive && hiddenDeclarations.has(tool.name);
        const callable = tool.exposure !== "model-only";
        const declaration = isActive
          ? indirect
            ? "Active; declaration hidden (indirect)"
            : "Active; directly declared"
          : "Inactive; not directly declared";
        const historical = recorded.get(tool.name);
        const primary = historical ?? tool;
        const fields: [string, string][] = [
          ["Access", `${declaration}; callable: ${callable ? "yes" : "no (model-only)"}`],
          ["Exposure", tool.exposure],
          [
            "Declaration source",
            historical
              ? "Latest recorded (historical)"
              : "Registered fallback (no branch recording)",
          ],
        ];
        if (tool.namespace)
          fields.push([
            "Namespace",
            `${tool.namespace.name}${tool.namespace.description ? ` — ${tool.namespace.description}` : ""}`,
          ]);
        fields.push(["Source", sourceSummary(tool.sourceInfo)]);
        const detail: Block[] = [
          { fields },
          { heading: "Description" },
          { text: primary.description || "(none)" },
          { heading: "Input schema" },
          { lines: json(primary.parameters).split("\n") },
        ];
        const snippet = options.toolSnippets?.[tool.name];
        if (snippet)
          detail.push({ heading: "Tool snippet (construction metadata)" }, { text: snippet });
        const guidelines = new Map<string, Set<string>>();
        for (const [source, rules] of [
          ["Registry", tool.promptGuidelines],
          ["Prompt", options.toolGuidelines?.[tool.name]],
        ] as const) {
          for (const rule of rules ?? []) {
            const text = rule.trim();
            if (!text) continue;
            const sources = guidelines.get(text) ?? new Set<string>();
            sources.add(source);
            guidelines.set(text, sources);
          }
        }
        if (guidelines.size)
          detail.push(
            { heading: "Guidelines (construction metadata)" },
            {
              bullets: [...guidelines].map(
                ([rule, sources]) => `${[...sources].join(" + ")}: ${rule}`,
              ),
            },
          );
        if (tool.namespace?.instructions)
          detail.push({ heading: "Namespace instructions" }, { text: tool.namespace.instructions });
        return {
          id: tool.name,
          label: tool.name,
          status: `${isActive ? (indirect ? "active · indirect" : "active · directly declared") : "inactive · indirect"} · ${callable ? "callable" : "model-only"}${tool.exposure === "codemode" || tool.exposure === "deferred" ? " · discoverable" : ""}`,
          description: tool.description,
          detail,
        };
      }),
  };
}
