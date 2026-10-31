import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { call, node, parentOf, provide, trackChildren } from "../../../packages/pi-session-tree/src/index.ts";
import { cloneTodoActivity, type TodoActivity, type TodoTaskActivity } from "./activity.ts";
import type { TodoRequest, TodoTaskPatch } from "./actions.ts";
import {
  agentLabel, claimHolders, handoffConflict, readTodoHandoff,
  type TodoClaim, type TodoClaims, type TodoClaimScope, type TodoClaimsEntry, type TodoHandoff,
} from "./claims.ts";
import { cloneTodoState, type TodoDetails, type TodoState, TodoValidationError } from "./state.ts";

/** Session-tree service name. */
export const BROKER_NAME = "pi-todo";
/** A reservation made in `tool_call` stops guarding its keys after this long without a child. */
const RESERVATION_MS = 15 * 60_000;

/** The tasks a subagent may see: its claim (`assigned`) or the whole plan (`ledger`). */
export interface DelegatedView {
  state: TodoState;
  activity: Map<string, TodoTaskActivity>;
  scope: TodoClaimScope;
  /** Keys this subagent holds. */
  keys: string[];
}

/** What a parent's pi-todo offers its subagents' pi-todo (see pi-session-tree). */
export interface TodoBroker {
  version: 1;
  /** The live claim for `agent`, if it has one. */
  claim(agent: string): { keys: string[]; scope: TodoClaimScope } | undefined;
  view(agent: string): DelegatedView;
  /** Apply a child's write to the parent's plan; throws when it is not allowed. */
  mutate(agent: string, request: TodoRequest): DelegatedView;
}

export function delegatedView(state: TodoState, activity: TodoActivity, claim: TodoClaim): DelegatedView {
  const present = new Set(state.tasks.map((task) => task.key));
  const keys = claim.keys.filter((key) => present.has(key));
  const visible = claim.scope === "ledger" ? undefined : new Set(keys);
  const scoped = cloneTodoState({ ...state, tasks: visible ? state.tasks.filter((task) => visible.has(task.key)) : state.tasks });
  return {
    state: scoped,
    activity: new Map([...cloneTodoActivity(activity)].filter(([key]) => !visible || visible.has(key))),
    scope: claim.scope,
    keys,
  };
}

export interface DelegatedWrite {
  /** The write to apply to the parent's plan; absent when nothing changes. */
  request?: TodoRequest;
  /** Keys the write creates; they join the claim. */
  newKeys: string[];
}

const PREREQUISITE_FIELDS = new Set(["key", "dependsOn"]);

/**
 * Check a subagent's write against its claim and turn it into a write on the
 * parent's plan. Claimed keys may change freely; new keys join the claim; with a
 * `ledger` claim (and `childPrerequisites`), an unclaimed task may gain
 * prerequisites, each recorded as a flagged message. `baseRevision` is checked
 * per touched key against `lastChange`, so siblings' writes do not make it stale.
 */
export function checkDelegatedRequest(
  state: TodoState, claim: TodoClaim, request: TodoRequest,
  options: { childPrerequisites: boolean; lastChange: ReadonlyMap<string, number> },
): DelegatedWrite {
  const held = new Set(claim.keys);
  const byKey = new Map(state.tasks.map((task) => [task.key, task]));
  const notYours = (key: string) => new TodoValidationError(
    `task ${key} is not assigned to you` + (claim.scope === "ledger" && options.childPrerequisites
      ? "; you may only add prerequisites to it (dependsOn, keeping the existing ones)" : ""),
  );
  const checkStale = (keys: readonly string[]) => {
    if (request.baseRevision === undefined) return;
    for (const key of keys) {
      const changed = options.lastChange.get(key) ?? 0;
      if (changed > request.baseRevision) {
        throw new TodoValidationError(`stale todo revision: task ${key} changed at revision ${changed}, after ${request.baseRevision}`);
      }
    }
  };
  const { baseRevision: _baseRevision, ...forwarded } = request;
  switch (request.action) {
    case "replace":
      throw new TodoValidationError("replace is not available for delegated tasks; use upsert or remove");
    case "clear": {
      if (request.scope !== "completed") throw new TodoValidationError("delegated tasks can only clear completed tasks (scope: completed)");
      // Same rule as a whole-plan completed clear: keep prerequisites of unfinished tasks.
      const needed = new Set(state.tasks.filter((task) => task.status !== "completed").flatMap((task) => task.dependsOn ?? []));
      const keys = claim.keys.filter((key) => byKey.get(key)?.status === "completed" && !needed.has(key));
      checkStale(keys);
      return keys.length ? { request: { action: "remove", keys }, newKeys: [] } : { newKeys: [] };
    }
    case "remove": {
      const keys = (request.keys ?? []).map((key) => key.trim());
      for (const key of keys) if (byKey.has(key) && !held.has(key)) throw notYours(key);
      checkStale(keys);
      return { request: forwarded, newKeys: [] };
    }
    case "upsert": {
      const newKeys: string[] = [];
      const tasks: TodoTaskPatch[] = [];
      for (const patch of request.tasks ?? []) {
        const key = patch.key.trim();
        const existing = byKey.get(key);
        if (!existing) {
          newKeys.push(key);
          tasks.push(patch);
          continue;
        }
        if (held.has(key)) {
          tasks.push(patch);
          continue;
        }
        const fields = Object.keys(patch).filter((field) => patch[field as keyof TodoTaskPatch] !== undefined);
        const before = existing.dependsOn ?? [];
        const after = patch.dependsOn ?? [];
        const keepsEdges = before.every((dependency) => after.includes(dependency));
        if (claim.scope !== "ledger" || !options.childPrerequisites || !fields.every((field) => PREREQUISITE_FIELDS.has(field))
          || patch.dependsOn === undefined || !keepsEdges) {
          throw notYours(key);
        }
        const added = after.filter((dependency) => !before.includes(dependency));
        if (!added.length) continue;
        tasks.push({ key, dependsOn: after, message: `Prerequisite${added.length === 1 ? "" : "s"} added by a subagent: ${added.join(", ")}` });
      }
      checkStale(tasks.map((patch) => patch.key.trim()).filter((key) => byKey.has(key)));
      return tasks.length ? { request: { ...forwarded, tasks }, newKeys } : { newKeys: [] };
    }
    default:
      throw new TodoValidationError(`unknown action: ${String(request.action)}`);
  }
}

/** What the delegation wiring needs from the extension. */
export interface DelegationHost {
  now(): number;
  state(): TodoState;
  activity(): TodoActivity;
  claims(): TodoClaims;
  config(): { childPrerequisites: boolean };
  /** Journal and apply a claims entry. */
  journalClaims(entry: TodoClaimsEntry): void;
  /** The extension's own write path, attributed to `agent` when set. */
  mutate(request: TodoRequest, agent?: string): TodoDetails;
}

/** A child session's link to the parent plan it works in. */
export interface Delegated {
  parent: string;
  agent: string;
  scope: TodoClaimScope;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Parent side: veto bad `handoff.todos` before a spawn, bind claims as children
 * are created, release them as agents end, and offer the broker. Child side:
 * find this session's claim and route the todo tool to the parent's broker.
 */
export function createTodoDelegation(pi: ExtensionAPI, host: DelegationHost) {
  // Link this session's subagents as pi-subagents creates them.
  trackChildren(pi);
  const pending = new Map<string, { handoff: TodoHandoff; at: number }>();
  /** Last claim of each ended agent, for a resume. */
  const ended = new Map<string, TodoClaim>();
  /** Plan revision at which each key last changed, for per-key stale checks. */
  const lastChange = new Map<string, number>();
  let delegated: Delegated | undefined;
  let withdraw: (() => void) | undefined;

  const held = (exceptCall?: string): Map<string, string> => {
    const holders = new Map([...claimHolders(host.claims(), host.state())].map(([key, agent]) => [key, agentLabel(agent)]));
    for (const [id, reservation] of pending) {
      if (id === exceptCall || host.now() - reservation.at > RESERVATION_MS) continue;
      for (const key of reservation.handoff.keys) if (!holders.has(key)) holders.set(key, "a subagent being started");
    }
    return holders;
  };

  const release = (agent: string, outcome: string) => {
    const claim = host.claims().get(agent);
    if (!claim) return;
    const inProgress = new Set(host.state().tasks.filter((task) => task.status === "in_progress").map((task) => task.key));
    const open = claim.keys.filter((key) => inProgress.has(key));
    if (open.length) {
      try {
        host.mutate({ action: "upsert", tasks: open.map((key) => ({ key, message: `${agentLabel(agent)} ended (${outcome}) with this task in progress` })) }, agent);
      } catch { /* the release below still happens */ }
    }
    ended.set(agent, claim);
    host.journalClaims({ op: "release", agent, at: host.now() });
  };

  const broker: TodoBroker = {
    version: 1,
    claim(agent) {
      const claim = host.claims().get(agent);
      return claim ? { keys: [...claim.keys], scope: claim.scope } : undefined;
    },
    view(agent) {
      const claim = host.claims().get(agent);
      if (!claim) throw new TodoValidationError("no tasks are assigned to you any more");
      return delegatedView(host.state(), host.activity(), claim);
    },
    mutate(agent, request) {
      const claim = host.claims().get(agent);
      if (!claim) throw new TodoValidationError("no tasks are assigned to you any more");
      if (request.action !== "list") {
        const write = checkDelegatedRequest(host.state(), claim, request, { childPrerequisites: host.config().childPrerequisites, lastChange });
        if (write.request) host.mutate(write.request, agent);
        const present = new Set(host.state().tasks.map((task) => task.key));
        const created = write.newKeys.filter((key) => present.has(key));
        if (created.length) {
          host.journalClaims({ op: "claim", agent, session: claim.session, scope: claim.scope, keys: created, at: host.now() });
        }
      }
      return broker.view(agent);
    },
  };

  pi.on("tool_call", (event) => {
    if (event.toolName !== "subagent") return undefined;
    const handoff = readTodoHandoff((event.input as Record<string, unknown> | undefined)?.handoff);
    if (handoff === undefined) return undefined;
    if (typeof handoff === "string") return { block: true, reason: handoff };
    if (delegated) {
      return { block: true, reason: "These tasks belong to your parent session; handing them on to another subagent is not supported yet." };
    }
    const conflict = handoffConflict(handoff, host.state(), held(event.toolCallId));
    if (conflict) return { block: true, reason: `Cannot hand off todo tasks: ${conflict}` };
    pending.set(event.toolCallId, { handoff, at: host.now() });
    return undefined;
  });
  pi.on("tool_result", (event) => {
    if (event.isError) pending.delete(event.toolCallId);
  });

  pi.events.on("subagents:child:session-created", (data) => {
    const raw = (data ?? {}) as Record<string, unknown>;
    const agent = typeof raw.agentId === "string" ? raw.agentId : undefined;
    const session = typeof raw.sessionId === "string" ? raw.sessionId : undefined;
    const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId : undefined;
    const handoff = readTodoHandoff(raw.handoff);
    if (!(toolCallId && pending.delete(toolCallId)) && handoff && typeof handoff !== "string") {
      // No reservation under this call id: free the one made for the same keys.
      const same = [...pending].find(([, reservation]) => reservation.handoff.keys.join("\n") === handoff.keys.join("\n"));
      if (same) pending.delete(same[0]);
    }
    if (delegated || !agent || !session || !handoff || typeof handoff === "string") return;
    // Re-check now: the plan or other claims may have changed since tool_call.
    const holders = held();
    const byKey = new Map(host.state().tasks.map((task) => [task.key, task]));
    const keys = handoff.keys.filter((key) => byKey.has(key) && byKey.get(key)!.status !== "completed" && !holders.has(key));
    if (keys.length) host.journalClaims({ op: "claim", agent, session, scope: handoff.scope, keys, at: host.now() });
  });
  const agentOf = (data: unknown) => {
    const raw = (data ?? {}) as Record<string, unknown>;
    return typeof raw.id === "string" ? raw.id : typeof raw.agentId === "string" ? raw.agentId : undefined;
  };
  pi.events.on("subagents:completed", (data) => {
    const agent = agentOf(data);
    if (agent) release(agent, String((data as { status?: unknown }).status ?? "completed"));
  });
  pi.events.on("subagents:failed", (data) => {
    const agent = agentOf(data);
    if (agent) release(agent, "failed");
  });
  pi.events.on("subagents:resumed", (data) => {
    const agent = agentOf(data);
    if (agent) release(agent, String((data as { status?: unknown }).status ?? "completed"));
  });
  pi.events.on("subagents:child:disposed", (data) => {
    const agent = agentOf(data);
    if (agent) release(agent, "ended");
  });
  pi.events.on("subagents:resuming", (data) => {
    const agent = agentOf(data);
    const last = agent ? ended.get(agent) : undefined;
    if (!agent || !last || host.claims().has(agent)) return;
    const holders = held();
    const present = new Set(host.state().tasks.map((task) => task.key));
    const keys = last.keys.filter((key) => present.has(key) && !holders.has(key));
    if (keys.length) host.journalClaims({ op: "claim", agent, session: last.session, scope: last.scope, keys, at: host.now() });
  });

  /** Call the parent's broker; its refusals and absence become tool errors here. */
  const remote = <R>(fn: (broker: TodoBroker) => R): R => {
    const link = delegated!;
    const result = call<TodoBroker, R>(link.parent, BROKER_NAME, fn);
    if (result.ok) return result.value;
    if (result.reason === "missing") throw new TodoValidationError("the parent session's task list is not available");
    throw new TodoValidationError(errorText(result.error));
  };

  return {
    /** Offer the broker, then look for this session's own claim in its parent. */
    start(sessionId: string, replayedClaims: TodoClaims) {
      withdraw?.();
      withdraw = provide(sessionId, BROKER_NAME, broker);
      pending.clear();
      lastChange.clear();
      // Claims replayed on session start or tree navigation cannot safely carry
      // into the new branch, even if the child session still exists.
      for (const agent of [...replayedClaims.keys()]) release(agent, "session ended");
      // An agent from another branch must not reclaim keys on a later resume.
      ended.clear();
      delegated = undefined;
      const parent = parentOf(sessionId);
      const agent = node(sessionId)?.agentId;
      if (parent && agent) {
        const claim = call<TodoBroker, ReturnType<TodoBroker["claim"]>>(parent, BROKER_NAME, (parentBroker) => parentBroker.claim(agent));
        if (claim.ok && claim.value) delegated = { parent, agent, scope: claim.value.scope };
      }
    },
    stop() {
      withdraw?.();
      withdraw = undefined;
      delegated = undefined;
      pending.clear();
    },
    /** Record which keys a change touched, for per-key stale checks. */
    changed(details: TodoDetails) {
      for (const key of [...details.change.added, ...details.change.updated, ...details.change.removed]) lastChange.set(key, details.revision);
    },
    delegated: () => delegated,
    view: () => remote((parentBroker) => parentBroker.view(delegated!.agent)),
    mutate: (request: TodoRequest) => remote((parentBroker) => parentBroker.mutate(delegated!.agent, request)),
  };
}

export type TodoDelegation = ReturnType<typeof createTodoDelegation>;
