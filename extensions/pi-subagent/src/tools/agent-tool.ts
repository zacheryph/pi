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
import type { AgentSpawnConfig } from "#src/lifecycle/subagent-manager";
import { spawnBackground } from "#src/tools/background-spawner";
import { buildTypeListText, textResult } from "#src/tools/helpers";
import { renderAgentResult } from "#src/tools/result-renderer";
import {
  type ModelInfo,
  type ResolvedSpawnConfig,
  resolveSpawnConfig,
} from "#src/tools/spawn-config";
import type { ParentSessionInfo, Subagent } from "#src/types";
import { type AgentDetails, getDisplayName, type Theme } from "#src/ui/display";
import { ICONS } from "../../../../packages/pi-ui/src/index.ts";

// ---- Deps interfaces ----

/** Narrow manager interface — only the methods the Agent tool calls. */
export interface AgentToolManager {
  spawn: (snapshot: ParentSnapshot, type: string, prompt: string, opts: AgentSpawnConfig) => string;
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

  constructor(
    private readonly manager: AgentToolManager,
    private readonly runtime: AgentToolRuntime,
    private readonly settings: AgentToolSettings,
    private readonly registry: AgentTypeRegistry,
  ) {
    this.typeListText = buildTypeListText(registry);
  }

  async execute(
    toolCallId: string,
    params: Record<string, unknown>,
    _signal: AbortSignal | undefined,
    _onUpdate: ((update: AgentToolResult<AgentDetails>) => void) | undefined,
    _ctx: ExtensionContext,
  ) {
    // Reload custom agents so new .pi/agents/*.md files are picked up without restart
    this.registry.reload();

    // ---- Config resolution (pure) ----
    const resolved = resolveSpawnConfig(
      params,
      this.registry,
      this.runtime.getModelInfo(),
      this.settings,
    );
    if ("error" in resolved) return textResult(resolved.error);

    // ---- Boundary extraction (after config so inheritContext is resolved) ----
    const snapshot = this.runtime.buildSnapshot(resolved.execution.inheritContext);

    // ---- Caller-chosen cwd (local change), relative to the parent's cwd ----
    const cwd = resolveSpawnCwd(params.cwd, snapshot.cwd);
    if ("error" in cwd) return textResult(cwd.error);
    const config: ResolvedSpawnConfig = cwd.cwd
      ? { ...resolved, execution: { ...resolved.execution, cwd: cwd.cwd } }
      : resolved;
    const { parentSessionFile, parentSessionId } = this.runtime.getSessionInfo();
    const parentSession: ParentSessionInfo = { parentSessionFile, parentSessionId, toolCallId };

    // ---- Spawn: the call returns the agent ID at once ----
    return spawnBackground(this.manager, {
      config,
      snapshot,
      parentSession,
      settings: this.settings,
    });
  }

  toToolDefinition() {
    const typeListText = this.typeListText;
    const registry = this.registry;

    const guidelines = [
      "- Agents always run in the background: the call returns an agent ID at once, and a completion message arrives when the agent finishes. Start every independent agent, then end your turn instead of waiting; the message wakes you, and the user can talk to you in the meantime. Do not poll.",
      "- The completion message is the only carrier of an outcome: it holds the result up to 500 characters. Ask agents to store a large result with stash_put and name the stash handle in their final answer, then read the handle with stash_get. subagent_get reads a finished agent's full result without waiting.",
      "- Provide clear, detailed prompts so the agent can work autonomously.",
      "- Subagent results are returned as text — summarize them for the user.",
      "- Use subagent_send with an agent ID to reach an agent in any state: it steers a running agent, and gives an idle one (finished, failed or stopped) more work or the answer to its question. The new run is a background run too: its outcome arrives as another completion message. This also works after a reload or once its session was released, as long as its transcript and directory still exist: its saved transcript is reopened.",
      '- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").',
      "- Use thinking to control extended thinking level.",
      "- Use inherit_context if the agent needs the parent conversation history.",
      "- Use cwd to run the agent in another existing directory, such as a git worktree you created for it. You own that directory: it is not removed when the agent finishes, and the agent keeps working there when you send it more.",
    ].join("\n");

    return defineTool({
      name: "subagent_start" as const,
      label: "Subagent",
      promptSnippet: "Launch a specialized agent for complex, multi-step tasks.",
      description: `Launch an agent that works on a task autonomously, with its own instructions, tools and model.

Agent types:
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
          description:
            "The agent type: a name from this tool's list, or an unlisted type you were told to use by name.",
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
        inherit_context: Type.Optional(
          Type.Boolean({
            description:
              "If true, fork parent conversation into the agent. Omit to use the agent's own default, which is fresh context unless it declares otherwise.",
          }),
        ),
        cwd: Type.Optional(
          Type.String({
            description:
              "Existing directory the agent runs in, absolute or relative to your working directory, such as a git worktree. Omit to run in your working directory.",
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
