/** The context filter for completions written by older versions (no pi, no processes). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CUSTOM_TYPE, dedupeCompletions, DUPLICATE_STUB } from "../src/delivery.ts";

/** A pi-job message with a header part and one part per completion, as earlier versions batched them. */
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
