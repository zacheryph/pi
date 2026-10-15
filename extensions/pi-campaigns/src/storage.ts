import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
export function createCampaign(text: string, cwd: string): CampaignPlan {
  const plan = parse(text, { uniqueKeys: true }) as CampaignPlan & { workspace?: string };
  validatePlan(plan);
  if (plan.workspace === undefined) plan.workspace = cwd;
  // No overwrite of an existing campaign. Import/revisions are intentionally separate.
  const dir = campaignDir(plan.id);
  const { existsSync } = requireExists();
  if (existsSync(join(dir, "campaign.yaml"))) throw new Error("Campaign already exists: " + plan.id);
  savePlan(plan);
  saveState(plan.id, initialState(plan));
  return plan;
}
// Small wrapper keeps all filesystem usage concentrated in this module.
function requireExists(): { existsSync: (path: string) => boolean } {
  return { existsSync: (path: string) => {
    try { readFileSync(path); return true; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }};
}
export function loadCampaign(id: string): { plan: CampaignPlan & { workspace?: string }; state: CampaignState } {
  const plan = readYaml<CampaignPlan & { workspace?: string }>(join(campaignDir(id), "campaign.yaml"));
  validatePlan(plan);
  const state = readYaml<CampaignState>(join(campaignDir(id), "state.yaml"));
  if (typeof state.revision !== "number" || !state.steps || !Array.isArray(state.history)) throw new Error("Invalid campaign state");
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
export function replacePlan(id: string, text: string, expectedRevision: number): CampaignPlan {
  const { state, plan: previous } = loadCampaign(id);
  if (state.revision !== expectedRevision) throw new Error("Stale revision; reload campaign before revising");
  const proposed = parse(text, { uniqueKeys: true }) as CampaignPlan & { workspace?: string };
  validatePlan(proposed);
  if (proposed.id !== id) throw new Error("Campaign id is immutable");
  if (!proposed.workspace) proposed.workspace = previous.workspace;
  const existing = new Set(proposed.steps.map(s => s.id));
  for (const s of previous.steps) {
    if (state.steps[s.id]?.status === "done" && !existing.has(s.id)) throw new Error("Cannot remove completed step: " + s.id);
  }
  savePlan(proposed);
  const next = reconcileGraph(proposed, state);
  next.revision++;
  next.history.push({ at: new Date().toISOString(), kind: "plan_revised", detail: "Plan replaced at revision " + expectedRevision });
  saveState(id, next);
  return proposed;
}
