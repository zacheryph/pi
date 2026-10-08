/**
 * mcp-tool-patterns.ts — expand `mcp__…*` entries of an agent's tool allowlist.
 *
 * Pi's tool allowlist matches names exactly, and an MCP server's tool names
 * exist only once the server connects, so naming every tool of a large server
 * by hand is the only way the allowlist alone could admit it. An agent may
 * instead write a pattern such as `mcp__github__*`, which is expanded against
 * the tool names the parent session has registered when the child is created.
 * Pi derives an MCP tool's name from its server and tool alone, so the child's
 * own MCP extension registers the same names.
 */

/** An agent's allowlist with its MCP patterns expanded. */
export interface ExpandedTools {
  /** Literal entries kept, each pattern replaced by its matches, deduplicated, order preserved. */
  toolNames: string[];
  /** Patterns that matched none of the available tools. */
  unmatchedPatterns: string[];
}

/**
 * Expand each `mcp__` entry containing `*` into the `available` names it
 * matches, where `*` matches any run of characters and the whole name must
 * match. Every other entry is kept as written.
 */
export function expandMcpToolPatterns(
  declared: readonly string[],
  available: readonly string[],
): ExpandedTools {
  const toolNames = new Set<string>();
  const unmatchedPatterns: string[] = [];
  for (const entry of declared) {
    if (!isMcpPattern(entry)) {
      toolNames.add(entry);
      continue;
    }
    const matcher = patternMatcher(entry);
    const matches = available.filter((name) => matcher.test(name));
    if (matches.length === 0) unmatchedPatterns.push(entry);
    for (const name of matches) toolNames.add(name);
  }
  return { toolNames: [...toolNames], unmatchedPatterns };
}

function isMcpPattern(entry: string): boolean {
  return entry.startsWith("mcp__") && entry.includes("*");
}

function patternMatcher(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`);
}
