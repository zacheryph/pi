import type { AgentConfigLookup } from "#src/config/agent-types";
import type { TurnBudget } from "#src/lifecycle/turn-limits";
import { getLifetimeTotal, type LifetimeUsage } from "#src/lifecycle/usage";
import type { AgentConfig } from "#src/types";
import { type AgentDetails, formatTokens, type ModelIdentity, modelLabel } from "#src/ui/display";

/** Build AgentDetails from a base + record-specific fields. */
export function buildDetails(
  base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
  record: {
    toolUses: number;
    startedAt: number;
    completedAt?: number;
    status: string;
    error?: string;
    id?: string;
    lifetimeUsage: LifetimeUsage;
    /** The model the agent runs; unknown for an inherited model until its session exists. */
    model?: ModelIdentity;
    turnBudget?: TurnBudget;
  },
  overrides?: Partial<AgentDetails>,
): AgentDetails {
  return {
    ...base,
    modelName: modelLabel(record.model) ?? base.modelName,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status as AgentDetails["status"],
    agentId: record.id,
    error: record.error,
    turnBudget: record.turnBudget,
    ...overrides,
  };
}

/** Render a spawn's advisories as the prefix a result's leading line follows, or "" when there are none. */
export function renderSpawnNotes(notes: readonly string[]): string {
  return notes.length > 0 ? `${notes.join("\n")}\n\n` : "";
}

/**
 * Tool execute return value for a text response.
 *
 * Generic over the details payload so a tool with its own presentation metadata
 * can attach it; defaults to `AgentDetails`, which is what every subagent-tool
 * call site passes.
 */
export function textResult<T = AgentDetails>(msg: string, details?: T) {
  return { content: [{ type: "text" as const, text: msg }], details };
}

/** Format an agent's lifetime token total, or "" when zero. */
export function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

/** Narrow registry interface needed by buildTypeListText. */
export interface TypeListRegistry extends AgentConfigLookup {
  getListedTypes(): string[];
}

/**
 * Build the agent-type list for the subagent_start tool description: one line
 * per listed agent, built-in and custom alike, in registry order.
 *
 * Each line carries the name, the model when the agent pins one, what the agent
 * is (`description`) and when to pick it (`guidance`), so the name appears once.
 */
export function buildTypeListText(registry: TypeListRegistry): string {
  return registry
    .getListedTypes()
    .map((name) => formatTypeEntry(name, registry.resolveAgentConfig(name)))
    .join("\n");
}

function formatTypeEntry(name: string, config: AgentConfig): string {
  const model = config.model ? ` (${getModelLabelFromConfig(config.model)})` : "";
  const description = oneLine(config.description).replace(/\.$/, "");
  const guidance = config.guidance ? oneLine(config.guidance) : "";
  return `- ${name}${model}: ${description}${guidance ? `. ${guidance}` : ""}`;
}

/** Collapse a frontmatter value that may span lines into a single trimmed line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Derive a short model label from a model string. */
export function getModelLabelFromConfig(model: string): string {
  // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
  const name = model.includes("/") ? model.split("/").pop()! : model;
  // Strip trailing date suffix (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
  return name.replace(/-\d{8}$/, "");
}
