/**
 * custom-agents.ts — Load agent definition files: the extension's built-ins
 * (agents/) and user-defined agents from project (.pi/agents/) and global
 * ($PI_CODING_AGENT_DIR/agents/, default ~/.pi/agent/agents/) locations.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isLockableField, type LockDeclaration } from "#src/config/invocation-config";
import { parseThinkingLevel, thinkingLevelError } from "#src/config/thinking-level";
import { parseFragments } from "#src/config/prompt-fragments";
import { debugLog } from "#src/debug";
import {
  AGENT_VISIBILITIES,
  type AgentConfig,
  type AgentSource,
  type AgentVisibility,
} from "#src/types";

/**
 * Scan for custom agent .md files from multiple locations.
 * Discovery hierarchy (higher priority wins):
 *   1. Project: <cwd>/.pi/agents/*.md
 *   2. Global:  $PI_CODING_AGENT_DIR/agents/*.md (default: ~/.pi/agent/agents/*.md)
 *
 * Project-level agents override global ones with the same name.
 * Any name is allowed — names matching defaults (e.g. "Explore") override them.
 */
export function loadCustomAgents(cwd: string): Map<string, AgentConfig> {
  const globalDir = join(getAgentDir(), "agents");
  const projectDir = join(cwd, ".pi", "agents");

  const agents = new Map<string, AgentConfig>();
  loadFromDir(globalDir, agents, "global"); // lower priority
  loadFromDir(projectDir, agents, "project"); // higher priority (overwrites)
  return agents;
}

/** Load every agent file in one directory, in case-insensitive name order. */
export function loadAgentsFromDir(dir: string, source: AgentSource): Map<string, AgentConfig> {
  const agents = new Map<string, AgentConfig>();
  loadFromDir(dir, agents, source);
  return agents;
}

/** Load agent configs from a directory into the map. */
function loadFromDir(dir: string, agents: Map<string, AgentConfig>, source: AgentSource): void {
  if (!existsSync(dir)) return;

  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  } catch (err) {
    debugLog("readdirSync agents dir", err);
    return;
  }

  for (const file of files) {
    const name = basename(file, ".md");

    let content: string;
    try {
      content = readFileSync(join(dir, file), "utf-8");
    } catch (err) {
      debugLog("readFileSync agent file", err);
      continue;
    }

    let parsed: { frontmatter: Record<string, unknown>; body: string };
    try {
      parsed = parseFrontmatter(content);
    } catch (err) {
      // One bad file must not take every other agent down with it. Keep the
      // name so it still overrides a lower-priority agent, but refuse it with
      // the parse error rather than spawn something its author did not write.
      debugLog("parseFrontmatter agent file", err);
      agents.set(name, brokenAgent(name, source, join(dir, file), err));
      continue;
    }
    const { frontmatter: fm, body } = parsed;

    agents.set(name, {
      name,
      displayName: str(fm.display_name),
      description: str(fm.description) ?? name,
      guidance: str(fm.guidance),
      toolNames: listField(fm.tools, ["all"]),
      delegate: fm.delegate === true ? true : undefined,
      model: str(fm.model),
      thinking: thinkingLevel(fm.thinking, name),
      maxTurns: nonNegativeInt(fm.max_turns),
      systemPrompt: body.trim(),
      ...parseFragments(fm.fragments),
      promptMode: fm.prompt_mode === "append" ? "append" : "replace",
      inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
      locked: lockDeclaration(fm.locked, name),
      visibility: visibility(fm.visibility, name),
      source,
      sourcePath: join(dir, file),
    });
  }
}

/** The record for a file whose frontmatter does not parse. */
function brokenAgent(
  name: string,
  source: AgentSource,
  sourcePath: string,
  err: unknown,
): AgentConfig {
  const reason = err instanceof Error ? err.message : String(err);
  return {
    name,
    description: name,
    systemPrompt: "",
    promptMode: "replace",
    toolNames: [],
    source,
    sourcePath,
    definitionError: `invalid frontmatter in ${sourcePath}: ${reason.split("\n")[0]}`,
  };
}

// ---- Field parsers ----
// All follow the same convention: omitted → default, "none"/empty → nothing, value → exact.

/** Extract a string or undefined. */
function str(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

/**
 * Parse the `locked:` key into a lock declaration, or undefined when it claims nothing.
 *
 * `true` is the whole-file form; anything else parses as a field list, so both YAML
 * spellings `tools:` accepts work here too. An entry naming no lockable field is
 * dropped rather than failing the agent's load.
 */
function lockDeclaration(val: unknown, agentName: string): LockDeclaration | undefined {
  if (typeof val === "boolean") return val ? true : undefined;

  const entries = parseListField(val);
  if (entries === undefined) return undefined;

  const fields = entries.filter(isLockableField);
  const unknownEntries = entries.filter((entry) => !isLockableField(entry));
  if (unknownEntries.length > 0) {
    debugLog(
      `agent ${agentName} frontmatter locked`,
      `unknown fields: ${unknownEntries.join(", ")}`,
    );
  }
  return fields.length > 0 ? fields : undefined;
}

/**
 * Extract a thinking level, dropping an unrecognized one.
 *
 * Passing it through would not surface as an error: Pi clamps a level missing from
 * its own table down to `off`, silently disabling thinking for an agent whose author
 * asked for more of it. Inheriting the parent's level is the safer miss (Refs #834).
 */
function thinkingLevel(val: unknown, agentName: string): AgentConfig["thinking"] {
  const level = parseThinkingLevel(val);
  if (val != null && level === undefined) {
    debugLog(`agent ${agentName} frontmatter thinking`, thinkingLevelError(val));
  }
  return level;
}

/** Extract a visibility, dropping an unrecognized one so the agent stays visible. */
function visibility(val: unknown, agentName: string): AgentVisibility | undefined {
  if (val == null) return undefined;
  const match = AGENT_VISIBILITIES.find((v) => v === val);
  if (match === undefined) {
    debugLog(
      `agent ${agentName} frontmatter visibility`,
      `unknown value: ${JSON.stringify(val)} (expected ${AGENT_VISIBILITIES.join(", ")})`,
    );
  }
  return match;
}

/** Extract a non-negative integer or undefined. 0 means unlimited for max_turns. */
function nonNegativeInt(val: unknown): number | undefined {
  return typeof val === "number" && val >= 0 ? val : undefined;
}

/**
 * Parse a raw list field into items, or undefined if absent/empty/"none".
 *
 * Frontmatter is YAML, so a list field is written either as a comma-separated
 * scalar (`tools: read, grep`) or as a sequence (`tools: [read, grep]`). Both
 * are supported: a sequence keeps its entries intact, while a scalar is split
 * on commas.
 */
function parseListField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const items = Array.isArray(val)
    ? val.map((entry) => String(entry).trim()).filter(Boolean)
    : // eslint-disable-next-line @typescript-eslint/no-base-to-string -- val is already narrowed past null/undefined; String() is the intended coercion here
      String(val)
        .trim()
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
  if (items.length === 0) return undefined;
  return items.length === 1 && items[0] === "none" ? undefined : items;
}

/**
 * Parse a list field with defaults.
 * omitted → defaults; "none"/empty → []; otherwise → listed items.
 */
function listField(val: unknown, defaults: string[]): string[] {
  if (val === undefined || val === null) return defaults;
  return parseListField(val) ?? [];
}
