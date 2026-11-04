import type {
  AgentToolResult,
  ExtensionContext,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { resolveSpawnCwd } from "#src/lifecycle/spawn-cwd";
import type {
  AgentSpawnConfig,
  ResumeCallOptions,
  ResumeOutcome,
  ResumeRefusalReason,
  ResumeStart,
} from "#src/lifecycle/subagent-manager";
import {
  renderOutcomeAddenda,
  renderOutcomeBody,
  renderStatusNote,
} from "#src/observation/outcome-delivery";
import { renderBackgroundLaunch, spawnBackground } from "#src/tools/background-spawner";
import { runForeground } from "#src/tools/foreground-runner";
import {
  buildAgentGuidelines,
  buildDetails,
  buildTypeListText,
  textResult,
} from "#src/tools/helpers";
import { renderAgentResult } from "#src/tools/result-renderer";
import {
  type ModelInfo,
  type ResolvedSpawnConfig,
  resolveSpawnConfig,
  type SpawnPresentation,
} from "#src/tools/spawn-config";
import type { ParentSessionInfo, Subagent } from "#src/types";
import { type AgentDetails, getDisplayName, type Theme } from "#src/ui/display";
import { ICONS } from "../../../../packages/pi-ui/src/index.ts";

// ---- Deps interfaces ----

/** Narrow manager interface — only the methods the Agent tool calls. */
export interface AgentToolManager {
  spawn: (snapshot: ParentSnapshot, type: string, prompt: string, opts: AgentSpawnConfig) => string;
  spawnAndWait: (
    snapshot: ParentSnapshot,
    type: string,
    prompt: string,
    opts: Omit<AgentSpawnConfig, "background">,
  ) => Promise<Subagent>;
  resume: (id: string, prompt: string, options: ResumeCallOptions) => Promise<ResumeOutcome>;
  startResume: (id: string, prompt: string, options: ResumeCallOptions) => ResumeStart;
  getRecord: (id: string) => Subagent | undefined;
}

/** Narrow runtime interface — the Agent tool's slice of SubagentRuntime. */
export interface AgentToolRuntime {
  buildSnapshot(inheritContext: boolean): ParentSnapshot;
  getModelInfo(): ModelInfo;
  getSessionInfo(): { parentSessionFile: string; parentSessionId: string };
}

/** Narrow settings accessor — only the fields the Agent tool reads. */
export type AgentToolSettings = {
  readonly defaultMaxTurns: number | undefined;
  readonly maxConcurrent: number;
};

// ---- Class ----

export class AgentTool {
  private readonly typeListText: string;
  private readonly availableTypesText: string;
  private readonly agentGuidelines: string[];

  constructor(
    private readonly manager: AgentToolManager,
    private readonly runtime: AgentToolRuntime,
    private readonly settings: AgentToolSettings,
    private readonly registry: AgentTypeRegistry,
    private readonly agentDir: string,
  ) {
    this.typeListText = buildTypeListText(registry, agentDir);
    this.availableTypesText = registry.getAvailableTypes().join(", ");
    this.agentGuidelines = buildAgentGuidelines(registry);
  }

  async execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: AgentToolResult<AgentDetails>) => void) | undefined,
    ctx: ExtensionContext,
  ) {
    // Reload custom agents so new .pi/agents/*.md files are picked up without restart
    this.registry.reload();

    // Agents run in the background unless something asks for the foreground. A
    // one-shot run mode cannot be woken after its turn ends, so there the
    // foreground is the default instead (local change).
    const defaultForeground = isOneShotMode(ctx);

    // ---- Config resolution (pure) ----
    const resolved = resolveSpawnConfig(
      params,
      this.registry,
      this.runtime.getModelInfo(),
      this.settings,
      { foreground: defaultForeground },
    );
    if ("error" in resolved) return textResult(resolved.error);

    // ---- Boundary extraction (after config so inheritContext is resolved) ----
    const snapshot = this.runtime.buildSnapshot(resolved.execution.inheritContext);

    // ---- Caller-chosen cwd (local change), relative to the parent's cwd ----
    if (params.resume && params.cwd != null) {
      return textResult(
        "cwd applies only to a new agent; a resumed agent keeps the directory it started in.",
      );
    }
    const cwd = resolveSpawnCwd(params.cwd, snapshot.cwd);
    if ("error" in cwd) return textResult(cwd.error);
    const config: ResolvedSpawnConfig = cwd.cwd
      ? { ...resolved, execution: { ...resolved.execution, cwd: cwd.cwd } }
      : resolved;
    const { parentSessionFile, parentSessionId } = this.runtime.getSessionInfo();
    const parentSession: ParentSessionInfo = { parentSessionFile, parentSessionId, toolCallId };

    // ---- Resume existing agent ----
    if (params.resume) {
      const id = params.resume as string;
      const prompt = params.prompt as string;
      // Only the caller's explicit flag: an agent file's foreground default
      // describes how that type spawns, not how a resume is collected.
      const foreground =
        typeof params.foreground === "boolean" ? params.foreground : defaultForeground;
      if (foreground) {
        return this.resumeExisting(id, prompt, signal, config.presentation.detailBase);
      }
      return this.resumeInBackground(id, prompt, config);
    }

    // ---- Background execution ----
    if (config.execution.runInBackground) {
      return spawnBackground(this.manager, {
        config,
        snapshot,
        parentSession,
        settings: this.settings,
      });
    }

    // ---- Foreground execution — stream progress via onUpdate ----
    return runForeground(this.manager, { config, snapshot, parentSession }, signal, onUpdate);
  }

  /**
   * Continue an existing agent's session with a new prompt, returning its
   * resumed outcome directly to the parent.
   */
  private async resumeExisting(
    id: string,
    prompt: string,
    signal: AbortSignal | undefined,
    detailBase: SpawnPresentation["detailBase"],
  ) {
    // The manager owns whether a resume happens; this door owns only how the
    // answer is worded. Resuming commits this call to delivering the outcome,
    // so it claims it — nothing else announces what is already being returned.
    const outcome = await this.manager.resume(id, prompt, {
      signal: signal ?? new AbortController().signal,
      claimOutcome: true,
    });
    if (outcome.kind === "refused") {
      return textResult(resumeRefusalMessage(outcome.reason, id));
    }
    const record = outcome.record;
    // Resume-return delivery edge: the resumed outcome is returned directly.
    record.markConsumed();
    return textResult(
      `Agent ID: ${record.id}${renderStatusNote(record)}\n\n` +
        renderOutcomeBody(record) +
        renderOutcomeAddenda(record),
      buildDetails(detailBase, record),
    );
  }

  /**
   * Start an existing agent's resume and return at once; the completion notice
   * delivers its outcome. Nothing claims the outcome and no tool-call signal is
   * wired, as for a background spawn.
   */
  private resumeInBackground(id: string, prompt: string, config: ResolvedSpawnConfig) {
    const start = this.manager.startResume(id, prompt, {});
    if (start.kind === "refused") {
      return textResult(resumeRefusalMessage(start.reason, id));
    }
    return renderBackgroundLaunch({
      headline: "Agent resumed in background.",
      id: start.record.id,
      displayName: config.identity.displayName,
      description: config.execution.description,
      detailBase: config.presentation.detailBase,
      outputFile: start.record.outputFile,
    });
  }

  toToolDefinition() {
    const typeListText = this.typeListText;
    const availableTypesText = this.availableTypesText;
    const agentDir = this.agentDir;
    const registry = this.registry;

    const guidelines = [
      "- Agents run in the background: the call returns an agent ID at once, and a completion notification arrives when the agent finishes. Start every independent agent, then end your turn instead of waiting; the notification wakes you, and the user can talk to you in the meantime.",
      "- Set foreground: true only when you cannot take your next step without the result. A foreground call blocks you, and the user, until the agent finishes; foreground calls run one at a time.",
      ...this.agentGuidelines,
      "- Provide clear, detailed prompts so the agent can work autonomously.",
      "- Subagent results are returned as text — summarize them for the user.",
      "- Use resume with an agent ID to continue a previous agent's work, or to answer an agent that ended its turn with a question.",
      "- Use subagent_steer to send mid-run messages to a running background agent.",
      '- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").',
      "- Use thinking to control extended thinking level.",
      "- Use inherit_context if the agent needs the parent conversation history.",
      "- Use cwd to run the agent in another existing directory, such as a git worktree you created for it. You own that directory: it is not removed when the agent finishes, and the agent can be resumed there.",
    ].join("\n");

    return defineTool({
      name: "subagent_start" as const,
      label: "Subagent",
      promptSnippet: "Launch a specialized agent for complex, multi-step tasks.",
      description: `Launch a new agent to handle complex, multi-step tasks autonomously.

The subagent_start tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types:
${typeListText}

Guidelines:
${guidelines}
`,
      parameters: Type.Object({
        prompt: Type.String({
          description: "The task for the agent to perform.",
        }),
        description: Type.String({
          description: "A short (3-5 word) description of the task (shown in UI).",
        }),
        subagent_type: Type.String({
          description: `The type of specialized agent to use. Available types: ${availableTypesText}. Custom agents from .pi/agents/<name>.md (project) or ${agentDir}/agents/<name>.md (global) are also available.`,
        }),
        model: Type.Optional(
          Type.String({
            description:
              'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default. An agent that locks this field keeps its own model and says so in the result.',
          }),
        ),
        thinking: Type.Optional(
          Type.String({
            description:
              "Thinking level: off, minimal, low, medium, high, xhigh, max. Overrides the agent's default unless the agent locks this field.",
          }),
        ),
        max_turns: Type.Optional(
          Type.Number({
            description:
              "Maximum number of agentic turns before stopping. Omit to use the agent's own limit, or unlimited when it declares none.",
            minimum: 1,
          }),
        ),
        foreground: Type.Optional(
          Type.Boolean({
            description:
              "Set to true to wait for the agent and get its result in this call, blocking you until it finishes. Omit to run in the background: the call returns the agent ID at once and you are notified when it completes (unless the agent's own file says foreground).",
          }),
        ),
        resume: Type.Optional(
          Type.String({
            description:
              "Optional agent ID to resume from. Continues from previous context in the background; you are notified when it finishes. Combine with foreground: true to wait for the resumed result.",
          }),
        ),
        inherit_context: Type.Optional(
          Type.Boolean({
            description:
              "If true, fork parent conversation into the agent. Omit to use the agent's own default, which is fresh context unless it declares otherwise.",
          }),
        ),
        cwd: Type.Optional(
          Type.String({
            description:
              "Existing directory the agent runs in, absolute or relative to your working directory, such as a git worktree. Omit to run in your working directory. Not allowed with resume.",
          }),
        ),
        handoff: Type.Optional(
          Type.Object(
            {},
            {
              additionalProperties: true,
              description:
                "Data for extensions in the agent's session, as { <key>: value }. Each key belongs to one extension, which documents the shape in its own tool guidance. Omit unless such guidance tells you to set a key.",
            },
          ),
        ),
      }),

      // ---- Custom rendering: inline subagent results ----

      renderCall(args: Record<string, unknown>, theme: Theme) {
        const displayName = args.subagent_type
          ? getDisplayName(args.subagent_type as string, registry)
          : "Subagent";
        const desc = (args.description as string | undefined) ?? "";
        return new Text(
          `${ICONS.tool} ` +
            theme.fg("toolTitle", theme.bold(displayName)) +
            (desc ? "  " + theme.fg("muted", desc) : ""),
          0,
          0,
        );
      },

      renderResult(
        result: AgentToolResult<AgentDetails | undefined>,
        { expanded, isPartial }: ToolRenderResultOptions,
        theme: Theme,
      ) {
        const details = result.details;
        if (!details) {
          const text = result.content[0]?.type === "text" ? result.content[0].text : "";
          return new Text(text, 0, 0);
        }
        const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(renderAgentResult(details, resultText, expanded, isPartial, theme), 0, 0);
      },

      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: ((update: AgentToolResult<AgentDetails>) => void) | undefined,
        ctx: ExtensionContext,
      ) => this.execute(toolCallId, params, signal, onUpdate, ctx),
    });
  }
}

/**
 * The operator-facing sentence for each reason a resume is refused.
 *
 * Exhaustive over `ResumeRefusalReason`, so a reason added later fails to
 * compile here rather than falling through to an attempted resume.
 */
function resumeRefusalMessage(refusal: ResumeRefusalReason, id: string): string {
  switch (refusal) {
    case "unknown-agent":
      return `Agent not found: "${id}". It is not live in this session; subagent_get without agent_id lists the agents started on this branch, including any from before a reload or resume.`;
    case "still-running":
      return (
        `Agent "${id}" is still running; wait for it to finish before resuming. ` +
        "Use subagent_steer to send it a message while it runs."
      );
    case "session-released":
      return `Agent "${id}" had its session released after its retention window; resume is unavailable, but its result is still retrievable via subagent_get.`;
    case "no-session":
      return `Agent "${id}" has no active session to resume.`;
    case "workspace-disposed":
      return (
        `Agent "${id}" ran in an isolated workspace that no longer ` +
        "exists; resume is unavailable because the agent would re-enter a directory that " +
        "has been removed. Spawn a new agent instead — the agent's result records where " +
        "any work was saved."
      );
  }
}

/**
 * Whether the parent runs in a mode that ends with its turn (`pi -p`, `--mode json`).
 * Nothing can wake it afterwards, so a background agent's result would be lost.
 */
function isOneShotMode(ctx: ExtensionContext | undefined): boolean {
  return ctx?.mode === "print" || ctx?.mode === "json";
}
