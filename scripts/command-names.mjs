// Slash command naming rule from AGENTS.md: an extension's commands are its name
// less the `pi-` prefix (`/todo`), or that name, a colon and an action
// (`/todo:review`), all lowercase.

/**
 * Extensions whose command prefix is not their name less `pi-`, with the reason.
 * Keep this empty unless the rule itself is wrong for an extension.
 * @type {Record<string, string>}
 */
export const PREFIX_EXCEPTIONS = {
  // Predates the rule; `/system:*` reads better than `/system-insights:*`.
  "pi-system-insights": "system",
};

/** The extension directory name (`pi-todo`) for an entry point path. */
export function extensionName(entryPath) {
  const match = /(?:^|[\\/])extensions[\\/](pi-[^\\/]+)[\\/]/.exec(entryPath);
  return match?.[1];
}

/** The command prefix for an extension (`pi-todo` -> `todo`). */
export function commandPrefix(name) {
  return PREFIX_EXCEPTIONS[name] ?? name.replace(/^pi-/, "");
}

/**
 * Problems with one extension's command names, as messages; empty when all follow
 * the rule.
 * @param {string} name extension directory name, such as `pi-todo`
 * @param {Iterable<string>} commands registered command names, without the slash
 * @returns {string[]}
 */
export function commandNameProblems(name, commands) {
  const prefix = commandPrefix(name);
  const problems = [];
  for (const command of commands) {
    if (command !== command.toLowerCase()) {
      problems.push(`${name}: /${command} must be lowercase`);
      continue;
    }
    const [head, action, ...rest] = command.split(":");
    if (head !== prefix || rest.length > 0 || action === "") {
      problems.push(`${name}: /${command} must be /${prefix} or /${prefix}:<action>`);
    }
  }
  return problems;
}
