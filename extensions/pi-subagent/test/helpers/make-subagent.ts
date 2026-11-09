import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import { Subagent, type SubagentExecution } from "#src/lifecycle/subagent";
import type { SubagentSession } from "#src/lifecycle/subagent-session";
import {
  type DisplayStatus,
  type RunOutcome,
  SubagentState,
  type SubagentStatus,
} from "#src/lifecycle/subagent-state";
import type { TurnBudget } from "#src/lifecycle/turn-limits";
import type { SubagentType } from "#src/types";
import { createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

/**
 * A minimal, mandatory SubagentExecution for tests that build a passive record
 * and never call run(). The factory resolves to a default session stub.
 */
export function makeStubExecution(overrides: Partial<SubagentExecution> = {}): SubagentExecution {
  return {
    createSubagentSession: async (_params: CreateSubagentSessionParams): Promise<SubagentSession> =>
      toSubagentSession(createSubagentSessionStub()),
    snapshot: STUB_SNAPSHOT,
    prompt: "do something",
    ...overrides,
  };
}

/**
 * The status and outcome a record reads as for one of today's display labels,
 * so a fixture can say "an agent that errored" without spelling out
 * "idle, outcome error".
 */
export function stateForLabel(label: DisplayStatus): {
  status: SubagentStatus;
  outcome?: RunOutcome;
} {
  switch (label) {
    case "queued":
    case "running":
      return { status: label };
    case "completed":
      return { status: "idle", outcome: "completed" };
    case "aborted":
      return { status: "idle", outcome: "turn-limit" };
    case "error":
      return { status: "idle", outcome: "error" };
    case "stopped":
      return { status: "idle", outcome: "stopped" };
  }
}

export interface TestSubagentOptions {
  id?: string;
  type?: SubagentType;
  description?: string;
  execution?: SubagentExecution;
  /** Shorthand to set execution.parentSession.toolCallId. Ignored when execution is supplied. */
  toolCallId?: string;
  /**
   * Passive lifecycle state shorthands. Either a status (`idle` takes its
   * `outcome`) or one of today's display labels, which stands for the status and
   * outcome that read that way. Defaults to a completed agent.
   */
  status?: SubagentStatus | DisplayStatus;
  outcome?: RunOutcome;
  result?: string;
  /** Seed the question the agent ended its turn with. */
  pendingQuestion?: string;
  /** Seed the run's turn limit and its use. */
  turnBudget?: TurnBudget;
  error?: string;
  /** Seed the never-started marker (the agent was stopped before it was admitted). */
  stoppedWhileQueued?: boolean;
  startedAt?: number;
  completedAt?: number;
  /** Seed the consumed-outcome timestamp (undefined = obligation open). */
  consumedAt?: number;
  /** Seed toolUses. */
  toolUses?: number;
  /** Seed lifetimeUsage. */
  lifetimeUsage?: { input: number; output: number; cacheWrite: number };
  /** Seed compactionCount. */
  compactionCount?: number;
  /** Seed active tools by name. */
  activeTools?: string[];
  /** Seed the run's updates, in order (each replays recordUpdate). */
  runUpdates?: string[];
  /** Seed responseText. */
  responseText?: string;
  /**
   * Attach a session stub after construction, so the record reads as
   * session-ready. Defaults to false: a passive fixture has never run, so it has
   * no session, which is what most callers want.
   */
  sessionReady?: boolean;
  /**
   * Transcript path the attached session stub reports. Ignored unless
   * `sessionReady` is set — a record with no session has no transcript.
   */
  outputFile?: string;
  /** Use this state as-is, for a test that drives its transitions; the seeds are ignored. */
  state?: SubagentState;
}

export function createTestSubagent(overrides: TestSubagentOptions = {}): Subagent {
  const {
    id,
    type,
    description,
    execution,
    toolCallId,
    toolUses,
    lifetimeUsage,
    compactionCount,
    activeTools,
    responseText,
    runUpdates,
    sessionReady,
    outputFile,
    state: suppliedState,
    status = "completed",
    outcome,
    ...stateOverrides
  } = overrides;
  const state =
    suppliedState ??
    new SubagentState({
      ...(status === "idle" ? { status, outcome } : stateForLabel(status)),
      result: "All done.",
      startedAt: 1000,
      completedAt: 2000,
      toolUses: toolUses ?? 3,
      lifetimeUsage: lifetimeUsage ?? { input: 500, output: 500, cacheWrite: 0 },
      ...(compactionCount !== undefined ? { compactionCount } : {}),
      ...(activeTools !== undefined ? { activeTools } : {}),
      ...(responseText !== undefined ? { responseText } : {}),
      ...stateOverrides,
    });
  if (!suppliedState) for (const update of runUpdates ?? []) state.recordUpdate(update);
  const agent = new Subagent({
    id: id ?? "agent-1",
    type: type ?? "general-purpose",
    description: description ?? "Test task",
    execution: execution ?? makeStubExecution(toolCallId ? { parentSession: { toolCallId } } : {}),
    state,
  });
  // Assigned rather than passed to the constructor: run() is what sets this in
  // production, and a passive fixture never runs.
  if (sessionReady) {
    agent.subagentSession = toSubagentSession(createSubagentSessionStub(undefined, outputFile));
  }
  return agent;
}
