import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { parse, stringify } from "yaml";
import {
  changePause, describe, recordGate, recordWork, retryGate, setFacts,
  type CampaignPlan, type CampaignState
} from "./engine.ts";
import {
  campaignDir, createCampaign, listCampaigns, loadCampaign,
  replacePlan, saveState
} from "./storage.ts";
import {
  checkingIds, reconcileCampaign, setCampaignPaused, stopCampaignChecks
} from "./reconcile.ts";

const widgetKey = "pi-personal:campaigns";
const Parameters = Type.Object({
  action: StringEnum(["list", "create", "status", "revise", "start", "pause", "work_done", "approve", "retry_gate", "set_facts", "reconcile"] as const),
  id: Type.Optional(Type.String({ description: "Campaign id" })),
  yaml: Type.Optional(Type.String({ description: "Full YAML campaign plan for create/revise" })),
  expected_revision: Type.Optional(Type.Integer({ minimum: 0 })),
  step: Type.Optional(Type.String()),
  gate: Type.Optional(Type.String()),
  decision: Type.Optional(StringEnum(["passed", "blocked", "waiting"] as const)),
  detail: Type.Optional(Type.String()),
  facts: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const message = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
export const campaignSlug = (title: string): string => {
  const value = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50).replace(/-+$/g, "");
  return /^[a-z]/.test(value) ? value : "campaign-" + (value || "draft");
};

function mutate(id: string, fn: (plan: CampaignPlan, state: CampaignState) => CampaignState, expected?: number): CampaignState {
  const { plan, state } = loadCampaign(id);
  if (expected !== undefined && state.revision !== expected) throw new Error("Stale campaign revision: expected " + expected + " actual " + state.revision);
  const next = fn(plan, state);
  saveState(id, next);
  return next;
}

function display(id: string): string {
  const { plan, state } = loadCampaign(id);
  return describe(plan, state) + "\nrevision: " + state.revision + "\nplan: " + campaignDir(id) + "/campaign.yaml";
}

export default function campaignsExtension(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const refresh = () => {
    if (!context?.hasUI) return;
    const lines: string[] = [];
    for (const id of listCampaigns().slice(0, 8)) {
      try {
        const { plan, state } = loadCampaign(id);
        const done = plan.steps.filter(s => state.steps[s.id]?.status === "done").length;
        const blockers = plan.steps.filter(s => state.steps[s.id]?.status === "blocked").length;
        const running = checkingIds().includes(id);
        lines.push(" " + (running ? "⟳" : state.paused ? "Ⅱ" : "◦") + " " + id + "  " + done + "/" + plan.steps.length +
          (blockers ? "  ! " + blockers + " blocked" : "") + (state.paused ? "  paused" : ""));
      } catch { /* bad campaign never crashes the TUI */ }
    }
    context.ui.setWidget(widgetKey, lines.length ? ["── Campaigns", ...lines] : undefined, { placement: "aboveEditor" });
  };

  const reconcileAll = async () => {
    for (const id of listCampaigns()) {
      if (checkingIds().includes(id)) continue;
      try {
        const result = await reconcileCampaign(id);
        if (result.changed) {
          const blocked = result.plan.steps.filter(s => result.state.steps[s.id]?.status === "blocked");
          if (blocked.length && context?.hasUI) context.ui.notify(id + ": " + blocked.length + " gate(s) blocked; /campaigns " + id, "warning");
          refresh();
        }
      } catch (err) {
        if (context?.hasUI) context.ui.notify("Campaign " + id + ": " + String(err), "warning");
      }
    }
    refresh();
  };

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    context = ctx;
    refresh();
    if (!timer) {
      timer = setInterval(() => { void reconcileAll(); }, 60_000);
      timer.unref();
    }
  });
  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    for (const id of checkingIds()) stopCampaignChecks(id);
    if (context?.hasUI) context.ui.setWidget(widgetKey, undefined);
    context = undefined;
  });

  pi.registerTool({
    name: "campaign",
    label: "Campaigns",
    executionMode: "sequential",
    description: "Manage local multi-week YAML infrastructure campaigns. Never assume work is complete: record evidence and pass required gates. Reconciliation runs deterministic allowlisted commands, not an LLM. Creation starts PAUSED until user reviews the plan.",
    parameters: Parameters,
    async execute(_id, args, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Cancelled");
      try {
        const id = args.id;
        if (args.action === "list") return message(listCampaigns().join("\n") || "No campaigns.");
        if (args.action === "create") {
          if (!args.yaml) throw new Error("yaml required");
          const plan = createCampaign(args.yaml, ctx.cwd);
          refresh();
          return message(display(plan.id));
        }
        if (!id) throw new Error("id required");
        if (args.action === "status") return message(display(id));
        if (args.action === "revise") {
          if (!args.yaml || args.expected_revision === undefined) throw new Error("yaml and expected_revision required");
          replacePlan(id, args.yaml, args.expected_revision);
          refresh();
          return message(display(id));
        }
        if (args.action === "start") throw new Error("Operator must resume a campaign with /campaigns:resume after reviewing its plan");
        if (args.action === "pause") {
          const state = setCampaignPaused(id, true);
          refresh();
          return message("Campaign " + id + (state.paused ? " paused." : " resumed.") + "\n" + display(id));
        }
        if (args.action === "reconcile") {
          const result = await reconcileCampaign(id, undefined, signal);
          refresh();
          return message(describe(result.plan, result.state));
        }
        if (args.action === "set_facts") {
          if (!args.step || !args.facts) throw new Error("step and facts required");
          mutate(id, (plan, state) => setFacts(plan, state, args.step!, args.facts!), args.expected_revision);
          refresh();
          return message(display(id));
        }
        if (args.action === "work_done") {
          if (!args.step || !args.facts) throw new Error("step and facts required");
          mutate(id, (plan, state) => recordWork(plan, state, args.step!, args.facts!), args.expected_revision);
          refresh();
          return message(display(id));
        }
        if (args.action === "retry_gate") {
          if (!args.step || !args.gate || !args.detail) throw new Error("step, gate, and retry reason required");
          mutate(id, (plan, state) => retryGate(plan, state, args.step!, args.gate!, args.detail!, "model"), args.expected_revision);
          refresh();
          return message(display(id));
        }
        if (args.action === "approve") {
          if (!args.step || !args.gate || !args.decision || !args.detail) throw new Error("step, gate, decision, and detail required");
          if (args.decision === "passed") throw new Error("Model tool cannot approve human gates; use /campaigns:approve in TUI.");
          mutate(id, (plan, state) => recordGate(plan, state, args.step!, args.gate!, {
            status: args.decision!, at: new Date().toISOString(), detail: args.detail
          }, "model"), args.expected_revision);
          refresh();
          return message(display(id));
        }
        return message("Unsupported action");
      } catch (err) {
        return message("Campaign error: " + (err instanceof Error ? err.message : String(err)));
      }
    }
  });

  const command = (name: string, description: string, handler: (args: string, ctx: any) => Promise<void> | void) =>
    pi.registerCommand(name, { description, handler: async (args, ctx) => {
      try { await handler(args.trim(), ctx); }
      catch (err) { ctx.ui.notify(err instanceof Error ? err.message : String(err), "error"); }
    }});

  command("campaigns", "Show durable campaign progress: /campaigns [id]", (id, ctx) => {
    if (id) { ctx.ui.notify(display(id), "info"); return; }
    const entries = listCampaigns().map(name => { try { return display(name); } catch (err) { return name + ": " + String(err); } });
    ctx.ui.notify(entries.join("\n\n") || "No campaigns", "info");
  });

  command("campaigns:new", "Interview to scaffold a paused campaign", async (_args, ctx) => {
    if (!ctx.hasUI) throw new Error("Interactive TUI required");
    const title = await ctx.ui.input("Campaign title");
    if (!title?.trim()) return;
    const goal = await ctx.ui.input("Desired final state (what should be true when done)?");
    if (!goal?.trim()) return;
    const scope = await ctx.ui.input("Affected stacks/repositories/platforms");
    if (scope === undefined) return;
    const verification = await ctx.ui.input("How will we validate progress / health?");
    if (verification === undefined) return;
    const risk = await ctx.ui.input("Approval boundaries / rollback concerns");
    if (risk === undefined) return;
    const first = await ctx.ui.input("First concrete action or discovery task");
    if (!first?.trim()) return;
    const slug = campaignSlug(title);
    const plan: CampaignPlan = {
      id: slug, title, goal,
      settings: { reconcile_minutes: 15, allow_commands: false, auto_merge: false, max_review_rounds: 3, notifications: { pi: true } },
      steps: [
        { id: "discovery", title: first, work: { kind: "agent", instructions:
          "Scope: " + scope + "\nValidation: " + verification + "\nApproval and rollback: " + risk +
          "\nInterview further before implementation. Expand this YAML plan with verified dependencies, review gates, and validation scripts." },
          gates: [{ id: "plan-approved", kind: "human", title: "Human approves detailed plan" }] }
      ]
    };
    createCampaign(stringify(plan), ctx.cwd, "operator");
    refresh();
    ctx.ui.notify("Created paused campaign " + slug + ". Continue discussing scope and edit campaign.yaml; start after plan review.", "info");
  });

  command("campaigns:reconcile", "Run deterministic local gate checks: /campaigns:reconcile <id>", async (id, ctx) => {
    if (!id) throw new Error("Provide campaign id");
    const result = await reconcileCampaign(id);
    refresh();
    ctx.ui.notify(describe(result.plan, result.state), "info");
  });
  command("campaigns:pause", "Pause campaign scheduling", (id, ctx) => {
    if (!id) throw new Error("Provide campaign id");
    setCampaignPaused(id, true); refresh(); ctx.ui.notify(id + " paused", "info");
  });
  command("campaigns:resume", "Resume campaign scheduling", async (id, ctx) => {
    if (!id) throw new Error("Provide campaign id");
    if (!ctx.hasUI || !(await ctx.ui.confirm("Resume campaign?", display(id) + "\n\nChecks will run on their schedule."))) return;
    setCampaignPaused(id, false); refresh(); ctx.ui.notify(id + " resumed", "info");
  });
  command("campaigns:enable-commands", "Enable reviewed command checks", async (id, ctx) => {
    if (!id) throw new Error("Provide campaign id");
    const { plan, state } = loadCampaign(id);
    if (!ctx.hasUI || !(await ctx.ui.confirm("Enable campaign commands?", "Review " + campaignDir(id) + "/campaign.yaml and its command gates first. Scripts run in " + (plan.workspace ?? ctx.cwd)))) return;
    const next = structuredClone(plan);
    next.settings = { ...next.settings, allow_commands: true };
    replacePlan(id, stringify(next), state.revision, "operator");
    refresh(); ctx.ui.notify(id + " command checks enabled", "info");
  });
  command("campaigns:retry", "Retry blocked check: /campaigns:retry <id> <step> <gate>", (args, ctx) => {
    const [id, step, gate] = args.split(/\s+/);
    if (!id || !step || !gate) throw new Error("Usage: /campaigns:retry <id> <step> <gate>");
    mutate(id, (plan, state) => retryGate(plan, state, step, gate, "Retry requested by local operator"));
    refresh(); ctx.ui.notify("Queued gate for recheck: " + step + "/" + gate, "info");
  });
  command("campaigns:approve", "Pass a human gate: /campaigns:approve <id> <step> <gate>", async (args, ctx) => {
    const [id, step, gate] = args.split(/\s+/);
    if (!id || !step || !gate) throw new Error("Usage: /campaigns:approve <id> <step> <gate>");
    if (!ctx.hasUI || !(await ctx.ui.confirm("Pass human gate?", id + " / " + step + " / " + gate))) return;
    mutate(id, (plan, state) => recordGate(plan, state, step, gate,
      { status: "passed", detail: "Approved by local operator", at: new Date().toISOString() }, "human"));
    refresh(); ctx.ui.notify("Approved " + step + "/" + gate, "info");
  });
}
