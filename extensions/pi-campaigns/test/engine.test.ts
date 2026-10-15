import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  changePause, describe, initialState, reconcileGraph, recordGate, recordWork, validatePlan,
  type CampaignPlan
} from "../src/engine.ts";

const plan = (): CampaignPlan => ({
  id: "routing", title: "Routing migration", goal: "Migrate safely",
  steps: [
    { id: "module", title: "Prepare module", work: { kind: "agent" },
      gates: [{id:"human-review",kind:"human"}] },
    { id: "canary", title: "Canary", depends_on: ["module"], work: {kind:"none"},
      gates: [{id:"apply",kind:"command",command:["/bin/true"]}] },
    { id: "production", title: "Production", depends_on: ["canary"], work:{kind:"manual"} }
  ]
});
const result = (status: "passed" | "blocked" | "waiting") => ({ status, at: new Date().toISOString(), detail: "checked" });

test("rejects cycles, unknown dependencies and unsafe command shapes", () => {
  const p = plan();
  validatePlan(p);
  p.steps[0].depends_on = ["production"];
  assert.throws(() => validatePlan(p), /cycle/i);
  p.steps[0].depends_on = ["missing"];
  assert.throws(() => validatePlan(p), /unknown dependency/i);
  p.steps[0].depends_on = [];
  p.steps[1].gates![0].command = [];
  assert.throws(() => validatePlan(p), /argv/i);
});

test("starts paused, unlocks dependents only after work and all gates", () => {
  const p = plan();
  let s = initialState(p);
  assert.equal(s.paused, true);
  assert.throws(() => recordWork(p, s, "module", { pr: 32 }), /paused/);
  s = changePause(s, false);
  s = reconcileGraph(p, s);
  assert.equal(s.steps.module.status, "ready");
  assert.equal(s.steps.canary.status, "pending");
  assert.throws(() => recordWork(p, s, "canary", { a: 1 }), /not ready/);
  s = recordWork(p, s, "module", { pr: 32 });
  assert.equal(s.steps.module.status, "waiting");
  assert.equal(s.steps.canary.status, "pending");
  assert.throws(() => recordGate(p, s, "module", "human-review", result("passed"), "script"), /actor mismatch/);
  s = recordGate(p, s, "module", "human-review", result("passed"), "human");
  assert.equal(s.steps.module.status, "done");
  assert.equal(s.steps.canary.status, "waiting");
  s = recordGate(p, s, "canary", "apply", result("passed"), "script");
  assert.equal(s.steps.canary.status, "done");
  assert.equal(s.steps.production.status, "ready");
  assert.match(describe(p,s), /Production/);
});

test("blocked gate can be resolved explicitly without marking it passed", () => {
  const p = plan();
  let s = changePause(initialState(p), false);
  s = reconcileGraph(p, s);
  s = recordWork(p, s, "module", { pr: 32 });
  s = recordGate(p, s, "module", "human-review", result("blocked"), "human");
  assert.equal(s.steps.module.status, "blocked");
  s = recordGate(p, s, "module", "human-review", result("waiting"), "human");
  assert.equal(s.steps.module.status, "waiting");
});

test("a changed plan can add dependent work without resetting recorded evidence", () => {
  const p = plan();
  let s = changePause(initialState(p), false);
  s = reconcileGraph(p, s);
  s = recordWork(p, s, "module", { pr: 32 });
  s = recordGate(p, s, "module", "human-review", result("passed"), "human");
  p.steps.push({ id:"cleanup", title:"Cleanup", depends_on:["production"], work: { kind:"agent" } });
  s = reconcileGraph(p, s);
  assert.equal(s.steps.module.status, "done");
  assert.equal(s.steps.cleanup.status, "pending");
});

test("pause blocks mutations and leaves persisted evidence intact", () => {
  const p = plan();
  let s = changePause(initialState(p), false);
  s = reconcileGraph(p, s);
  s = changePause(s, true);
  assert.throws(() => recordWork(p, s, "module", { pr:1 }), /paused/);
  assert.equal(s.steps.module.work_complete, false);
});
