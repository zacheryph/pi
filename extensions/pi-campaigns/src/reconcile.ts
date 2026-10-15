import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import {
  type CampaignPlan, type CampaignState, type Gate, type GateResult,
  changePause, reconcileGraph, recordGate
} from "./engine.ts";
import { loadCampaign, saveState } from "./storage.ts";

const at = () => new Date().toISOString();
const MAX_OUTPUT = 8192;

export type GateRunner = (
  gate: Gate, context: { campaign: string; step: string; workspace: string; facts: Record<string, unknown> },
  signal?: AbortSignal
) => Promise<GateResult>;

export const runCommandGate: GateRunner = (gate, context, signal) => new Promise(resolveResult => {
  if (gate.kind !== "command" || !gate.command?.length) throw new Error("Not a command gate");
  const workspace = isAbsolute(context.workspace) ? context.workspace : resolve(context.workspace);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CAMPAIGN_ID: context.campaign,
    PI_CAMPAIGN_STEP_ID: context.step,
    PI_CAMPAIGN_GATE_ID: gate.id,
    PI_CAMPAIGN_FACTS_JSON: JSON.stringify(context.facts)
  };
  const child = spawn(gate.command[0], gate.command.slice(1), {
    cwd: workspace, env, shell: false, stdio: ["ignore", "pipe", "pipe"],
    signal
  });
  let output = "";
  let error = "";
  let finished = false;
  const limit = (gate.timeout_seconds ?? 45) * 1000;
  const timeout = setTimeout(() => child.kill("SIGKILL"), limit);
  const push = (kind: "out" | "err", chunk: Buffer) => {
    if (kind === "out") output = (output + chunk.toString("utf8")).slice(0, MAX_OUTPUT);
    else error = (error + chunk.toString("utf8")).slice(0, MAX_OUTPUT);
  };
  child.stdout?.on("data", (data: Buffer) => push("out", data));
  child.stderr?.on("data", (data: Buffer) => push("err", data));
  const end = (status: GateResult["status"], detail: string, evidence?: unknown) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    resolveResult({ status, at: at(), detail: detail.slice(0, 1000), evidence });
  };
  child.on("error", (err: Error) => end("blocked", "Gate process error: " + err.message));
  child.on("close", code => {
    if (finished) return;
    let parsed: {status?: string; detail?: string; evidence?: unknown } = {};
    try { parsed = JSON.parse(output); } catch { /* plain-text output is supported */ }
    let status: GateResult["status"];
    if (code === 0) status = "passed";
    else if (code === 3) status = "waiting";
    else status = "blocked";
    // An explicit JSON status may only reduce a successful exit's authority.
    if (code === 0 && ["waiting", "blocked"].includes(parsed.status ?? "")) status = parsed.status as GateResult["status"];
    const detail = typeof parsed.detail === "string" ? parsed.detail : (output || error || ("exit code " + code));
    end(status, detail, parsed.evidence);
  });
});

const active = new Map<string, AbortController>();
export function stopCampaignChecks(id: string): void { active.get(id)?.abort(); }
export function checkingIds(): string[] { return [...active.keys()]; }

export async function reconcileCampaign(
  id: string, runner: GateRunner = runCommandGate, signal?: AbortSignal
): Promise<{ plan: CampaignPlan; state: CampaignState; changed: boolean }> {
  if (active.has(id)) throw new Error("Campaign already reconciling: " + id);
  const controller = new AbortController();
  active.set(id, controller);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const loaded = loadCampaign(id);
    const plan = loaded.plan;
    let state = reconcileGraph(plan, loaded.state);
    if (state.paused) return { plan, state, changed: false };
    const before = state.revision;
    for (const step of plan.steps) {
      if (controller.signal.aborted) break;
      const st = state.steps[step.id];
      if (st.status !== "waiting" || !st.work_complete) continue;
      for (const gate of step.gates ?? []) {
        if (controller.signal.aborted) break;
        if (gate.kind !== "command") continue;
        if (!plan.settings?.allow_commands) continue;
        const prior = st.gates[gate.id];
        if (prior?.status === "passed") continue;
        const age = prior ? Date.now() - Date.parse(prior.at) : Infinity;
        if (age < (gate.every_minutes ?? plan.settings?.reconcile_minutes ?? 15) * 60000) continue;
        const result = await runner(gate, {
          campaign: plan.id, step: step.id,
          workspace: loaded.plan.workspace ?? process.cwd(), facts: st.facts
        }, controller.signal);
        if (controller.signal.aborted) break;
        state = recordGate(plan, state, step.id, gate.id, result, "script");
        saveState(id, state); // checkpoint every observation
      }
    }
    return { plan, state, changed: state.revision !== before };
  } finally {
    signal?.removeEventListener("abort", abort);
    active.delete(id);
  }
}

export function setCampaignPaused(id: string, paused: boolean): CampaignState {
  if (paused) stopCampaignChecks(id);
  const { state } = loadCampaign(id);
  const next = changePause(state, paused);
  saveState(id, next);
  return next;
}
