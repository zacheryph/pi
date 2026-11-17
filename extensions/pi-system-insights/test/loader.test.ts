import { join, resolve } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { loadResources } from "#test-helpers";
import { SESSION_EVENTS } from "#test/helpers";

it("loads standalone package through Pi discovery without duplicate commands or model tools", async () => {
  const root = resolve(import.meta.dirname, "..");
  const { extensions, errors } = await loadResources(onTestFinished, { packages: [root] });
  expect(errors).toEqual([]);
  expect(extensions).toHaveLength(1);
  expect(extensions[0].resolvedPath).toBe(join(root, "src/index.ts"));
  expect([...extensions[0].commands.keys()]).toEqual([
    "system:prompt",
    "system:tools",
    "system:skills",
  ]);
  expect(extensions[0].tools.size).toBe(0);
  // The session view's observer, then output's context filter and skill evidence.
  expect([...extensions[0].handlers.keys()]).toEqual([...SESSION_EVENTS, "context", "tool_result"]);
});
