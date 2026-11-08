import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { loadResources } from "../../pi-test-helpers/src/faux-session.ts";
import { clearSlots, slots } from "../../pi-test-helpers/src/globals.ts";
import { plain } from "./helpers.ts";

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
