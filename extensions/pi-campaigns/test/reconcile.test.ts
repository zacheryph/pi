import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { commandReview, recordGate, reconcileGraph, retryGate, setFacts, type CampaignPlan } from "../src/engine.ts";
import { createCampaign, loadCampaign, replacePlan, saveState } from "../src/storage.ts";
import { LOCK_STALE_MS, reconcileCampaign, runCommandGate, setCampaignPaused } from "../src/reconcile.ts";

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

test("model cannot remove an existing check while commands are disabled", () => {
  const p = plan("removal");
  p.settings!.allow_commands = false;
  createCampaign(stringify(p), folder);
  setCampaignPaused(p.id, false);
  const noCheck = structuredClone(p);
  noCheck.steps[0].gates = [];
  assert.throws(() => replacePlan(p.id, stringify(noCheck), 1), /remove existing gate: pr\/check/);
  assert.equal(loadCampaign(p.id).state.steps.pr.status, "waiting");
  const edited = structuredClone(p);
  edited.steps[0].gates![0].command = ["/bin/true"];
  edited.steps[0].gates!.push({ id: "extra", kind: "command", command: ["/bin/true"] });
  replacePlan(p.id, stringify(edited), 1);
  assert.deepEqual(loadCampaign(p.id).plan.steps[0].gates!.map(g => g.id), ["check", "extra"]);
  replacePlan(p.id, stringify(noCheck), 2, "operator");
  assert.equal(loadCampaign(p.id).state.steps.pr.status, "done");
});

test("command review lists every argv, the workspace and extra env names", () => {
  const p = plan("review");
  p.settings!.command_env = ["GH_TOKEN"];
  const text = commandReview(p, "/work/infra");
  assert.match(text, /Workspace: \/work\/infra/);
  assert.match(text, /Extra environment: GH_TOKEN/);
  assert.match(text, /Command gates \(1\):/);
  assert.ok(text.includes("pr/check: " + JSON.stringify(p.steps[0].gates![0].command)));
  assert.doesNotMatch(text, /apply\/check/);
  const none = plan("review-none");
  none.steps[0].gates = [];
  assert.match(commandReview(none, "/w"), /Command gates: none/);
  assert.match(commandReview(none, "/w"), /Extra environment: none/);
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
  const reopened = loadCampaign(p.id).state;
  assert.equal(reopened.steps.pr.status, "waiting");
  assert.equal(reopened.steps.apply.status, "pending");
});

test("a completed check keeps a concurrent human decision and its own result", async () => {
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
  assert.equal(fresh.steps.review.gates.approval?.actor, "human");
  // The unrelated approval no longer forces the check to be discarded and rerun.
  assert.equal(fresh.steps.pr.gates.check?.status, "waiting");
  assert.deepEqual(fresh.history.slice(-2).map(h => h.kind), ["gate_passed", "gate_waiting"]);
});

test("a check result is discarded when its own step changes while it runs", async () => {
  const p = plan("same-step");
  createCampaign(stringify(p), folder, "operator");
  setCampaignPaused(p.id, false);
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  let finish!: (value: any) => void;
  const running = reconcileCampaign(p.id, async () => { started(); return new Promise(resolve => { finish = resolve; }); });
  await began;
  const { plan: current, state } = loadCampaign(p.id);
  saveState(p.id, setFacts(current, state, "pr", { pr_number: 42 }));
  finish({ status: "passed", at: new Date().toISOString() });
  await running;
  const fresh = loadCampaign(p.id).state;
  assert.equal(fresh.steps.pr.gates.check, undefined, "result was for facts that have since changed");
  assert.equal(fresh.steps.pr.facts.pr_number, 42);
});

test("a live lock blocks checks; dead owners, recycled pids and empty locks expire", async () => {
  const p = plan("locks");
  createCampaign(stringify(p), folder, "operator");
  setCampaignPaused(p.id, false);
  const lock = join(folder, p.id, "reconcile.lock");
  const runner = async () => ({ status: "waiting" as const, at: new Date().toISOString() });
  const age = (ms: number) => { const t = new Date(Date.now() - ms); utimesSync(lock, t, t); };
  const retry = () => {
    const { plan: current, state } = loadCampaign(p.id);
    if (state.steps.pr.gates.check) saveState(p.id, retryGate(current, state, "pr", "check", "test", "human"));
  };

  writeFileSync(lock, String(process.ppid)); // a live process that is not us
  await assert.rejects(reconcileCampaign(p.id, runner), new RegExp("process " + process.ppid + ".*remove .*reconcile\\.lock"));
  age(LOCK_STALE_MS + 1000); // untouched past any gate timeout: treat the pid as recycled
  await reconcileCampaign(p.id, runner);
  assert.equal(existsSync(lock), false);

  retry();
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  writeFileSync(lock, String(dead));
  await reconcileCampaign(p.id, runner);
  assert.equal(existsSync(lock), false);

  retry();
  writeFileSync(lock, "");
  await assert.rejects(reconcileCampaign(p.id, runner), /being created/);
  age(2 * 60 * 1000);
  await reconcileCampaign(p.id, runner);
  assert.equal(loadCampaign(p.id).state.steps.pr.gates.check?.status, "waiting");
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
