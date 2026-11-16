/** Env var that replaces the default allowlist: comma-separated skill names, empty to allow none. */
export const ENV_BB_SKILLS = "PI_BB_SKILLS";

/**
 * The only skills bb injects that a thread keeps. The rest document bb itself (provider
 * settings, plugin CLI commands, sidebar layout) and each costs a name and description in
 * the system prompt. `inline-vis` teaches a reply format the model cannot guess.
 */
export const DEFAULT_BB_SKILLS: readonly string[] = ["inline-vis"];

/** Where bb writes the skills it injects: its plugins' skills and the generated ones. */
const BB_INJECTED = /[\\/]\.bb[\\/]runtime[\\/]global-skills[\\/]/;

export function allowedBbSkills(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const raw = env[ENV_BB_SKILLS];
  if (raw === undefined) return new Set(DEFAULT_BB_SKILLS);
  return new Set(
    raw
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

function skillPath(skill: { name: string; filePath?: string }): string {
  return skill.filePath ?? "";
}

/**
 * Removes the skills bb injected that are not on the allowlist, in place; returns how many
 * went. Your own skills (project, user and package ones) are never touched.
 */
export function dropBbSkills<T extends { name: string; filePath?: string }>(
  skills: T[] | undefined,
  allowed: ReadonlySet<string>,
): number {
  if (!skills) return 0;
  let dropped = 0;
  for (let index = skills.length - 1; index >= 0; index--) {
    const skill = skills[index]!;
    if (!BB_INJECTED.test(skillPath(skill)) || allowed.has(skill.name)) continue;
    skills.splice(index, 1);
    dropped++;
  }
  return dropped;
}

/** Env var that keeps bb's `update_environment_directory` tool when set to `1`. */
export const ENV_KEEP_ENVIRONMENT_TOOL = "PI_BB_ENVIRONMENT_TOOL";

/** The tool bb gives every thread, and the sentence it appends to the prompt about it. */
export const ENVIRONMENT_TOOL = "update_environment_directory";

/**
 * Drops the tool from the prompt's tool selection (which also makes it uncallable) and
 * removes the paragraph that tells the model to use it. Returns whether anything changed.
 */
export function dropEnvironmentTool(options: {
  selectedTools?: string[];
  appendSystemPrompt?: string;
}): boolean {
  let changed = false;
  const tools = options.selectedTools;
  const at = tools?.indexOf(ENVIRONMENT_TOOL) ?? -1;
  if (tools && at >= 0) {
    tools.splice(at, 1);
    changed = true;
  }
  const text = options.appendSystemPrompt;
  if (text?.includes(ENVIRONMENT_TOOL)) {
    options.appendSystemPrompt = text
      .split(/\n{2,}/)
      .filter((paragraph) => !paragraph.includes(ENVIRONMENT_TOOL))
      .join("\n\n");
    changed = true;
  }
  return changed;
}
