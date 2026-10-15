import { createHash } from "node:crypto";

export type Gate = {
  id: string;
  title?: string;
  kind: "command" | "human";
  command?: string[];
  every_minutes?: number;
  timeout_seconds?: number;
};

export type Step = {
  id: string;
  title: string;
  depends_on?: string[];
  work?: { kind: "agent" | "manual" | "none"; instructions?: string; agent?: string };
  gates?: Gate[];
};

export type CampaignPlan = {
  id: string;
  title: string;
  goal: string;
  steps: Step[];
  settings?: {
    reconcile_minutes?: number;
    allow_commands?: boolean;
    auto_merge?: boolean;
    max_review_rounds?: number;
    notifications?: { pi?: boolean; slack_webhook_env?: string };
    command_env?: string[];
  };
};

export type GateResult = {
  status: "passed" | "waiting" | "blocked";
  at: string;
  detail?: string;
  evidence?: unknown;
  consecutive_errors?: number;
  transient_error?: boolean;
  definition_hash?: string;
  actor?: "script" | "human" | "model";
};

export type StepState = {
  status: "pending" | "ready" | "waiting" | "blocked" | "done";
  work_complete: boolean;
  facts: Record<string, unknown>;
  gates: Record<string, GateResult>;
  question?: string;
};

export type CampaignState = {
  revision: number;
  paused: boolean;
  steps: Record<string, StepState>;
  history: { at: string; kind: string; step?: string; detail: string }[];
};

const slug = /^[a-z][a-z0-9-]{0,63}$/;
const stamp = () => new Date().toISOString();
export const gateHash = (gate: Gate): string => createHash("sha256").update(JSON.stringify(gate)).digest("hex");
const factsObject = (facts: unknown): facts is Record<string, unknown> =>
  !!facts && typeof facts === "object" && !Array.isArray(facts) && Object.keys(facts).length > 0;

export function validatePlan(plan: CampaignPlan): void {
  if (!plan || typeof plan !== "object" || !slug.test(plan.id ?? "") || !plan.title?.trim() || !plan.goal?.trim()) {
    throw new Error("Campaign requires an id (lowercase slug), title, and goal");
  }
  if (!Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 200) {
    throw new Error("Campaign needs 1-200 steps");
  }
  const nodes = new Map<string, Step>();
  for (const s of plan.steps) {
    if (!s || typeof s !== "object" || !slug.test(s.id ?? "") || typeof s.title !== "string" || !s.title.trim() || nodes.has(s.id)) throw new Error("Invalid or duplicate step id: " + s?.id);
    if (s.work && (!s.work || typeof s.work !== "object" || !["agent", "manual", "none"].includes(s.work.kind))) throw new Error("Invalid work kind on " + s.id);
    if (s.gates !== undefined && !Array.isArray(s.gates)) throw new Error("Invalid gates on " + s.id);
    const gates = new Set<string>();
    for (const g of s.gates ?? []) {
      if (!g || typeof g !== "object" || !slug.test(g.id ?? "") || gates.has(g.id)) throw new Error("Invalid or duplicate gate id: " + g?.id);
      gates.add(g.id);
      if (!["command", "human"].includes(g.kind)) throw new Error("Invalid gate kind: " + g.id);
      if (g.kind === "command" && (!Array.isArray(g.command) || g.command.length === 0 || g.command.some(c => typeof c !== "string" || !c.trim()))) {
        throw new Error("Command gates require nonempty argv array: " + g.id);
      }
      if (g.every_minutes !== undefined && (!Number.isFinite(g.every_minutes) || g.every_minutes < 1)) throw new Error("Invalid gate interval: " + g.id);
      if (g.timeout_seconds !== undefined && (!Number.isFinite(g.timeout_seconds) || g.timeout_seconds < 1 || g.timeout_seconds > 600)) throw new Error("Invalid gate timeout: " + g.id);
    }
    nodes.set(s.id, s);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error("Dependency cycle at " + id);
    if (visited.has(id)) return;
    const node = nodes.get(id);
    if (!node) throw new Error("Unknown dependency: " + id);
    visiting.add(id);
    for (const dep of node.depends_on ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of nodes.keys()) visit(id);
  const opts = plan.settings;
  if (opts?.reconcile_minutes !== undefined && (!Number.isInteger(opts.reconcile_minutes) || opts.reconcile_minutes < 1)) throw new Error("Invalid reconcile interval");
  if (opts?.max_review_rounds !== undefined && (!Number.isInteger(opts.max_review_rounds) || opts.max_review_rounds < 1)) throw new Error("Invalid review limit");
  if (opts?.allow_commands !== undefined && typeof opts.allow_commands !== "boolean") throw new Error("Invalid allow_commands setting");
  if (opts?.command_env !== undefined && (!Array.isArray(opts.command_env) || opts.command_env.some(name => typeof name !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(name) || name.startsWith("PI_CAMPAIGN_")))) throw new Error("Invalid command_env setting");
}

export function initialState(plan: CampaignPlan): CampaignState {
  validatePlan(plan);
  return {
    revision: 0, paused: true,
    steps: Object.fromEntries(plan.steps.map(s => [s.id, {
      status: "pending", work_complete: s.work?.kind === "none" || !s.work, facts: {}, gates: {}
    }])),
    history: [{ at: stamp(), kind: "created", detail: "Campaign created paused; review plan before resuming" }]
  };
}

export function reconcileGraph(plan: CampaignPlan, current: CampaignState): CampaignState {
  validatePlan(plan);
  const state = structuredClone(current);
  for (const s of plan.steps) {
    const old = state.steps[s.id];
    if (!old) { state.steps[s.id] = {status:"pending", work_complete: s.work?.kind === "none" || !s.work, facts: {}, gates: {}}; }
  }
  // Dependencies may appear after their dependents in YAML.
  const ordered: Step[] = [];
  const seen = new Set<string>();
  const byId = new Map(plan.steps.map(s => [s.id, s]));
  const visit = (s: Step) => { if (seen.has(s.id)) return; seen.add(s.id); for (const d of s.depends_on ?? []) visit(byId.get(d)!); ordered.push(s); };
  for (const s of plan.steps) visit(s);
  for (const s of ordered) {
    const st = state.steps[s.id];
    for (const g of s.gates ?? []) {
      if (st.gates[g.id] && st.gates[g.id].definition_hash !== gateHash(g)) delete st.gates[g.id];
    }
    if (!(s.depends_on ?? []).every(d => state.steps[d]?.status === "done")) {
      st.status = "pending";
    } else if (!st.work_complete) {
      st.status = "ready";
    } else {
      const gates = (s.gates ?? []).map(g => st.gates[g.id]?.status ?? "waiting");
      st.status = gates.includes("blocked") ? "blocked" : gates.every(g => g === "passed") ? "done" : "waiting";
    }
  }
  // Recorded work and gate evidence remains, but an invalidated gate also suspends dependents.
  return state;
}

export function recordWork(plan: CampaignPlan, current: CampaignState, step: string, facts: Record<string, unknown>): CampaignState {
  if (!plan.steps.some(s => s.id === step)) throw new Error("Unknown step: " + step);
  if (current.paused) throw new Error("Campaign paused");
  const state = structuredClone(current);
  const target = state.steps[step];
  if (target.status !== "ready") throw new Error("Step is not ready: " + step);
  if (!factsObject(facts)) throw new Error("Require evidence facts object for completed work");
  target.facts = { ...target.facts, ...facts };
  target.work_complete = true;
  state.revision++;
  state.history.push({ at: stamp(), kind: "work_recorded", step, detail: Object.keys(facts).join(", ") });
  return reconcileGraph(plan, state);
}

export function recordGate(plan: CampaignPlan, current: CampaignState, step: string, gate: string, result: GateResult, actor: "script" | "human" | "model"): CampaignState {
  const def = plan.steps.find(s => s.id === step);
  const check = def?.gates?.find(g => g.id === gate);
  if (!check) throw new Error("Unknown gate: " + step + "/" + gate);
  if (check.kind === "human" && actor === "script" || check.kind === "command" && actor !== "script" || actor === "model" && result.status === "passed") throw new Error("Gate actor mismatch");
  const state = structuredClone(current);
  if (state.paused) throw new Error("Campaign paused");
  const st = state.steps[step];
  if (!st.work_complete || !["waiting", "blocked"].includes(st.status)) throw new Error("Step is not waiting for gates");
  st.gates[gate] = { ...result, definition_hash: gateHash(check), actor };
  st.question = result.status === "blocked" ? result.detail : undefined;
  state.revision++;
  state.history.push({ at: result.at, kind: "gate_" + result.status, step, detail: actor + " " + gate + ": " + (result.detail ?? "") });
  return reconcileGraph(plan, state);
}

export function changePause(state: CampaignState, paused: boolean): CampaignState {
  const updated = structuredClone(state);
  if (updated.paused !== paused) {
    updated.paused = paused;
    updated.revision++;
    updated.history.push({at: stamp(),kind:paused?"paused":"resumed",detail:"Operator changed campaign scheduling"});
  }
  return updated;
}

export function describe(plan: CampaignPlan, state: CampaignState): string {
  const lines = [plan.title + (state.paused ? " [PAUSED]" : ""), plan.goal, ""];
  for (const s of plan.steps) {
    const st = state.steps[s.id];
    const remaining = (s.gates ?? []).filter(g => st.gates[g.id]?.status !== "passed").map(g => g.id);
    const disabled = !plan.settings?.allow_commands && (s.gates ?? []).some(g => g.kind === "command" && st.gates[g.id]?.status !== "passed");
    lines.push("[" + (st.status ?? "pending").padEnd(7) + "] " + s.id + " - " + s.title + (remaining.length ? " | gates: " + remaining.join(", ") : "") + (disabled ? " | commands disabled" : ""));
    if (st.question) lines.push("  blocked: " + st.question);
  }
  return lines.join("\n");
}

/** Clear an unresolved gate's observation without granting an approval. */
export function retryGate(plan: CampaignPlan, current: CampaignState, step: string, gate: string, reason: string, actor: "human" | "model" = "human"): CampaignState {
  const def = plan.steps.find(s => s.id === step);
  if (!def?.gates?.some(g => g.id === gate)) throw new Error("Unknown gate: " + step + "/" + gate);
  const state = structuredClone(current);
  const target = state.steps[step];
  if (!["waiting", "blocked"].includes(target.status)) throw new Error("Only unresolved gates may be retried");
  if (!reason.trim()) throw new Error("Retry requires a reason");
  if (actor === "model" && (target.gates[gate]?.actor === "human" || def.gates.find(g => g.id === gate)?.kind === "human")) throw new Error("Operator must retry a human gate");
  delete target.gates[gate];
  target.question = undefined;
  state.revision++;
  state.history.push({at: stamp(), kind: "gate_retry_requested", step, detail: actor + " " + gate + ": " + reason});
  return reconcileGraph(plan, state);
}

/** Attach discovered external identifiers to a still-open step. Never marks a gate passed. */
export function setFacts(plan: CampaignPlan, current: CampaignState, step: string, facts: Record<string, unknown>): CampaignState {
  if (!plan.steps.some(s => s.id === step)) throw new Error("Unknown step: " + step);
  if (!factsObject(facts)) throw new Error("Nonempty facts object required");
  const state = structuredClone(current);
  const target = state.steps[step];
  if (target.status === "done") throw new Error("Cannot change facts on completed step");
  target.facts = { ...target.facts, ...facts };
  state.revision++;
  state.history.push({at: stamp(), kind: "facts_updated", step, detail: Object.keys(facts).join(", ")});
  return reconcileGraph(plan, state);
}
