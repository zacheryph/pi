import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { plain } from "./helpers.ts";

it("imports and renders the library through Pi's real loader without linking or building the package", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-sdk-")),
    key = Symbol.for("pi-ui.test.sdk");
  const slots = globalThis as Record<symbol, unknown>;
  try {
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [join(import.meta.dirname, "fixtures/probe.ts")],
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().extensions).toHaveLength(1);
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // oxlint-disable-next-line no-dynamic-delete -- Remove this test's Symbol-keyed slot.
    delete slots[key];
  }
});
