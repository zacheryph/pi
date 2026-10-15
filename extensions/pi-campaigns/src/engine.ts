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
  };
};

export type GateResult = {
  status: "passed" | "waiting" | "blocked";
  at: string;
  detail?: string;
  evidence?: unknown;
  consecutive_errors?: number;
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

export function validatePlan(plan: CampaignPlan): void {
  if (!plan || typeof plan !== "object" || !slug.test(plan.id ?? "") || !plan.title?.trim() || !plan.goal?.trim()) {
    throw new Error("Campaign requires an id (lowercase slug), title, and goal");
  }
  if (!Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 200) {
    throw new Error("Campaign needs 1-200 steps");
  }
  const nodes = new Map<string, Step>();
  for (const s of plan.steps) {
    if (!slug.test(s.id ?? "") || !s.title?.trim() || nodes.has(s.id)) throw new Error("Invalid or duplicate step id: " + s.id);
    if (s.work && !["agent", "manual", "none"].includes(s.work.kind)) throw new Error("Invalid work kind on " + s.id);
    const gates = new Set<string>();
    for (const g of s.gates ?? []) {
      if (!slug.test(g.id ?? "") || gates.has(g.id)) throw new Error("Invalid or duplicate gate id: " + g.id);
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
  for (const s of plan.steps) {
    const st = state.steps[s.id];
    if (st.status === "done") continue;
    if (!(s.depends_on ?? []).every(d => state.steps[d]?.status === "done")) {
      st.status = "pending";
    } else if (!st.work_complete) {
      st.status = "ready";
    } else {
      const gates = (s.gates ?? []).map(g => st.gates[g.id]?.status ?? "waiting");
      st.status = gates.includes("blocked") ? "blocked" : gates.every(g => g === "passed") ? "done" : "waiting";
    }
  }
  // Retained completed steps are intentionally not invalidated by a plan revision.
  // Reopening an affected step is an explicit operator action, not a side effect.
  return state;
}

export function recordWork(plan: CampaignPlan, current: CampaignState, step: string, facts: Record<string, unknown>): CampaignState {
  if (!plan.steps.some(s => s.id === step)) throw new Error("Unknown step: " + step);
  if (current.paused) throw new Error("Campaign paused");
  const state = structuredClone(current);
  const target = state.steps[step];
  if (target.status !== "ready") throw new Error("Step is not ready: " + step);
  if (!facts || typeof facts !== "object" || !Object.keys(facts).length) throw new Error("Require evidence facts for completed work");
  target.facts = { ...target.facts, ...facts };
  target.work_complete = true;
  state.revision++;
  state.history.push({ at: stamp(), kind: "work_recorded", step, detail: Object.keys(facts).join(", ") });
  return reconcileGraph(plan, state);
}

export function recordGate(plan: CampaignPlan, current: CampaignState, step: string, gate: string, result: GateResult, actor: "script" | "human"): CampaignState {
  const def = plan.steps.find(s => s.id === step);
  const check = def?.gates?.find(g => g.id === gate);
  if (!check) throw new Error("Unknown gate: " + step + "/" + gate);
  if (check.kind === "human" && actor !== "human" || check.kind === "command" && actor !== "script") throw new Error("Gate actor mismatch");
  const state = structuredClone(current);
  if (state.paused) throw new Error("Campaign paused");
  const st = state.steps[step];
  if (!st.work_complete || !["waiting", "blocked"].includes(st.status)) throw new Error("Step is not waiting for gates");
  if (st.status === "done") throw new Error("Step already complete");
  st.gates[gate] = result;
  st.question = result.status === "blocked" ? result.detail : undefined;
  state.revision++;
  state.history.push({ at: result.at, kind: "gate_" + result.status, step, detail: gate + ": " + (result.detail ?? "") });
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
    lines.push("[" + (st.status ?? "pending").padEnd(7) + "] " + s.id + " - " + s.title + (remaining.length ? " | gates: " + remaining.join(", ") : ""));
    if (st.question) lines.push("  blocked: " + st.question);
  }
  return lines.join("\n");
}

/** Clear an unresolved gate's observation without granting an approval. */
export function retryGate(plan: CampaignPlan, current: CampaignState, step: string, gate: string, reason: string): CampaignState {
  const def = plan.steps.find(s => s.id === step);
  if (!def?.gates?.some(g => g.id === gate)) throw new Error("Unknown gate: " + step + "/" + gate);
  const state = structuredClone(current);
  const target = state.steps[step];
  if (!["waiting", "blocked"].includes(target.status)) throw new Error("Only unresolved gates may be retried");
  if (!reason.trim()) throw new Error("Retry requires a reason");
  delete target.gates[gate];
  target.question = undefined;
  state.revision++;
  state.history.push({at: stamp(), kind: "gate_retry_requested", step, detail: gate + ": " + reason});
  return reconcileGraph(plan, state);
}

/** Attach discovered external identifiers to a still-open step. Never marks a gate passed. */
export function setFacts(plan: CampaignPlan, current: CampaignState, step: string, facts: Record<string, unknown>): CampaignState {
  if (!plan.steps.some(s => s.id === step)) throw new Error("Unknown step: " + step);
  if (!facts || typeof facts !== "object" || Array.isArray(facts) || !Object.keys(facts).length) throw new Error("Nonempty facts object required");
  const state = structuredClone(current);
  const target = state.steps[step];
  if (target.status === "done") throw new Error("Cannot change facts on completed step");
  target.facts = { ...target.facts, ...facts };
  state.revision++;
  state.history.push({at: stamp(), kind: "facts_updated", step, detail: Object.keys(facts).join(", ")});
  return reconcileGraph(plan, state);
}
