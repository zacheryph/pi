import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandNameProblems, extensionName } from "./command-names.mjs";

// Load the root package exactly as a local personal install, but never read or
// modify the user's settings, project resources, or credentials. No model calls.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "pi-personal-bundle-"));
const originalCwd = process.cwd();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

try {
  process.chdir(sandbox);
  process.env.PI_CODING_AGENT_DIR = sandbox;
  const { DefaultResourceLoader, SettingsManager } =
    await import("@earendil-works/pi-coding-agent");
  const loader = new DefaultResourceLoader({
    cwd: sandbox,
    agentDir: sandbox,
    settingsManager: SettingsManager.inMemory({ packages: [root] }),
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { extensions, errors } = loader.getExtensions();
  assert.deepEqual(errors, [], "Bundle must load without extension errors");

  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  // .agents/ holds development-only skills and code, such as the scripted
  // screenshot model; none of it may ship in the bundle.
  for (const entry of [...manifest.pi.extensions, ...manifest.pi.skills]) {
    assert.ok(
      !resolve(root, entry).startsWith(join(root, ".agents")),
      `Manifest must not load development-only code: ${entry}`,
    );
  }
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
  // AGENTS.md: every command is the extension's name less pi-, or <name>:<action>.
  const namingProblems = extensions.flatMap((extension) => {
    const name = extensionName(extension.resolvedPath);
    assert.ok(name, `Entry point outside extensions/pi-*/: ${extension.resolvedPath}`);
    return commandNameProblems(name, extension.commands.keys());
  });
  assert.deepEqual(namingProblems, [], "Command names must follow the AGENTS.md prefix rule");
  for (const name of [
    "subagent_start",
    "subagent_get",
    "subagent_steer",
    "todo_list",
    "todo_upsert",
    "todo_replace",
    "todo_remove",
    "todo_clear",
    "job_start",
    "job_watch",
    "job_list",
    "job_read",
    "job_kill",
    "stash_put",
    "stash_get",
    "stash_list",
    "ask",
    "git_worktree_create",
    "git_worktree_list",
    "git_worktree_remove",
    "git_pr_list",
    "git_pr_status",
  ]) {
    assert.ok(tools.includes(name), `Missing tool: ${name}`);
  }
  for (const name of [
    "job",
    "subagent:settings",
    "subagent:sessions",
    "subagent:watch",
    "subagent:agents",
    "tldr",
    "system:prompt",
    "system:tools",
    "system:skills",
    "todo",
    "todo:review",
    "todo:add",
    "todo:update",
    "todo:remove",
    "todo:clear",
    "todo:settings",
    "stash",
    "stash:gc",
    "dashboard",
    "git:worktrees",
    "git:prs",
    "git:refresh",
  ]) {
    assert.ok(commands.includes(name), `Missing command: ${name}`);
  }
  const { skills, diagnostics } = loader.getSkills();
  assert.deepEqual(diagnostics, [], "Bundle skills must load without diagnostics");
  const skillNames = skills.map((skill) => skill.name);
  assert.equal(new Set(skillNames).size, skillNames.length, "Skill names must be unique");
  // Every directory under each manifest skills root must load as a skill of the same name.
  const bundledSkills = manifest.pi.skills.flatMap((dir) =>
    readdirSync(resolve(root, dir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  for (const name of bundledSkills) {
    assert.ok(skillNames.includes(name), `Missing skill: ${name}`);
  }
  console.log(
    `Bundle loaded: ${extensions.length} extensions; ${tools.join(", ")}; skills: ${skillNames.join(", ")}`,
  );
} finally {
  process.chdir(originalCwd);
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(sandbox, { recursive: true, force: true });
}
