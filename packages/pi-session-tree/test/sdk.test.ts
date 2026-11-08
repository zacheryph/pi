import { join } from "node:path";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { loadResources } from "../../pi-test-helpers/src/faux-session.ts";
import { clearSlots, resetSessionTree, slots } from "../../pi-test-helpers/src/globals.ts";

const keys = ["provider", "consumer", "seen"].map((name) =>
  Symbol.for(`pi-session-tree.test.${name}`),
);

afterEach(() => {
  clearSlots(...keys);
  resetSessionTree();
});

it("shares one registry between extensions that each load their own copy of the library", async () => {
  const { errors } = await loadResources(onTestFinished, {
    extensions: [
      join(import.meta.dirname, "fixtures/provider.ts"),
      join(import.meta.dirname, "fixtures/consumer.ts"),
    ],
  });

  expect(errors).toEqual([]);
  const [provider, consumer, seen] = keys.map((key) => slots[key]);
  // Each extension got its own module instance of the library…
  expect(typeof provider).toBe("function");
  expect(provider).not.toBe(consumer);
  // …but both reached the same registry.
  expect(seen).toEqual({ hello: "from provider" });
});
