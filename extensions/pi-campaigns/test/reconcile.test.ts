import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { recordGate, reconcileGraph, type CampaignPlan } from "../src/engine.ts";
import { createCampaign, loadCampaign, replacePlan, saveState } from "../src/storage.ts";
import { reconcileCampaign, runCommandGate, setCampaignPaused } from "../src/reconcile.ts";

const folder = mkdtempSync(join(tmpdir(), "pi-campaign-test-"));
before(() => { process.env.PI_CAMPAIGNS_DIR = folder; });
after(() => { delete process.env.PI_CAMPAIGNS_DIR; rmSync(folder, { recursive: true, force: true }); });

const plan = (id: string): CampaignPlan => ({
  id, title: "Network cutover", goal: "Move traffic",
  settings: { allow_commands: true, reconcile_minutes: 1 },
  steps: [
    { id: "pr", title: "PR ready", work: { kind: "none" },
      gates: [{id:"check",kind:"command",command:[process.execPath,"-e","process.stdout.write(JSON.stringify({status:'passed',detail:'ok'}))"]}] },
    { id: "apply", title: "Apply", depends_on: ["pr"], work: { kind: "none" },
      gates: [{id:"check",kind:"human"}] }
  ]
});

test("create, persist, reopen and revise plan using YAML with revision guard", () => {
  createCampaign(stringify(plan("persist")), folder, "operator");
  assert.equal(loadCampaign("persist").state.paused, true);
  assert.throws(() => createCampaign(stringify(plan("persist")), folder, "operator"), /exists/);
  assert.throws(() => replacePlan("persist", stringify(plan("persist")), 12), /Stale/);
  const p = plan("persist");
  p.steps.push({id:"cleanup",title:"Cleanup",depends_on:["apply"],work:{kind:"manual"}});
  replacePlan("persist", stringify(p), 0);
  assert.equal(loadCampaign("persist").plan.steps.length, 3);
  assert.equal(loadCampaign("persist").state.revision, 1);
});

test("reconcile performs checks without model calls and unlocks downstream gates", async () => {
  createCampaign(stringify(plan("checks")), folder, "operator");
  setCampaignPaused("checks", false);
  const first = await reconcileCampaign("checks");
  assert.equal(first.state.steps.pr.status, "done");
  assert.equal(first.state.steps.apply.status, "waiting");
  assert.equal(first.state.steps.pr.gates.check?.detail, "ok");
  const second = await reconcileCampaign("checks");
  assert.equal(second.changed, false);
  assert.equal(loadCampaign("checks").state.steps.pr.status, "done");
});

test("command gates use argv (no shell) and document exit code semantics", async () => {
  const gate = {id:"sample",kind:"command" as const,command:[process.execPath,"-e","process.exit(3)"]};
  const result = await runCommandGate(gate, {campaign:"x",step:"x",workspace:folder,facts:{}});
  assert.equal(result.status, "waiting");
  const blocked = await runCommandGate({...gate,command:[process.execPath,"-e","process.exit(5)"]},
    {campaign:"x",step:"x",workspace:folder,facts:{}});
  assert.equal(blocked.status, "blocked");
});

test("reconcile refuses to run command gates unless campaign settings allow them", async () => {
  const p = plan("disabled"); p.settings!.allow_commands = false;
  createCampaign(stringify(p), folder);
  setCampaignPaused("disabled", false);
  const result = await reconcileCampaign("disabled");
  assert.equal(result.state.steps.pr.status, "waiting");
  assert.equal(result.state.steps.pr.gates.check, undefined);
});

test("state file remains a durable source of truth across loads", () => {
  createCampaign(stringify(plan("history")), folder, "operator");
  const before = loadCampaign("history").state;
  const next = structuredClone(before);
  next.history.push({at:new Date().toISOString(),kind:"note",detail:"recorded"});
  saveState("history",next);
  assert.equal(loadCampaign("history").state.history.at(-1)?.detail, "recorded");
});

test("model cannot create enabled commands or remove approval in a revision", () => {
  const p = plan("permissions");
  assert.throws(() => createCampaign(stringify(p), folder), /Operator must enable/);
  p.settings!.allow_commands = false;
  createCampaign(stringify(p), folder);
  const noApproval = structuredClone(p);
  noApproval.steps[1].gates = [];
  assert.throws(() => replacePlan("permissions", stringify(noApproval), 0), /human gate/);
  const enabled = structuredClone(p);
  enabled.settings!.allow_commands = true;
  assert.throws(() => replacePlan("permissions", stringify(enabled), 0), /command permissions/);
  replacePlan("permissions", stringify(enabled), 0, "operator");
  assert.equal(loadCampaign("permissions").plan.settings?.allow_commands, true);
  const changedCommand = structuredClone(enabled);
  changedCommand.steps[0].gates![0].command = ["/bin/false"];
  assert.throws(() => replacePlan("permissions", stringify(changedCommand), 1), /active command gates/);
});

test("changed command definition invalidates a recorded pass", async () => {
  const p = plan("changed-gate");
  createCampaign(stringify(p), folder, "operator");
  setCampaignPaused(p.id, false);
  await reconcileCampaign(p.id);
  assert.equal(loadCampaign(p.id).state.steps.pr.status, "done");
  const revision = loadCampaign(p.id).state.revision;
  const changed = structuredClone(p);
  changed.steps[0].gates![0].command = [process.execPath, "-e", "process.exit(3)"];
  assert.throws(() => replacePlan(p.id, stringify(changed), revision), /active command gates/);
  // Direct operator edits are picked up too, and stale evidence cannot pass a changed gate.
  writeFileSync(join(folder, p.id, "campaign.yaml"), stringify(changed));
  assert.equal(loadCampaign(p.id).state.steps.pr.status, "waiting");
});

test("a completed check cannot overwrite a concurrent human decision", async () => {
  const p = plan("concurrent");
  p.steps.push({id:"review",title:"Review",work:{kind:"none"},gates:[{id:"approval",kind:"human"}]});
  createCampaign(stringify(p), folder, "operator");
  setCampaignPaused(p.id, false);
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  let finish!: (value: any) => void;
  const running = reconcileCampaign(p.id, async () => { started(); return new Promise(resolve => { finish = resolve; }); });
  await began;
  const { state } = loadCampaign(p.id);
  const approved = recordGate(p, state, "review", "approval", {status:"passed",at:new Date().toISOString()}, "human");
  saveState(p.id, approved);
  finish({status:"waiting",at:new Date().toISOString()});
  await running;
  const fresh = loadCampaign(p.id).state;
  assert.equal(fresh.steps.review.status, "done");
  assert.equal(fresh.steps.pr.gates.check, undefined);
  assert.equal(fresh.history.at(-1)?.kind, "gate_passed");
});

test("invalid state reports a validation error", () => {
  const p = plan("invalid-state");
  createCampaign(stringify(p), folder, "operator");
  const state = loadCampaign(p.id).state;
  delete (state.steps.pr as any).gates;
  saveState(p.id, state);
  assert.throws(() => loadCampaign(p.id), /Invalid state for step pr/);
});

test("interrupted plan revision recovers both files from journal", () => {
  const p = plan("journal");
  createCampaign(stringify(p), folder, "operator");
  const state = loadCampaign(p.id).state;
  const revised = structuredClone(p);
  revised.title = "Revised title";
  state.revision++;
  writeFileSync(join(folder, p.id, "revision.yaml"), stringify({plan:revised,state}));
  const recovered = loadCampaign(p.id);
  assert.equal(recovered.plan.title, "Revised title");
  assert.equal(recovered.state.revision, 1);
});

test("transient check errors block after three attempts", async () => {
  const p = plan("transient");
  createCampaign(stringify(p), folder, "operator");
  setCampaignPaused(p.id, false);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await reconcileCampaign(p.id, async () => ({status:"waiting",at:new Date(Date.now() - 120000).toISOString(),detail:"spawn failed",transient_error:true}));
    const state = loadCampaign(p.id).state;
    assert.equal(state.steps.pr.gates.check.consecutive_errors, attempt);
    assert.equal(state.steps.pr.status, attempt === 3 ? "blocked" : "waiting");
  }
});

test("command runner excludes ambient secrets unless explicitly allowed", async () => {
  process.env.CAMPAIGN_TEST_SECRET = "secret";
  const gate = {id:"env",kind:"command" as const,command:[process.execPath,"-e","console.log(JSON.stringify({detail:process.env.CAMPAIGN_TEST_SECRET || 'absent'}))"]};
  const context = {campaign:"x",step:"x",workspace:folder,facts:{}};
  assert.equal((await runCommandGate(gate, context)).detail, "absent");
  assert.equal((await runCommandGate(gate, {...context,commandEnv:["CAMPAIGN_TEST_SECRET"]})).detail, "secret");
  delete process.env.CAMPAIGN_TEST_SECRET;
});
