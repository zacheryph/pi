import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatLifetimeTokens, textResult } from "#src/tools/helpers";
import type { SteerOutcome, Subagent } from "#src/types";

// ---- Deps interfaces ----

export interface SteerToolManager {
  getRecord(id: string): Subagent | undefined;
}

export interface SteerToolEvents {
  emit(name: string, data: unknown): void;
}

// ---- Class ----

export class SteerTool {
  constructor(
    private readonly manager: SteerToolManager,
    private readonly events: SteerToolEvents,
  ) {}

  async execute(
    _toolCallId: string,
    params: { agent_id: string; message: string },
    _signal: AbortSignal,
    _onUpdate: unknown,
    _ctx: unknown,
  ) {
    const record = this.manager.getRecord(params.agent_id);
    if (!record) {
      return textResult(
        `Agent not found: "${params.agent_id}". It is not live in this session; subagent_get without agent_id lists the agents started on this branch, including any from before a reload or resume.`,
      );
    }

    let outcome: SteerOutcome;
    try {
      outcome = await record.steer(params.message);
    } catch (err) {
      return textResult(
        `Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    switch (outcome.kind) {
      case "rejected":
        return textResult(
          `Agent "${params.agent_id}" is not running (status: ${outcome.status}). Cannot steer a non-running agent.`,
        );
      case "buffered":
        this.events.emit("subagent:steered", { id: record.id, message: params.message });
        return textResult(
          `Steering message queued for agent ${record.id}. It will be delivered when the agent is admitted to run.`,
        );
      case "delivered":
        this.events.emit("subagent:steered", { id: record.id, message: params.message });
        return this.renderDelivered(record);
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

  toToolDefinition() {
    return defineTool({
      name: "subagent_steer" as const,
      label: "Steer Agent",
      promptSnippet: "Send a mid-run message to redirect a running background agent.",
      description:
        "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
        "and be injected into its conversation, allowing you to redirect its work mid-run. Waiting agents are queued for activation; guidance for an already queued activation is merged into its inbox.",
      parameters: Type.Object({
        agent_id: Type.String({
          description: "The agent ID to steer (running, waiting, or queued for activation).",
        }),
        message: Type.String({
          description:
            "The steering message to send. This will appear as a user message in the agent's conversation.",
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
