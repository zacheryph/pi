import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

it("loads standalone package through Pi discovery without duplicate commands or model tools", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "pi-system-insights-loader-"));
  try {
    const root = resolve(import.meta.dirname, "..");
    const loader = new DefaultResourceLoader({
      cwd: sandbox, agentDir: sandbox,
      settingsManager: SettingsManager.inMemory({ packages: [root] }),
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const { extensions, errors } = loader.getExtensions();
    expect(errors).toEqual([]);
    expect(extensions).toHaveLength(1);
    expect(extensions[0].resolvedPath).toBe(join(root, "src/index.ts"));
    expect([...extensions[0].commands.keys()]).toEqual(["system:prompt", "system:tools", "system:skills"]);
    expect(extensions[0].tools.size).toBe(0);
    expect([...extensions[0].handlers.keys()]).toEqual(["tool_result"]);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
