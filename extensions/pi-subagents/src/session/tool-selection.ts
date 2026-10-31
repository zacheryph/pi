/**
 * Resolve agent profile tool selection for main sessions and child sessions.
 *
 * Omitted `tools` and `tools: all` select the registered tools; explicit names
 * form an allowlist. Minus-prefixed names exclude tools, including MCP globs.
 * Negative-only lists implicitly start from all. The available list must contain
 * non-hidden tools; the caller enforces its own SDK capability restrictions.
 */
export interface ResolvedToolSelection {
  toolNames: string[];
  unmatchedPatterns: string[];
  /** Includes missing literal names, so callers can exclude protocol tools too. */
  excludedToolNames: string[];
}

export function resolveToolSelection(
  declared: readonly string[] | undefined,
  available: readonly string[],
): ResolvedToolSelection {
  const entries = declared ?? ["all"];
  const inclusions = entries.filter((entry) => !entry.startsWith("-"));
  const exclusions = entries
    .filter((entry) => entry.startsWith("-"))
    .map((entry) => entry.slice(1));
  const candidates = [...new Set(available)];
  const selected = new Set<string>();
  const excluded = new Set<string>();
  const unmatchedPatterns: string[] = [];

  if (inclusions.includes("all") || (!inclusions.length && exclusions.length > 0)) {
    for (const name of candidates) selected.add(name);
  }

  for (const entry of inclusions) {
    if (entry === "all" || entry === "none") continue;
    if (!isMcpPattern(entry)) {
      selected.add(entry);
      continue;
    }
    const matches = candidates.filter((name) => matchesMcpPattern(entry, name));
    if (!matches.length) unmatchedPatterns.push(entry);
    for (const name of matches) selected.add(name);
  }

  for (const entry of exclusions) {
    if (!entry) continue;
    if (!isMcpPattern(entry)) {
      excluded.add(entry);
      continue;
    }
    for (const name of candidates) {
      if (matchesMcpPattern(entry, name)) excluded.add(name);
    }
  }

  return {
    toolNames: [...selected].filter((name) => !excluded.has(name)),
    unmatchedPatterns,
    excludedToolNames: [...excluded],
  };
}

function isMcpPattern(name: string): boolean {
  return name.startsWith("mcp__") && name.includes("*");
}

/** Match glob segments literally (no regex interpretation). */
function matchesMcpPattern(pattern: string, name: string): boolean {
  const parts = pattern.split("*");
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  if (!name.startsWith(first) || !name.endsWith(last)) return false;
  let cursor = first.length;
  const limit = name.length - last.length;
  for (const middle of parts.slice(1, -1)) {
    const index = name.indexOf(middle, cursor);
    if (index < 0 || index + middle.length > limit) return false;
    cursor = index + middle.length;
  }
  return cursor <= limit;
}
