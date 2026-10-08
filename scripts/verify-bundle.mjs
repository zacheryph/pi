import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load the root package exactly as a local personal install, but never read or
// modify the user's settings, project resources, or credentials. No model calls.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "pi-personal-bundle-"));
const originalCwd = process.cwd();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

try {
  process.chdir(sandbox);
  process.env.PI_CODING_AGENT_DIR = sandbox;
  const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const loader = new DefaultResourceLoader({
    cwd: sandbox,
    agentDir: sandbox,
    settingsManager: SettingsManager.inMemory({ packages: [root] }),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { extensions, errors } = loader.getExtensions();
  assert.deepEqual(errors, [], "Bundle must load without extension errors");

  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(
    extensions.map((extension) => extension.resolvedPath).sort(),
    manifest.pi.extensions.map((entry) => resolve(root, entry)).sort(),
    "Only root manifest entry points should load",
  );
  const tools = extensions.flatMap((extension) => [...extension.tools.keys()]);
  const commands = extensions.flatMap((extension) => [...extension.commands.keys()]);
  const flags = extensions.flatMap((extension) => [...extension.flags.keys()]);
  assert.equal(new Set(flags).size, flags.length, "Flag names must be unique");
  assert.ok(flags.includes("agent"), "Missing flag: --agent");
  assert.equal(new Set(tools).size, tools.length, "Tool names must be unique");
  assert.equal(new Set(commands).size, commands.length, "Command names must be unique");
  for (const name of ["subagent", "get_subagent_result", "steer_subagent", "todo"]) {
    assert.ok(tools.includes(name), `Missing tool: ${name}`);
  }
  for (const name of [
    "subagents:settings",
    "subagents:sessions",
    "subagents:watch",
    "subagents:agents",
    "system:prompt",
    "system:tools",
    "system:skills",
    "todos",
    "todos:list",
    "todos:add",
    "todos:update",
    "todos:remove",
    "todos:clear",
    "todos:settings",
  ]) {
    assert.ok(commands.includes(name), `Missing command: ${name}`);
  }
  console.log(`Bundle loaded: ${extensions.length} extensions; ${tools.join(", ")}`);
} finally {
  process.chdir(originalCwd);
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(sandbox, { recursive: true, force: true });
}
