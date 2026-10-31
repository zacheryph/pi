/**
 * Process-wide registry of live Pi sessions, their parent links, and the
 * services each extension offers them.
 *
 * Subagents are in-process child sessions. Every session has its own extension
 * closures, `pi.events` bus and JSONL, and module scope is shared only some of
 * the time (Pi caches an extension's module per cwd until a reload). The one
 * channel every copy of every extension sees is `globalThis`, so the registry
 * lives there under a versioned `Symbol.for` key.
 *
 * Links come from pi-subagents' `subagents:child:session-created` event, which
 * fires synchronously on the parent's bus before the child binds its
 * extensions. A child's `session_start` handlers therefore always find their
 * parent link.
 */

export const SESSION_TREE_KEY = Symbol.for("pi-personal.session-tree.v1");
export const SESSION_TREE_VERSION = 1;

/** pi-subagents lifecycle channels this registry follows (on the parent's bus). */
export const CHILD_SESSION_CREATED = "subagents:child:session-created";
export const CHILD_SESSION_DISPOSED = "subagents:child:disposed";

/** What a parent handed a child at spawn. Opaque to pi-subagents. */
export interface Handoff {
  todos?: { keys: string[]; scope: "assigned" | "ledger" };
  [key: string]: unknown;
}

interface ServiceEntry {
  token: object;
  api: unknown;
}

export interface SessionNode {
  readonly id: string;
  /** Parent session id; absent for a top-level session. */
  parent?: string;
  /** pi-subagents record id; stable across resume. */
  agentId?: string;
  handoff?: Handoff;
  services: Map<string, ServiceEntry>;
}

export interface SessionTree {
  version: typeof SESSION_TREE_VERSION;
  nodes: Map<string, SessionNode>;
}

export interface ChildLink {
  parent?: string;
  agentId?: string;
  handoff?: Handoff;
}

export type CallResult<R> =
  | { ok: true; value: R }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "error"; error: unknown };

/** Minimal slice of `ExtensionAPI` needed to follow child sessions. */
export interface EventSource {
  events: { on(channel: string, handler: (data: unknown) => void): () => void };
}

function compatible(value: unknown): value is SessionTree {
  const tree = value as Partial<SessionTree> | null;
  return !!tree && tree.version === SESSION_TREE_VERSION && tree.nodes instanceof Map;
}

/**
 * The registry, created on first use. A value under the key with another shape
 * (a stale or foreign module) is replaced rather than trusted.
 */
export function sessionTree(): SessionTree {
  const slots = globalThis as Record<symbol, unknown>;
  const existing = slots[SESSION_TREE_KEY];
  if (compatible(existing)) return existing;
  const created: SessionTree = { version: SESSION_TREE_VERSION, nodes: new Map() };
  slots[SESSION_TREE_KEY] = created;
  return created;
}

function nodeFor(id: string, tree: SessionTree): SessionNode {
  let node = tree.nodes.get(id);
  if (!node) {
    node = { id, services: new Map() };
    tree.nodes.set(id, node);
  }
  return node;
}

/** Record (or update) a child's link. Fields left out keep their values. */
export function link(child: string, info: ChildLink, tree = sessionTree()): SessionNode {
  const node = nodeFor(child, tree);
  if (info.parent !== undefined && info.parent !== child) node.parent = info.parent;
  if (info.agentId !== undefined) node.agentId = info.agentId;
  if (info.handoff !== undefined) node.handoff = info.handoff;
  return node;
}

/** Drop a session's node, links and services. Its children keep their parent id. */
export function forget(id: string, tree = sessionTree()): void {
  tree.nodes.delete(id);
}

export function node(id: string, tree = sessionTree()): SessionNode | undefined {
  return tree.nodes.get(id);
}

/**
 * Offer `api` to other sessions under `name` for session `id`. Call on
 * `session_start`; call the returned disposer on `session_shutdown`. A later
 * provide (after a reload) replaces the entry, and the old disposer then does
 * nothing.
 */
export function provide(id: string, name: string, api: unknown, tree = sessionTree()): () => void {
  const token = {};
  nodeFor(id, tree).services.set(name, { token, api });
  return () => {
    const current = tree.nodes.get(id);
    if (current?.services.get(name)?.token === token) current.services.delete(name);
  };
}

/** The live API `name` offers for session `id`, if any. */
export function service<T>(id: string, name: string, tree = sessionTree()): T | undefined {
  return tree.nodes.get(id)?.services.get(name)?.api as T | undefined;
}

/**
 * Call into another session's service without letting its failure become the
 * caller's: a missing service or a throwing call (for example a runtime made
 * stale by a reload) comes back as a result.
 */
export function call<T, R>(id: string, name: string, fn: (api: T) => R, tree = sessionTree()): CallResult<R> {
  const api = service<T>(id, name, tree);
  if (api === undefined) return { ok: false, reason: "missing" };
  try {
    return { ok: true, value: fn(api) };
  } catch (error) {
    return { ok: false, reason: "error", error };
  }
}

export function parentOf(id: string, tree = sessionTree()): string | undefined {
  return tree.nodes.get(id)?.parent;
}

/** Ancestor ids, nearest first. The parent is included even without a node of its own. */
export function ancestors(id: string, tree = sessionTree()): string[] {
  const out: string[] = [];
  const seen = new Set([id]);
  let current = parentOf(id, tree);
  while (current !== undefined && !seen.has(current)) {
    out.push(current);
    seen.add(current);
    current = parentOf(current, tree);
  }
  return out;
}

/** Top of `id`'s chain (`id` itself for a top-level session). */
export function root(id: string, tree = sessionTree()): string {
  return ancestors(id, tree).at(-1) ?? id;
}

/** Direct children with a live node. */
export function children(id: string, tree = sessionTree()): string[] {
  return [...tree.nodes.values()].filter((candidate) => candidate.parent === id).map((candidate) => candidate.id);
}

/** Every descendant, breadth first. */
export function descendants(id: string, tree = sessionTree()): string[] {
  const out: string[] = [];
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    for (const child of children(queue.shift()!, tree)) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

const text = (value: unknown, max = 256): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;

function readHandoff(value: unknown): Handoff | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Handoff;
}

/**
 * Follow this session's children: link each one as pi-subagents creates it and
 * forget it once disposed. Call from the extension factory so the subscription
 * exists before any spawn. Several extensions may call it for the same session;
 * linking is idempotent. Returns the unsubscriber (Pi also drops bus
 * subscriptions itself on reload).
 */
export function trackChildren(pi: EventSource, tree = sessionTree()): () => void {
  const offCreated = pi.events.on(CHILD_SESSION_CREATED, (data) => {
    const raw = (data ?? {}) as Record<string, unknown>;
    const child = text(raw.sessionId);
    if (!child) return;
    link(child, { parent: text(raw.parentSessionId), agentId: text(raw.agentId), handoff: readHandoff(raw.handoff) }, tree);
  });
  const offDisposed = pi.events.on(CHILD_SESSION_DISPOSED, (data) => {
    const child = text((data as Record<string, unknown> | null)?.sessionId);
    if (child) forget(child, tree);
  });
  return () => {
    offCreated();
    offDisposed();
  };
}
