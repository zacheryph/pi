import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import {
  type CampaignPlan, type CampaignState, initialState, reconcileGraph, validatePlan
} from "./engine.ts";

export const campaignRoot = (): string => process.env.PI_CAMPAIGNS_DIR || join(homedir(), ".pi", "agent", "campaigns");

function safeId(id: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error("Invalid campaign id");
}
export const campaignDir = (id: string): string => {
  safeId(id);
  return join(campaignRoot(), id);
};
function saveAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + "." + process.pid + ".tmp";
  writeFileSync(temp, data, { flag: "w", mode: 0o600 });
  renameSync(temp, path);
}
function readYaml<T>(path: string): T {
  const doc = parse(readFileSync(path, "utf8"), { uniqueKeys: true });
  if (!doc || typeof doc !== "object") throw new Error("Expected YAML mapping at " + path);
  return doc as T;
}
export function savePlan(plan: CampaignPlan): void {
  validatePlan(plan);
  saveAtomic(join(campaignDir(plan.id), "campaign.yaml"), stringify(plan, { lineWidth: 110 }));
}
export function saveState(id: string, state: CampaignState): void {
  saveAtomic(join(campaignDir(id), "state.yaml"), stringify(state, { lineWidth: 110 }));
}
export function createCampaign(text: string, cwd: string, actor: "model" | "operator" = "model"): CampaignPlan {
  const plan = parse(text, { uniqueKeys: true }) as CampaignPlan & { workspace?: string };
  validatePlan(plan);
  if (actor === "model" && (plan.settings?.allow_commands || plan.settings?.command_env?.length)) throw new Error("Operator must enable commands and command_env after reviewing the plan");
  if (plan.workspace === undefined) plan.workspace = cwd;
  // No overwrite of an existing campaign. Import/revisions are intentionally separate.
  const dir = campaignDir(plan.id);
  if (existsSync(join(dir, "campaign.yaml"))) throw new Error("Campaign already exists: " + plan.id);
  savePlan(plan);
  saveState(plan.id, initialState(plan));
  return plan;
}
function recoverRevision(id: string): void {
  const path = join(campaignDir(id), "revision.yaml");
  if (!existsSync(path)) return;
  const pending = readYaml<{plan: CampaignPlan; state: CampaignState}>(path);
  validatePlan(pending.plan);
  validateState(pending.plan, pending.state);
  savePlan(pending.plan);
  saveState(id, pending.state);
  unlinkSync(path);
}

function validateState(plan: CampaignPlan, state: CampaignState): void {
  if (!state || !Number.isInteger(state.revision) || state.revision < 0 || typeof state.paused !== "boolean" ||
      !state.steps || typeof state.steps !== "object" || Array.isArray(state.steps) || !Array.isArray(state.history)) throw new Error("Invalid campaign state");
  for (const step of plan.steps) {
    const st = state.steps[step.id];
    if (!st) continue; // new step added by a plan revision
    if (typeof st !== "object" || !["pending", "ready", "waiting", "blocked", "done"].includes(st.status) ||
        typeof st.work_complete !== "boolean" || !st.facts || typeof st.facts !== "object" || Array.isArray(st.facts) ||
        !st.gates || typeof st.gates !== "object" || Array.isArray(st.gates)) throw new Error("Invalid state for step " + step.id);
    for (const result of Object.values(st.gates)) {
      if (!result || typeof result !== "object" || !["passed", "waiting", "blocked"].includes(result.status) || typeof result.at !== "string") throw new Error("Invalid gate result on " + step.id);
    }
  }
}
export function loadCampaign(id: string): { plan: CampaignPlan & { workspace?: string }; state: CampaignState } {
  recoverRevision(id);
  const plan = readYaml<CampaignPlan & { workspace?: string }>(join(campaignDir(id), "campaign.yaml"));
  validatePlan(plan);
  const state = readYaml<CampaignState>(join(campaignDir(id), "state.yaml"));
  validateState(plan, state);
  return { plan, state: reconcileGraph(plan, state) };
}
export function listCampaigns(): string[] {
  try {
    return readdirSync(campaignRoot(), { withFileTypes: true })
      .filter(e => e.isDirectory() && /^[a-z][a-z0-9-]{0,63}$/.test(e.name))
      .map(e => e.name).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
export function replacePlan(id: string, text: string, expectedRevision: number, actor: "model" | "operator" = "model"): CampaignPlan {
  const { state, plan: previous } = loadCampaign(id);
  if (state.revision !== expectedRevision) throw new Error("Stale revision; reload campaign before revising");
  const proposed = parse(text, { uniqueKeys: true }) as CampaignPlan & { workspace?: string };
  validatePlan(proposed);
  if (proposed.id !== id) throw new Error("Campaign id is immutable");
  if (!proposed.workspace) proposed.workspace = previous.workspace;
  if (actor === "model") {
    if (!!proposed.settings?.allow_commands !== !!previous.settings?.allow_commands ||
        JSON.stringify(proposed.settings?.command_env ?? []) !== JSON.stringify(previous.settings?.command_env ?? [])) throw new Error("Operator must change command permissions");
    for (const old of previous.steps) {
      const next = proposed.steps.find(s => s.id === old.id);
      if (!next) throw new Error("Operator must remove existing steps: " + old.id);
      if (JSON.stringify(old.depends_on ?? []) !== JSON.stringify(next.depends_on ?? []) || old.work?.kind !== next.work?.kind) throw new Error("Operator must change existing step dependencies or work kind: " + old.id);
      for (const gate of old.gates ?? []) {
        const replacement = next.gates?.find(g => g.id === gate.id);
        if (gate.kind === "human" && JSON.stringify(gate) !== JSON.stringify(replacement)) throw new Error("Operator must change human gate: " + old.id + "/" + gate.id);
      }
    }
    if (previous.settings?.allow_commands) {
      const commandDefs = (plan: CampaignPlan) => plan.steps.flatMap(step => (step.gates ?? [])
        .filter(gate => gate.kind === "command").map(gate => [step.id, gate]));
      if (JSON.stringify(commandDefs(previous)) !== JSON.stringify(commandDefs(proposed)) || proposed.workspace !== previous.workspace) {
        throw new Error("Operator must change active command gates or workspace");
      }
    }
  }
  const existing = new Set(proposed.steps.map(s => s.id));
  for (const s of previous.steps) {
    if (state.steps[s.id]?.status === "done" && !existing.has(s.id)) throw new Error("Cannot remove completed step: " + s.id);
    if (state.steps[s.id]?.status === "done" && JSON.stringify(s) !== JSON.stringify(proposed.steps.find(p => p.id === s.id))) throw new Error("Cannot change completed step: " + s.id);
  }
  const next = reconcileGraph(proposed, state);
  next.revision++;
  next.history.push({ at: new Date().toISOString(), kind: "plan_revised", detail: "Plan replaced at revision " + expectedRevision });
  const journal = join(campaignDir(id), "revision.yaml");
  saveAtomic(journal, stringify({ plan: proposed, state: next }, { lineWidth: 110 }));
  savePlan(proposed);
  saveState(id, next);
  unlinkSync(journal);
  return proposed;
}
