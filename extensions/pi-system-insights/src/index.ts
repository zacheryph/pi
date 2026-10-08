import { getCurrentTools } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildPromptView, buildSkillsView, buildToolsView } from "#src/insights";
import { normalizeSkillPath, SKILL_READ_ENTRY, skillReadEvidence } from "#src/skills";
import type { InsightView } from "#src/types";
import { showInsightView } from "#src/viewer";

/** Commands inspect snapshots only. No request hooks, tool activation, or skill-file reads. */
export default function systemInsights(pi: ExtensionAPI): void {
  const command = (
    name: string,
    description: string,
    snapshot: (ctx: ExtensionCommandContext) => InsightView,
  ) => {
    pi.registerCommand(name, {
      description,
      handler: async (_args, ctx) => {
        if (ctx.mode !== "tui" || !ctx.hasUI) {
          ctx.ui.notify("System insights requires interactive terminal mode.", "warning");
          return;
        }
        await showInsightView(ctx, snapshot(ctx));
      },
    });
  };

  command("system:prompt", "Inspect the current Pi system prompt", ctx =>
    buildPromptView(ctx.getSystemPrompt()));

  command("system:tools", "Inspect accessible tools and their declarations", ctx =>
    buildToolsView(
      pi.getAllTools(),
      pi.getActiveTools(),
      ctx.getSystemPromptOptions(),
      getCurrentTools(ctx.sessionManager.buildSessionProjection().messages),
    ));

  command("system:skills", "Inspect skills and branch-observed loading", ctx =>
    buildSkillsView(ctx.getSystemPromptOptions().skills ?? [], ctx.sessionManager.getBranch(), ctx.cwd));

  // Direct reads and /skill expansions already live in branch history. Nested
  // tool results are not persisted; save only path/partial evidence for skill
  // reads so reload and bounded nested-call records do not lose observed loading.
  // Custom entries never enter model context. Never store instruction contents.
  pi.on("tool_result", (event, ctx) => {
    if (!event.parentToolCallId) return;
    const evidence = skillReadEvidence(event, ctx.cwd);
    if (!evidence) return;
    const discovered = pi.getCommands().some(command =>
      command.source === "skill"
      && normalizeSkillPath(command.sourceInfo.path, ctx.cwd) === evidence.path);
    if (discovered) pi.appendEntry(SKILL_READ_ENTRY, evidence);
  });
}
