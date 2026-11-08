import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { clearSlots, resetSessionTree, slots } from "../../pi-test-helpers/src/globals.ts";

const keys = ["provider", "consumer", "seen"].map((name) =>
  Symbol.for(`pi-session-tree.test.${name}`),
);
const dirs: string[] = [];

afterEach(() => {
  clearSlots(...keys);
  resetSessionTree();
});

it("shares one registry between extensions that each load their own copy of the library", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-session-tree-"));
  dirs.push(dir);
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [
      join(import.meta.dirname, "fixtures/provider.ts"),
      join(import.meta.dirname, "fixtures/consumer.ts"),
    ],
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  expect(loader.getExtensions().errors).toEqual([]);
  const [provider, consumer, seen] = keys.map((key) => slots[key]);
  // Each extension got its own module instance of the library…
  expect(typeof provider).toBe("function");
  expect(provider).not.toBe(consumer);
  // …but both reached the same registry.
  expect(seen).toEqual({ hello: "from provider" });
});
