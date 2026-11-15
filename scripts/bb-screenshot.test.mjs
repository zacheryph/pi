import assert from "node:assert/strict";
import { test } from "node:test";
import { insetProblems } from "../.agents/skills/bb-screenshot/scripts/bb-shot.mjs";

const card = (body) => ({ header: { iconLeft: 12, textLeft: 32 }, body });
const even = { left: 12, right: 12, top: 12, iconLeft: 12, textLeft: 32 };

void test("even insets on every card and the context row pass", () => {
  assert.deepEqual(
    insetProblems({
      Todos: card(even),
      Subagents: card(even),
      context: { iconLeft: 12, textLeft: 32 },
    }),
    [],
  );
});

void test("collapsed cards are checked by their header only", () => {
  assert.deepEqual(insetProblems({ Todos: card(null), context: { iconLeft: 12 } }), []);
});

void test("each uneven side and a misaligned text column is reported", () => {
  assert.deepEqual(
    insetProblems({
      Todos: card({ left: 4, right: 4, top: 0, iconLeft: 4, textLeft: 26 }),
      context: { iconLeft: 8, textLeft: 28 },
    }),
    [
      "Todos body left inset is 4px, expected 12px",
      "Todos body right inset is 4px, expected 12px",
      "Todos body top inset is 0px, expected 12px",
      "Todos body text column is 26px, expected 32px",
      "context row icon inset is 8px, expected 12px",
    ],
  );
});

void test("sub-pixel differences within the tolerance pass", () => {
  assert.deepEqual(insetProblems({ Todos: card({ ...even, top: 12.4 }) }), []);
});

void test("without a stack card there is nothing to compare against", () => {
  assert.equal(insetProblems({ context: { iconLeft: 12 } }).length, 1);
});
