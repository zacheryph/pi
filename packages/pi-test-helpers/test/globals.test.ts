import { describe, expect, it } from "vitest";
import { SESSION_TREE_KEY } from "../../pi-session-tree/src/index.ts";
import { clearSlots, resetSessionTree, slots, withSlot } from "#src/globals.ts";

describe("globals", () => {
  it("withSlot removes the slot after sync and async runs", async () => {
    const key = Symbol("slot");
    expect(withSlot(key, 1, () => slots[key])).toBe(1);
    expect(key in slots).toBe(false);
    await withSlot(key, 2, async () => expect(slots[key]).toBe(2));
    expect(key in slots).toBe(false);
  });

  it("clears slots and the session tree", () => {
    const key = Symbol("other");
    slots[key] = 1;
    slots[SESSION_TREE_KEY] = {};
    clearSlots(key);
    resetSessionTree();
    expect(key in slots || SESSION_TREE_KEY in slots).toBe(false);
  });
});
