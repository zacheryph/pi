import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentConfigLookup } from "#src/config/agent-types";
import type { SendRefused, SendResult } from "#src/lifecycle/subagent-manager";
import { renderBackgroundLaunch } from "#src/tools/background-spawner";
import { formatLifetimeTokens, textResult } from "#src/tools/helpers";
import type { Subagent } from "#src/types";
import { getDisplayName, modelLabel } from "#src/ui/display";

// ---- Deps interfaces ----

/** Narrow manager interface — the one call `subagent_send` makes. */
export interface SendToolManager {
  send(id: string, message: string): Promise<SendResult>;
}

export interface SendToolEvents {
  emit(name: string, data: unknown): void;
}

/** The settings slice the tool reads. */
export interface SendToolSettings {
  readonly maxConcurrent: number;
}

// ---- Class ----

/**
 * `subagent_send`: the one tool that reaches an agent in any state, like typing
 * into a main session. The state rules live in `Subagent.send`; this class owns
 * how each outcome is worded.
 */
export class SendTool {
  constructor(
    private readonly manager: SendToolManager,
    private readonly events: SendToolEvents,
    private readonly registry: AgentConfigLookup,
    private readonly settings: SendToolSettings,
  ) {}

  async execute(
    _toolCallId: string,
    params: { agent_id: string; message: string },
    _signal: AbortSignal,
    _onUpdate: unknown,
    _ctx: unknown,
  ) {
    let result: SendResult;
    try {
      result = await this.manager.send(params.agent_id, params.message);
    } catch (err) {
      return textResult(
        `Failed to send message to agent: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    switch (result.kind) {
      case "refused":
        return textResult(sendRefusalMessage(result, params.agent_id));
      case "steered": {
        const { record } = result;
        this.events.emit("subagent:steered", { id: record.id, message: params.message });
        return result.delivery === "buffered"
          ? textResult(
              `Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`,
            )
          : this.renderDelivered(record);
      }
      case "joined": {
        const { record } = result;
        this.events.emit("subagent:steered", { id: record.id, message: params.message });
        return textResult(
          `Agent ${record.id} is queued for a concurrency slot (max ${this.settings.maxConcurrent} concurrent) and has not started. ` +
            "Your message was added to the prompt of the run that is waiting, so the agent sees it when it starts. " +
            "If that run is stopped before its slot opens, the message is dropped.",
        );
      }
      case "started":
        return this.renderStarted(result.record, result.relaunched);
    }
  }

  /** Render the success message with live state for a delivered steer. */
  private renderDelivered(record: Subagent) {
    const tokens = formatLifetimeTokens(record);
    const contextPercent = record.getContextPercent();
    const stateParts: string[] = [];
    if (tokens) stateParts.push(tokens);
    stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
    if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`);
    if (record.compactionCount)
      stateParts.push(
        `${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`,
      );
    return textResult(
      `Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
        `Current state: ${stateParts.join(" · ")}`,
    );
  }

  /**
   * Render the launch of the run an idle agent's message started. Like a spawn,
   * the call returns at once; the completion message carries the outcome. With
   * every slot taken the run waits, and the call says so.
   */
  private renderStarted(record: Subagent, relaunched: boolean) {
    const isQueued = record.status === "queued";
    const verb = relaunched ? ["started", "queued"] : ["resumed", "resume queued"];
    return renderBackgroundLaunch({
      headline: `Agent ${isQueued ? verb[1] : verb[0]} in background.`,
      id: record.id,
      displayName: getDisplayName(record.type, this.registry),
      description: record.description,
      detailBase: {
        displayName: getDisplayName(record.type, this.registry),
        description: record.description,
        subagentType: record.type,
        modelName: modelLabel(record.model),
      },
      notes: relaunched
        ? [
            "Note: this agent never started a session, so this is its first run: its original task followed by your message.",
          ]
        : undefined,
      outputFile: record.outputFile,
      queuePosition: isQueued ? { maxConcurrent: this.settings.maxConcurrent } : undefined,
    });
  }

  toToolDefinition() {
    return defineTool({
      name: "subagent_send" as const,
      label: "Send to Agent",
      promptSnippet:
        "Send a message to a background agent in any state: steer a running one, or give an idle one more work.",
      description:
        "Send a message to an agent, like typing into a main session. It reaches the agent in whatever state it is in:\n" +
        "- Running: the message interrupts it after its current tool execution and is injected into its conversation, redirecting its work mid-run.\n" +
        "- Queued (waiting for a concurrency slot): the message is added to the prompt it will start with. Stopping that waiting run drops the message.\n" +
        "- Idle (finished, failed, hit its turn limit or stopped): a new run starts with the message as its prompt, continuing from its earlier conversation. " +
        "Use this to give a finished agent more work, or to answer an agent that asked you a question (its question message says so): your message is the answer, and it closes the agent's open questions. " +
        "An agent that is waiting on work, such as a job, is idle too: a message wakes it, and the work it waits on stays open. " +
        "If its session was released, the saved transcript is reopened, also after a reload, as long as the transcript and the directory it ran in still exist.\n" +
        "- Idle and never had a session (stopped while still queued, or its session could not be created): its first run starts, from its original task followed by the message. " +
        "After a reload the original task is gone, so such an agent cannot be reached; spawn a new one.\n" +
        "A new run goes through the concurrency limit like any other, the call returns at once, and the outcome arrives as another completion message.",
      parameters: Type.Object({
        agent_id: Type.String({
          description: "The agent ID to message. The agent can be in any state.",
        }),
        message: Type.String({
          description:
            "The message to send. It appears as a user message in the agent's conversation.",
        }),
      }),
      execute: (
        toolCallId: string,
        params: { agent_id: string; message: string },
        signal: AbortSignal,
        onUpdate: unknown,
        ctx: unknown,
      ) => this.execute(toolCallId, params, signal, onUpdate, ctx),
    });
  }
}

/**
 * The operator-facing sentence for each reason a message is refused.
 *
 * Exhaustive over `SendRefusalReason`, so a reason added later fails to
 * compile here rather than falling through to an attempted send.
 */
function sendRefusalMessage(refusal: SendRefused, id: string): string {
  const message = sendRefusalSentence(refusal.reason, id);
  return refusal.transcriptPath
    ? `${message}\n\nIts transcript is at: ${refusal.transcriptPath}`
    : message;
}

function sendRefusalSentence(reason: SendRefused["reason"], id: string): string {
  switch (reason) {
    case "unknown-agent":
      return `Agent not found: "${id}". It is not live in this session; subagent_get without agent_id lists the agents started on this branch, including any from before a reload or resume.`;
    case "session-released":
      return `Agent "${id}" had its session released and its saved transcript is gone; it cannot take a message, but its result is still retrievable via subagent_get.`;
    case "rebuilding":
      return (
        `Agent "${id}" was stopped while its session was being created or rebuilt and is still shutting down. ` +
        "Send the message again in a moment."
      );
    case "no-session":
      return (
        `Agent "${id}" never started a session, and its original task was not saved across the reload, so it cannot take a message. ` +
        "Spawn a new agent with the task."
      );
    case "directory-unavailable":
      return (
        `Agent "${id}" cannot take a message: the directory it ran in no longer exists. ` +
        "Spawn a new agent with the context it needs."
      );
    case "agent-type-unavailable":
      return (
        `Agent "${id}" cannot take a message: its agent type is no longer available. ` +
        "Spawn a new agent with the context it needs."
      );
  }
}
