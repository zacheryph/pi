import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentTypeRegistry } from "#src/config/agent-types";
import { LOCKABLE_FIELDS, type LockableField } from "#src/config/invocation-config";
import { composeAgentInstructions, parseFragments } from "#src/config/prompt-fragments";
import { normalizeMaxTurns } from "#src/lifecycle/turn-limits";
import type { AgentConfig, AgentVisibility } from "#src/types";
import {
  showExplorer,
  type Block,
  type ExplorerView,
  type Tone,
} from "../../../../packages/pi-ui/src/index.ts";

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

const UNAVAILABLE = "Agent definitions browser requires TUI mode.";

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
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify(UNAVAILABLE, "warning");
    return;
  }
  await showExplorer(
    ctx,
    buildAgentsView(registry, defaults, {
      projectTrusted: ctx.isProjectTrusted?.() === true,
    }),
    { unavailableMessage: UNAVAILABLE },
  );
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
          badge: {
            text: `[${visibility}]`,
            tone: VISIBILITY_TONE[visibility],
          },
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
        ["Source", config.source ?? (config.isDefault ? "default (embedded)" : "(not available)")],
        ["Source path", config.sourcePath ?? (config.isDefault ? "(embedded)" : "(not available)")],
        ["Tools", tools.length ? tools.join(", ") : "(none)"],
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
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        tone: "error",
      });
    }
  }
  return blocks;
}
