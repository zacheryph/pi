/** Delivery and the context filter with a fake host (no pi, no processes). */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  continuesRun,
  CUSTOM_TYPE,
  dedupeCompletions,
  Delivery,
  DUPLICATE_STUB,
  type Completion,
  type SendMode,
} from "../src/delivery.ts";
import { sleep, tick } from "./helpers.ts";

function host() {
  const state = {
    idle: true,
    startRunOnSend: true,
    stale: false,
    sends: [] as { ids: string[]; mode: SendMode }[],
    lost: [] as string[],
  };
  const h = {
    isIdle: () => {
      if (state.stale) throw new Error("stale ctx");
      return state.idle;
    },
    send: (items: Completion<string>[], mode: SendMode) => {
      if (state.stale) throw new Error("stale ctx");
      state.sends.push({ ids: items.map((i) => i.completionId), mode });
      if (state.startRunOnSend && mode === "wake") state.idle = false;
    },
    lost: (items: Completion<string>[]) => state.lost.push(...items.map((i) => i.completionId)),
  };
  const d = new Delivery<string>(h);
  const c = (id: string): Completion<string> => ({ completionId: id, payload: id });
  return { state, d, c };
}

/** Count timers created while `fn` runs. */
function countTimers(fn: () => void): number {
  const g = globalThis as any;
  const saved = {
    setTimeout: g.setTimeout,
    setInterval: g.setInterval,
    setImmediate: g.setImmediate,
  };
  let count = 0;
  for (const k of Object.keys(saved)) g[k] = (...a: any[]) => (count++, (saved as any)[k](...a));
  try {
    fn();
  } finally {
    Object.assign(g, saved);
  }
  return count;
}

void test("idle: a completion is sent at once as a wake that starts a run", () => {
  const { state, d, c } = host();
  d.add(c("a"));
  assert.deepEqual(state.sends, [{ ids: ["a"], mode: "wake" }]);
});

void test("a run started by our wake records what arrives next, one message each", () => {
  const { state, d, c } = host();
  d.add(c("a"));
  d.add(c("b"));
  d.add(c("c"));
  assert.deepEqual(state.sends, [
    { ids: ["a"], mode: "wake" },
    { ids: ["b"], mode: "record" },
    { ids: ["c"], mode: "record" },
  ]);
  assert.equal(d.heldCount, 0);
});

void test("during a run: recorded at once, never held for a boundary", () => {
  const { state, d, c } = host();
  state.idle = false;
  d.onAgentStart();
  d.add(c("a"));
  d.add(c("b"));
  assert.deepEqual(state.sends, [
    { ids: ["a"], mode: "record" },
    { ids: ["b"], mode: "record" },
  ]);
});

void test("after the run settles the next completion wakes again", () => {
  const { state, d, c } = host();
  state.idle = false;
  d.onAgentStart();
  d.add(c("a"));
  state.idle = true;
  d.onAgentSettled();
  d.add(c("b"));
  assert.deepEqual(
    state.sends.map((s) => s.mode),
    ["record", "wake"],
  );
});

void test("busy without a run (compaction, branch summary): recorded, never a wake", () => {
  const { state, d, c } = host();
  state.idle = false;
  d.add(c("a"));
  assert.deepEqual(state.sends, [{ ids: ["a"], mode: "record" }]);
  state.idle = true;
  d.onAgentSettled();
  assert.equal(
    state.sends.length,
    1,
    "nothing is queued, so nothing is sent when pi is idle again",
  );
});

void test("no timers, and nothing is ever resent because time passed", async () => {
  const { state, d, c } = host();
  state.startRunOnSend = false; // a send pi defers: the session looks idle afterwards
  const timers = countTimers(() => {
    d.add(c("a"));
    d.onAgentStart();
    d.add(c("b"));
    d.onAgentSettled();
  });
  assert.equal(timers, 0);
  const before = state.sends.length;
  await sleep(200);
  assert.equal(state.sends.length, before);
});

void test("stale context is permanent: dispose, report the loss, never retry", () => {
  const { state, d, c } = host();
  state.idle = false;
  d.onAgentStart();
  state.stale = true;
  d.add(c("a")); // send throws
  assert.deepEqual(state.lost, ["a"]);
  state.stale = false;
  state.idle = true;
  d.add(c("b"));
  d.onAgentSettled();
  assert.equal(state.sends.length, 0);
  assert.deepEqual(state.lost, ["a"], "the loss is reported once");
});

void test("stale context detected by isIdle: disposed, nothing sent", () => {
  const { state, d, c } = host();
  state.stale = true;
  d.add(c("a"));
  assert.equal(state.sends.length, 0);
  assert.deepEqual(state.lost, ["a"]);
});

void test("a stale check after a successful send does not report that send as lost", () => {
  const { state, c } = host();
  let calls = 0;
  const h = {
    isIdle: () => {
      if (++calls > 1) throw new Error("stale ctx");
      return true;
    },
    send: (items: Completion<string>[], mode: SendMode) =>
      void state.sends.push({ ids: items.map((i) => i.completionId), mode }),
    lost: (items: Completion<string>[]) => state.lost.push(...items.map((i) => i.completionId)),
  };
  const only = new Delivery<string>(h);
  only.add(c("a"));
  assert.equal(state.sends.length, 1);
  assert.deepEqual(state.lost, []);
});

void test("continuesRun: only a completed run with a completion after the last answer", () => {
  const completion = { role: "custom", customType: CUSTOM_TYPE };
  const assistant = { role: "assistant" };
  const at = (outcome: string, contextMessages: object[], pendingMessages: object[] = []) =>
    continuesRun({ outcome, context: { contextMessages, pendingMessages } });
  assert.equal(at("completed", [assistant, completion]), true);
  assert.equal(at("completed", [assistant], [completion]), true);
  assert.equal(at("completed", [completion, assistant]), false, "answered");
  assert.equal(at("completed", [assistant, { role: "custom", customType: "x" }]), false);
  assert.equal(at("completed", []), false);
  assert.equal(at("aborted", [assistant, completion]), false);
  assert.equal(at("error", [assistant, completion], [completion]), false);
});

/** A pi-job message in the current format: header part + one part per completion. */
const msg = (ids: string[]) => {
  const single = ids.length === 1;
  return {
    role: "custom",
    customType: CUSTOM_TYPE,
    content: single
      ? [{ type: "text", text: `block ${ids[0]}` }]
      : [
          { type: "text", text: "header" },
          ...ids.map((id) => ({ type: "text", text: `block ${id}` })),
        ],
    details: {
      deliveryId: "x",
      completions: ids.map((completionId, i) => ({
        completionId,
        part: single ? 0 : i + 1,
        job: { id: "j1" },
      })),
    },
  };
};
const texts = (m: any) => m.content.map((p: any) => p.text);

void test("context filter: dedupes on completion ids only, never on the job handle", () => {
  const legacy = {
    role: "custom",
    customType: CUSTOM_TYPE,
    content: "old j1",
    details: { deliveryId: "old", jobs: [{ id: "j1" }] },
  };
  const messages = [legacy, msg(["u1"]), msg(["u2"])]; // three different j1 completions (resume/fork)
  assert.equal(dedupeCompletions(messages), undefined);
});

void test("context filter: each completion block reaches the model at most once", () => {
  const out = dedupeCompletions([
    msg(["u1"]),
    msg(["u1", "u2"]),
    msg(["u2", "u3", "u1"]),
    msg(["u1", "u2"]),
    { role: "user", content: "hi" },
  ])!;
  assert.deepEqual(texts(out[0]), ["block u1"]);
  assert.deepEqual(
    texts(out[1]),
    ["[pi-job: 1 completion already shown above omitted.]\n\n", "block u2"],
    "seen block stripped, unseen kept",
  );
  assert.deepEqual(texts(out[2]), [
    "[pi-job: 2 completions already shown above omitted.]\n\n",
    "block u3",
  ]);
  assert.deepEqual(texts(out[3]), [DUPLICATE_STUB], "nothing unseen: stub, not removed");
  assert.equal(out.length, 5);
  const shown = out.flatMap((m) => (Array.isArray((m as any).content) ? texts(m) : [])).join("|");
  for (const id of ["u1", "u2", "u3"])
    assert.equal(shown.split(`block ${id}`).length - 1, 1, `${id} shown once`);
});

void test("context filter is idempotent and never loses an unseen block", () => {
  const ctx = [msg(["a"]), msg(["a", "b", "c"]), msg(["b", "d"]), msg(["c", "d", "e"])];
  const once = dedupeCompletions(ctx)!;
  assert.equal(
    dedupeCompletions(once),
    undefined,
    "filtering the filtered context changes nothing",
  );
  // details stay consistent with content: every remaining ref points at its own block
  for (const m of once as any[]) {
    const refs = m.details.completions;
    if (texts(m)[0] === DUPLICATE_STUB) continue;
    for (const r of refs) assert.equal(texts(m)[r.part], `block ${r.completionId}`);
  }
  const shown = once.flatMap((m) => texts(m)).join("|");
  for (const id of ["a", "b", "c", "d", "e"])
    assert.equal(shown.split(`block ${id}`).length - 1, 1, `${id} shown exactly once`);
  assert.deepEqual(texts(once[1]), [
    "[pi-job: 1 completion already shown above omitted.]\n\n",
    "block b",
    "block c",
  ]);
  assert.deepEqual(
    once[1].details.completions.map((c: any) => [c.completionId, c.part]),
    [
      ["b", 1],
      ["c", 2],
    ],
  );
});

void test("context filter: a message without part indices can only be stubbed as a whole", () => {
  const old = (ids: string[]) => ({
    role: "custom",
    customType: CUSTOM_TYPE,
    content: [{ type: "text", text: ids.join(",") }],
    details: { completions: ids.map((completionId) => ({ completionId })) },
  });
  const out = dedupeCompletions([old(["u1"]), old(["u1", "u2"]), old(["u1"])])!;
  assert.deepEqual(texts(out[1]), ["u1,u2"], "cannot split an unindexed message");
  assert.deepEqual(texts(out[2]), [DUPLICATE_STUB]);
});

void test("reload suspends stale API calls and sends what was buffered through the new host", async () => {
  const { state, d, c } = host();
  state.idle = false;
  d.onAgentStart();
  d.add(c("before"));
  d.suspend();
  state.stale = true;
  d.add(c("during-reload"));
  d.add(c("during-reload-2"));
  d.onAgentStart();
  d.onAgentSettled();
  assert.equal(state.sends.length, 1);
  assert.equal(d.heldCount, 2);
  assert.equal((d as unknown as { disposed: boolean }).disposed, false);
  const received: { ids: string[]; mode: SendMode }[] = [];
  d.rebind({
    isIdle: () => true,
    send: (items, mode) => {
      received.push({ ids: items.map((i) => i.completionId), mode });
    },
  });
  assert.deepEqual(received, []); // Other session_start handlers run before this send.
  await tick();
  assert.deepEqual(received, [{ ids: ["during-reload", "during-reload-2"], mode: "wake" }]);
  assert.equal(state.lost.length, 0);
});

void test("a deferred rebind cannot resume a second reload handoff", async () => {
  const { d, c } = host();
  d.suspend();
  d.add(c("pending"));
  let sends = 0;
  d.rebind({
    isIdle: () => true,
    send: () => {
      sends++;
    },
  });
  d.suspend();
  await tick();
  assert.equal(sends, 0);
  d.dispose();
});
