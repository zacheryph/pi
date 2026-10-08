import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { AgentSpawnConfig } from "#src/lifecycle/subagent-manager";
import { renderSpawnNotes, textResult } from "#src/tools/helpers";
import type { ResolvedSpawnConfig, SpawnPresentation } from "#src/tools/spawn-config";
import type { ParentSessionInfo, Subagent } from "#src/types";
import type { AgentDetails } from "#src/ui/display";

/** Narrow manager interface for the background spawner. */
export interface BackgroundManagerDeps {
  spawn(snapshot: ParentSnapshot, type: string, prompt: string, opts: AgentSpawnConfig): string;
  getRecord(id: string): Subagent | undefined;
}

/** All values the background spawner needs beyond the resolved config. */
export interface BackgroundParams {
  config: ResolvedSpawnConfig;
  snapshot: ParentSnapshot;
  parentSession: ParentSessionInfo;
  settings: { readonly maxConcurrent: number };
}

/** What a background launch reports: one shape for every door that returns before the run ends. */
export interface BackgroundLaunch {
  /** The leading line, e.g. "Agent started in background." */
  headline: string;
  id: string;
  displayName: string;
  description: string;
  detailBase: SpawnPresentation["detailBase"];
  /** Advisories that lead the result; omitted when the door has none. */
  notes?: readonly string[];
  outputFile?: string;
  /** Present only when the launch is waiting for a concurrency slot. */
  queuePosition?: { maxConcurrent: number };
}

/**
 * Spawn a background agent and return the tool result immediately.
 * Owns: mapping the spawned record onto its launch report.
 */
export function spawnBackground(
  manager: BackgroundManagerDeps,
  params: BackgroundParams,
) {
  const { identity, execution, presentation, notes } = params.config;

  let id: string;
  try {
    id = manager.spawn(params.snapshot, identity.subagentType, execution.prompt, {
      parentSession: params.parentSession,
      description: execution.description,
      model: execution.model,
      maxTurns: execution.effectiveMaxTurns,
      inheritContext: execution.inheritContext,
      thinkingLevel: execution.thinking,
      // resolveSpawnConfig already merged the agent's frontmatter and AgentTool
      // routed here on the result, so this door has committed.
      background: { kind: "explicit", isBackground: true },
    });
  } catch (err) {
    return textResult(err instanceof Error ? err.message : String(err));
  }

  const record = manager.getRecord(id);
  const isQueued = record?.status === "queued";
  return renderBackgroundLaunch({
    headline: `Agent ${isQueued ? "queued" : "started"} in background.`,
    id,
    displayName: identity.displayName,
    description: execution.description,
    detailBase: presentation.detailBase,
    notes,
    outputFile: record?.outputFile,
    queuePosition: isQueued ? { maxConcurrent: params.settings.maxConcurrent } : undefined,
  });
}

/**
 * Render a background launch as the tool result: the launch message and the
 * `background` details the result renderer shows while the run continues.
 * Owns: launch message formatting, for every door that launches in the background.
 */
export function renderBackgroundLaunch(launch: BackgroundLaunch) {
  // Annotated rather than inlined into the call: `textResult` is generic over its
  // details, so an inline literal would define the type instead of being checked
  // against it.
  const details: AgentDetails = {
    ...launch.detailBase,
    toolUses: 0,
    tokens: "",
    durationMs: 0,
    status: "background",
    agentId: launch.id,
  };
  return textResult(
    renderSpawnNotes(launch.notes ?? []) +
      `${launch.headline}\n` +
      `Agent ID: ${launch.id}\n` +
      `Type: ${launch.displayName}\n` +
      `Description: ${launch.description}\n` +
      (launch.outputFile ? `Output file: ${launch.outputFile}\n` : "") +
      (launch.queuePosition
        ? `Position: queued (max ${launch.queuePosition.maxConcurrent} concurrent)\n`
        : "") +
      `\nYou will be notified when this agent completes.\n` +
      `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
      `Do not duplicate this agent's work.`,
    details,
  );
}
