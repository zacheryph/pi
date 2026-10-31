/**
 * child-lifecycle.ts — Child-execution lifecycle event contract and publisher.
 *
 * The core publishes its child-execution lifecycle as ordered events on the Pi
 * event bus; reactive consumers (permissions, telemetry, UI) subscribe rather
 * than the core reaching out to them (ADR 0002). This module owns the channel
 * names, payload shapes, and the publisher that emits them.
 *
 * The publisher takes an injected `emit` callback so this module stays free of
 * Pi SDK imports — `index.ts` wires it to `pi.events.emit`.
 *
 * `spawning`, `session-created`, `completed`, and `disposed` are the announcement
 * a consumer may rely on. `bound` is additional: it reports that a child finished
 * binding its extensions, which is the only moment a parent can observe what those
 * extensions did or did not install.
 */

import type { TurnBudget } from "#src/lifecycle/turn-limits";

/** Emitted at the start of a child run, before the session is created. */
export const SUBAGENT_CHILD_SPAWNING = "subagents:child:spawning";

/**
 * Emitted after the child session is created, immediately before
 * `bindExtensions()`. Carries the child session id consumers need to register
 * the session in `SubagentSessionRegistry`. Subscribers must register
 * synchronously so the entry lands before binding proceeds (see ADR 0002 /
 * the event-bus synchronous-dispatch guarantee).
 */
export const SUBAGENT_CHILD_SESSION_CREATED = "subagents:child:session-created";

/**
 * Emitted once the child's extensions have bound, after every child
 * `session_start` handler has run and before the child takes its first turn.
 *
 * Skipped when binding throws: that child never runs, so there is nothing to
 * report about it.
 */
export const SUBAGENT_CHILD_BOUND = "subagents:child:bound";

/** Emitted after the child's prompt resolves, whether it finished or the harness stopped it. */
export const SUBAGENT_CHILD_COMPLETED = "subagents:child:completed";

/** Emitted in the run's `finally` — always fires, on success and error. */
export const SUBAGENT_CHILD_DISPOSED = "subagents:child:disposed";

/** Payload for `subagents:child:spawning`. */
export interface ChildSpawningEvent {
  agentName: string;
  parentSessionId?: string;
}

/**
 * Extension-defined data a spawn hands its child, keyed by the extension that
 * reads it (pi-todo reads `todos`). The core never interprets it: it checks the
 * value is a plain JSON object within `MAX_HANDOFF_BYTES`, copies and deep-freezes
 * it, and forwards it on `session-created`. Each key's owner documents and
 * validates its own shape.
 */
export type SubagentHandoff = Readonly<Record<string, unknown>>;

/** Serialized size cap for a handoff. */
export const MAX_HANDOFF_BYTES = 16 * 1024;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Check and copy a spawn's handoff. Nothing to hand over (absent, null, `{}`)
 * yields no handoff; anything that is not a JSON object within the cap is an
 * error for the caller.
 */
export function normalizeHandoff(
  value: unknown,
): { handoff?: SubagentHandoff } | { error: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    return { error: "handoff must be an object keyed by the extension that reads it" };
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    return {
      error: `handoff must be JSON data: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_HANDOFF_BYTES)
    return { error: `handoff is ${bytes} bytes; the limit is ${MAX_HANDOFF_BYTES}` };
  const copy = JSON.parse(json) as Record<string, unknown>;
  return Object.keys(copy).length ? { handoff: deepFreeze(copy) } : {};
}

/** Identity of the run a child session belongs to, carried on its events. */
export interface ChildRunIdentity {
  /** The subagent's record id (`getRecord(id)`); the same across resumes. */
  agentId?: string;
  /** The parent's `subagent` tool call; absent for service spawns. */
  toolCallId?: string;
}

/** Payload for `subagents:child:session-created`. */
export interface ChildSessionCreatedEvent extends ChildRunIdentity {
  /** Child session id — the registry key. Unique per child; concurrent
   * siblings of the same parent occupy distinct keys. */
  sessionId: string;
  parentSessionId?: string;
  handoff?: SubagentHandoff;
}

/** Payload for `subagents:child:bound`. */
export interface ChildBoundEvent extends ChildRunIdentity {
  /** Child session id — the same key `session-created` carried. */
  sessionId: string;
  parentSessionId?: string;
}

/** Payload for `subagents:child:completed`. */
export interface ChildCompletedEvent {
  sessionDir: string;
  agentName: string;
  /** The run's turn limit and its use; absent when no limit applied. */
  turnBudget?: TurnBudget;
}

/** Payload for `subagents:child:disposed`. */
export interface ChildDisposedEvent extends ChildRunIdentity {
  /** Child session id — the registry key. Must match `session-created`. */
  sessionId: string;
}

/** Narrow emit seam — injected, never imports the Pi SDK. */
export type LifecycleEmit = (channel: string, data: unknown) => void;

/** Publishes the child-execution lifecycle on the event bus. */
export interface ChildLifecyclePublisher {
  spawning(event: ChildSpawningEvent): void;
  sessionCreated(event: ChildSessionCreatedEvent): void;
  bound(event: ChildBoundEvent): void;
  completed(event: ChildCompletedEvent): void;
  disposed(event: ChildDisposedEvent): void;
}

/** Build a publisher backed by an injected `emit` callback. */
export function createChildLifecyclePublisher(emit: LifecycleEmit): ChildLifecyclePublisher {
  return {
    spawning(event) {
      emit(SUBAGENT_CHILD_SPAWNING, event);
    },
    sessionCreated(event) {
      emit(SUBAGENT_CHILD_SESSION_CREATED, event);
    },
    bound(event) {
      emit(SUBAGENT_CHILD_BOUND, event);
    },
    completed(event) {
      emit(SUBAGENT_CHILD_COMPLETED, event);
    },
    disposed(event) {
      emit(SUBAGENT_CHILD_DISPOSED, event);
    },
  };
}
