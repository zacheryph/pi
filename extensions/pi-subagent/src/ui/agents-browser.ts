import { errorText } from "#foundations/errors";
import { oneLine } from "#foundations/format";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentTypeRegistry } from "#src/config/agent-types";
import { LOCKABLE_FIELDS, type LockableField } from "#src/config/invocation-config";
import { composeAgentInstructions, parseFragments } from "#src/config/prompt-fragments";
import { normalizeMaxTurns } from "#src/lifecycle/turn-limits";
import type { AgentConfig, AgentVisibility } from "#src/types";
import { showExplorer, type Block, type ExplorerView, type Tone } from "#ui";

export type AgentsBrowserRegistry = Pick<
  AgentTypeRegistry,
  "getAllTypes" | "resolveAgentConfig" | "getToolNamesForType"
>;
export interface AgentsBrowserDefaults {
  readonly defaultMaxTurns?: number;
}

export interface AgentsBrowserOptions {
  readonly projectTrusted?: boolean;
  readonly readFile?: (path: string) => string;
}

type BrowserContext = Pick<ExtensionContext, "mode" | "hasUI" | "ui"> &
  Partial<Pick<ExtensionContext, "isProjectTrusted">>;

const VISIBILITY_TONE: Record<AgentVisibility, Tone> = {
  visible: "success",
  hidden: "muted",
  disabled: "dim",
};

/** Command entry point. Reads the current registry once; never reloads or mutates it. */
export async function showAgentsBrowser(
  ctx: BrowserContext,
  registry: AgentsBrowserRegistry,
  defaults: AgentsBrowserDefaults = {},
): Promise<void> {
  await showExplorer(
    ctx,
    () =>
      buildAgentsView(registry, defaults, {
        projectTrusted: ctx.isProjectTrusted?.() === true,
      }),
    { command: "/subagent:agents" },
  );
}

/** Agents `agentsListText` lists before it counts the rest. */
const MAX_LISTED_AGENTS = 60;

/**
 * The browser's list as plain text, for a host without the terminal UI: one row per agent with
 * its visibility, source, model and a one-line description. Full definitions stay in the browser.
 */
export function agentsListText(
  registry: AgentsBrowserRegistry,
  defaults: AgentsBrowserDefaults = {},
): string {
  const names = [...registry.getAllTypes()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
  const rows = names.slice(0, MAX_LISTED_AGENTS).map((name) => {
    const config = registry.resolveAgentConfig(name);
    const facts = [
      config.definitionError ? "invalid" : (config.visibility ?? "visible"),
      config.source === "default" ? "built-in" : config.source,
      config.model ?? "inherits model",
      `max turns ${maxTurnsSummary(config, defaults)}`,
    ].filter(Boolean);
    const note = config.definitionError ?? config.description;
    return `- ${name} [${facts.join(" · ")}]${note ? ` — ${oneLine(note, 160)}` : ""}`;
  });
  if (names.length > rows.length) rows.push(`+${names.length - rows.length} more`);
  return [
    names.length
      ? `Subagent agents (${names.length}), read-only effective definitions:`
      : "No agents.",
    ...rows,
    ...(names.length
      ? ["Full instructions and tools are in the terminal UI's /subagent:agents."]
      : []),
  ].join("\n");
}

/** Registry already contains winning definitions, including disabled overrides. */
export function buildAgentsView(
  registry: AgentsBrowserRegistry,
  defaults: AgentsBrowserDefaults = {},
  options: AgentsBrowserOptions = {},
): ExplorerView {
  return {
    title: "Subagents · Agents",
    noun: ["agent", "agents"],
    notices: [
      {
        text: "Read-only effective definitions · unlocked fields may be overridden by callers",
        tone: "muted",
      },
    ],
    items: [...registry.getAllTypes()]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      .map((name) => {
        const config = registry.resolveAgentConfig(name);
        const visibility = config.visibility ?? "visible";
        return {
          id: name,
          label: name,
          badge: config.definitionError
            ? { text: "[invalid]", tone: "error" }
            : { text: `[${visibility}]`, tone: VISIBILITY_TONE[visibility] },
          search: `${visibility} ${config.description}`,
          detail: agentDetail(config, registry.getToolNamesForType(name), defaults, options),
        };
      }),
  };
}

const lockValues = (config: AgentConfig): Record<LockableField, unknown> => ({
  model: config.model,
  thinking: config.thinking,
  max_turns: config.maxTurns,
  inherit_context: config.inheritContext,
});

function lockSummary(config: AgentConfig): string {
  if (config.locked !== true) return config.locked?.join(", ") || "(none)";
  const values = lockValues(config);
  const fields = LOCKABLE_FIELDS.filter((field) => values[field] !== undefined);
  return `true (declared fields: ${fields.join(", ") || "none"})`;
}

function maxTurnsSummary(config: AgentConfig, defaults: AgentsBrowserDefaults): string {
  const configured = config.maxTurns ?? defaults.defaultMaxTurns;
  const effective = normalizeMaxTurns(configured);
  let label = effective === undefined ? "unlimited" : String(effective);
  if (configured !== undefined && configured !== effective) label += ` (configured: ${configured})`;
  if (config.maxTurns === undefined && defaults.defaultMaxTurns !== undefined)
    label += " (extension default)";
  return label;
}

/**
 * Aligned single-line metadata, then multiline sections (description, tool
 * guidance, body, fragments) as full-width text so newlines survive.
 */
function agentDetail(
  config: AgentConfig,
  tools: readonly string[],
  defaults: AgentsBrowserDefaults,
  options: AgentsBrowserOptions,
): Block[] {
  const blocks: Block[] = [
    {
      fields: [
        ["Name", config.name],
        ["Display name", config.displayName ?? config.name],
        ["Visibility", config.visibility ?? "visible"],
        ["Source", config.source === "default" ? "built-in" : (config.source ?? "(not available)")],
        ["Source path", config.sourcePath ?? "(not available)"],
        ["Tools", tools.length ? tools.join(", ") : "(none)"],
        [
          "Reserved tools",
          config.reservedTools?.length ? config.reservedTools.join(", ") : "(none)",
        ],
        ["Delegate", config.delegate ? "yes" : "no"],
        ["Model", config.model ?? "(inherit parent)"],
        ["Thinking", config.thinking ?? "(inherit parent)"],
        ["Max turns", maxTurnsSummary(config, defaults)],
        ["Prompt mode", config.promptMode],
        [
          "Inherit context",
          config.inheritContext === undefined
            ? "false (tool default; caller decides)"
            : String(config.inheritContext),
        ],
        ["Locked", lockSummary(config)],
      ],
    },
    ...(config.definitionError
      ? [{ heading: "Definition error" }, { text: config.definitionError, tone: "error" as const }]
      : []),
    { heading: "Description" },
    { text: config.description || "(none)" },
    { heading: "Guidance" },
    { text: config.guidance ?? "(none)" },
    { heading: "Body" },
    { text: config.systemPrompt || "(empty)" },
  ];
  if (config.fragmentError || config.fragments?.length) {
    // Provenance stays visible even when a fragment is missing or project trust
    // blocks preview. Validate names before deriving paths; never expand paths.
    const parsed = parseFragments(config.fragments);
    const names = parsed.fragments ?? [];
    blocks.push(
      { heading: "Fragments" },
      names.length
        ? {
            lines: names.flatMap((name, index) => [
              `${index + 1}. ${name}`,
              `   ${
                config.sourcePath
                  ? join(dirname(config.sourcePath), "fragments", `${name}.md`)
                  : "(source path unavailable)"
              }`,
            ]),
          }
        : { text: "(invalid)" },
      { heading: "Composed instructions" },
    );
    try {
      const composed = composeAgentInstructions(config, options);
      blocks.push({ text: composed.systemPrompt || "(empty)" });
    } catch (error) {
      blocks.push({
        text: `Error: ${errorText(error)}`,
        tone: "error",
      });
    }
  }
  return blocks;
}
