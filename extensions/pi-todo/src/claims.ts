import type { TodoState } from "./state.ts";

/**
 * Task delegation to subagents. A parent hands keys to a child through
 * pi-subagents' generic spawn `handoff` under the `todos` key; the claim is
 * journaled here, beside the plan state (like review watermarks), so upstream's
 * state engine stays untouched.
 */
export const TODO_CLAIMS_TYPE = "pi-personal:todo-claims";
/** The key pi-todo owns in pi-subagents' spawn `handoff`. */
export const HANDOFF_KEY = "todos";
export const MAX_HANDOFF_TASKS = 50;

export type TodoClaimScope = "assigned" | "ledger";

export type TodoClaimsEntry =
  | {
      op: "claim";
      agent: string;
      session: string;
      scope: TodoClaimScope;
      keys: string[];
      at: number;
    }
  | { op: "release"; agent: string; at: number };

/** A live claim: the keys one subagent may update. */
export interface TodoClaim {
  agent: string;
  session: string;
  scope: TodoClaimScope;
  keys: string[];
  at: number;
}

/** Live claims by agent id; released claims are dropped. */
export type TodoClaims = ReadonlyMap<string, TodoClaim>;

const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 128): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

function readEntry(raw: unknown): TodoClaimsEntry | undefined {
  if (!isRecord(raw) || !text(raw.agent) || typeof raw.at !== "number" || !Number.isFinite(raw.at))
    return undefined;
  if (raw.op === "release") return { op: "release", agent: raw.agent, at: raw.at };
  if (
    raw.op !== "claim" ||
    !text(raw.session) ||
    (raw.scope !== "assigned" && raw.scope !== "ledger")
  )
    return undefined;
  if (
    !Array.isArray(raw.keys) ||
    !raw.keys.every((key) => typeof key === "string" && KEY_PATTERN.test(key))
  )
    return undefined;
  return {
    op: "claim",
    agent: raw.agent,
    session: raw.session,
    scope: raw.scope,
    keys: [...raw.keys] as string[],
    at: raw.at,
  };
}

/** Apply one journal entry. A repeated claim for an agent adds keys to its claim. */
export function applyTodoClaims(claims: TodoClaims, raw: unknown): Map<string, TodoClaim> {
  const next = new Map(claims);
  const entry = readEntry(raw);
  if (!entry) return next;
  if (entry.op === "release") {
    next.delete(entry.agent);
    return next;
  }
  const existing = next.get(entry.agent);
  next.set(entry.agent, {
    agent: entry.agent,
    session: entry.session,
    scope: entry.scope,
    at: existing?.at ?? entry.at,
    keys: [...new Set([...(existing?.keys ?? []), ...entry.keys])],
  });
  return next;
}

export function cloneTodoClaims(claims: TodoClaims): Map<string, TodoClaim> {
  return new Map([...claims].map(([agent, claim]) => [agent, { ...claim, keys: [...claim.keys] }]));
}

/** Holder of each claimed key that is still in the plan. */
export function claimHolders(claims: TodoClaims, state?: TodoState): Map<string, string> {
  const present = state ? new Set(state.tasks.map((task) => task.key)) : undefined;
  const holders = new Map<string, string>();
  for (const claim of claims.values()) {
    for (const key of claim.keys) if (!present || present.has(key)) holders.set(key, claim.agent);
  }
  return holders;
}

/** Short display name for an agent id. */
export function agentLabel(agent: string): string {
  return `agent ${agent.replace(/[^\w.-]/g, "").slice(0, 8) || "?"}`;
}

export interface TodoHandoff {
  keys: string[];
  scope: TodoClaimScope;
}

/**
 * Read `handoff.todos`: `{ keys: string[], scope?: "assigned" | "ledger" }`.
 * Undefined when the handoff hands no tasks; an error string when it is malformed.
 */
export function readTodoHandoff(handoff: unknown): TodoHandoff | string | undefined {
  if (!isRecord(handoff) || handoff[HANDOFF_KEY] === undefined) return undefined;
  const raw = handoff[HANDOFF_KEY];
  if (!isRecord(raw) || !Array.isArray(raw.keys))
    return 'handoff.todos must be { keys: string[], scope?: "assigned" | "ledger" }';
  if (raw.scope !== undefined && raw.scope !== "assigned" && raw.scope !== "ledger") {
    return 'handoff.todos.scope must be "assigned" or "ledger"';
  }
  const keys = [...new Set(raw.keys.map((key) => (typeof key === "string" ? key.trim() : "")))];
  if (!keys.length) return "handoff.todos.keys must name at least one task";
  if (keys.length > MAX_HANDOFF_TASKS)
    return `handoff.todos.keys may name at most ${MAX_HANDOFF_TASKS} tasks`;
  const bad = keys.find((key) => !KEY_PATTERN.test(key));
  if (bad !== undefined)
    return `handoff.todos.keys has an invalid task key: ${JSON.stringify(bad)}`;
  return { keys, scope: raw.scope ?? "assigned" };
}

/**
 * Why `handoff` cannot be claimed against this plan, if it cannot: every key must
 * exist, be unfinished, and not be held or reserved by another subagent.
 */
export function handoffConflict(
  handoff: TodoHandoff,
  state: TodoState,
  held: ReadonlyMap<string, string>,
): string | undefined {
  const byKey = new Map(state.tasks.map((task) => [task.key, task]));
  const unknown = handoff.keys.filter((key) => !byKey.has(key));
  if (unknown.length)
    return `unknown task${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`;
  const done = handoff.keys.filter((key) => byKey.get(key)!.status === "completed");
  if (done.length) return `already completed: ${done.join(", ")}`;
  const taken = handoff.keys.filter((key) => held.has(key));
  if (taken.length)
    return `already handed to ${taken.map((key) => `${key} (${held.get(key)})`).join(", ")}`;
  return undefined;
}
