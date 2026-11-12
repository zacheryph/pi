import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { loadResources, clearSlots, slots } from "#test-helpers";
import { plain } from "#test/helpers";

it("imports and renders the library through Pi's real loader without linking or building the package", async () => {
  const key = Symbol.for("pi-ui.test.sdk");
  onTestFinished(() => clearSlots(key));
  const { errors, extensions } = await loadResources(onTestFinished, {
    extensions: [join(import.meta.dirname, "fixtures/probe.ts")],
  });
  expect(errors).toEqual([]);
  expect(extensions).toHaveLength(1);
  const seen = slots[key] as {
    detail: string[];
    explorer: string[];
    widget: string[];
    text: string;
  };
  expect(plain(seen.detail)).toContain("safe content");
  expect(plain(seen.explorer)).toContain("One");
  expect(seen.widget).toHaveLength(2);
  expect(seen.text).toBe("a b");
});
