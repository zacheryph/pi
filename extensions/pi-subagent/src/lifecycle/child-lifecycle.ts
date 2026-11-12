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
 * extensions did or did not install. `prepare` is a synchronous contribution hook:
 * extensions require tools before SDK creation, without the core knowing their keys.
 */
import { errorText } from "../../../../packages/pi-foundations/src/errors.ts";

import type { TurnBudget } from "#src/lifecycle/turn-limits";

/** Emitted at the start of a child run, before the session is created. */
export const SUBAGENT_CHILD_SPAWNING = "subagent:session:spawning";

/** Synchronous extension tool contributions, before the SDK fixes the child's allowlist. */
export const SUBAGENT_CHILD_PREPARE = "subagent:session:prepare";

/**
 * Emitted after the child session is created, immediately before
 * `bindExtensions()`. Carries the child session id consumers need to register
 * the session in `SubagentSessionRegistry`. Subscribers must register
 * synchronously so the entry lands before binding proceeds (see ADR 0002 /
 * the event-bus synchronous-dispatch guarantee).
 */
export const SUBAGENT_CHILD_SESSION_CREATED = "subagent:session:created";

/**
 * Emitted once the child's extensions have bound, after every child
 * `session_start` handler has run and before the child takes its first turn.
 *
 * Skipped when binding throws: that child never runs, so there is nothing to
 * report about it.
 */
export const SUBAGENT_CHILD_BOUND = "subagent:session:bound";

/** Emitted after the child's prompt resolves, whether it finished or the harness stopped it. */
export const SUBAGENT_CHILD_COMPLETED = "subagent:session:completed";

/** Emitted in the run's `finally` — always fires, on success and error. */
export const SUBAGENT_CHILD_DISPOSED = "subagent:session:disposed";

/** Payload for `subagent:session:spawning`. */
export interface ChildSpawningEvent {
  agentName: string;
  parentSessionId?: string;
}

/**
 * Extension-defined data a spawn hands its child, keyed by the extension that
 * reads it (pi-todo reads `todo`). The core never interprets it: it checks the
 * value is a plain JSON object within `MAX_HANDOFF_BYTES`, copies and deep-freezes
 * it, and forwards it on `prepare` and `session-created`. Each key's owner
 * documents and validates its own shape.
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
      error: `handoff must be JSON data: ${errorText(err)}`,
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
  /** The parent's `subagent_start` tool call; absent for service spawns. */
  toolCallId?: string;
}

/** Inputs available before a child session exists. */
export interface ChildPreparation extends ChildRunIdentity {
  agentName: string;
  parentSessionId?: string;
  handoff?: SubagentHandoff;
  cwd: string;
}

/** Payload for `subagent:session:prepare`. Handlers must contribute synchronously. */
export interface ChildPrepareEvent extends ChildPreparation {
  /** Exact tool names required by this handoff, not patterns or profile selectors. */
  requireTools(names: readonly string[]): void;
}

/** Payload for `subagent:session:created`. */
export interface ChildSessionCreatedEvent extends ChildRunIdentity {
  /** Child session id — the registry key. Unique per child; concurrent
   * siblings of the same parent occupy distinct keys. */
  sessionId: string;
  parentSessionId?: string;
  handoff?: SubagentHandoff;
  /** The directory the child runs in: a caller's `cwd`, or the parent's. */
  cwd?: string;
}

/** Payload for `subagent:session:bound`. */
export interface ChildBoundEvent extends ChildRunIdentity {
  /** Child session id — the same key `session-created` carried. */
  sessionId: string;
  parentSessionId?: string;
}

/** Payload for `subagent:session:completed`. */
export interface ChildCompletedEvent {
  sessionDir: string;
  agentName: string;
  /** The run's turn limit and its use; absent when no limit applied. */
  turnBudget?: TurnBudget;
}

/** Payload for `subagent:session:disposed`. */
export interface ChildDisposedEvent extends ChildRunIdentity {
  /** Child session id — the registry key. Must match `session-created`. */
  sessionId: string;
  /**
   * The session went away because the session that spawned it is shutting down (a reload, a quit,
   * a session switch), not because the agent is done: its record is kept, and the next start may
   * reopen it. Whoever tied something to the agent, not to this session, keeps it.
   */
  kept?: true;
}

/** Narrow emit seam — injected, never imports the Pi SDK. */
export type LifecycleEmit = (channel: string, data: unknown) => void;

/** Publishes the child-execution lifecycle on the event bus. */
export interface ChildLifecyclePublisher {
  spawning(event: ChildSpawningEvent): void;
  prepare(event: ChildPreparation): string[];
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
    prepare(event) {
      const requested: string[] = [];
      emit(SUBAGENT_CHILD_PREPARE, {
        ...event,
        requireTools: (names: readonly string[]) => requested.push(...names),
      } satisfies ChildPrepareEvent);
      // Snapshot synchronous contributions. Later async handlers cannot change
      // this run's allowlist. Selectors would accidentally widen SDK capabilities.
      const names = [...new Set(requested)];
      for (const name of names) {
        if (
          typeof name !== "string" ||
          !name.trim() ||
          name !== name.trim() ||
          name === "all" ||
          name === "none" ||
          /^[+-]/.test(name) ||
          /[\s*?]/.test(name)
        )
          throw new Error(`Handoff requires an invalid tool name: ${JSON.stringify(name)}`);
      }
      return names;
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
