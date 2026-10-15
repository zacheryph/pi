import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { type CampaignPlan } from "../src/engine.ts";
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
  createCampaign(stringify(plan("persist")), folder);
  assert.equal(loadCampaign("persist").state.paused, true);
  assert.throws(() => createCampaign(stringify(plan("persist")), folder), /exists/);
  assert.throws(() => replacePlan("persist", stringify(plan("persist")), 12), /Stale/);
  const p = plan("persist");
  p.steps.push({id:"cleanup",title:"Cleanup",depends_on:["apply"],work:{kind:"manual"}});
  replacePlan("persist", stringify(p), 0);
  assert.equal(loadCampaign("persist").plan.steps.length, 3);
  assert.equal(loadCampaign("persist").state.revision, 1);
});

test("reconcile performs checks without model calls and unlocks downstream gates", async () => {
  createCampaign(stringify(plan("checks")), folder);
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
  createCampaign(stringify(plan("history")), folder);
  const before = loadCampaign("history").state;
  const next = structuredClone(before);
  next.history.push({at:new Date().toISOString(),kind:"note",detail:"recorded"});
  saveState("history",next);
  assert.equal(loadCampaign("history").state.history.at(-1)?.detail, "recorded");
});
