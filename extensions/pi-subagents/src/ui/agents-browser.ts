import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentTypeRegistry } from "#src/config/agent-types";
import { LOCKABLE_FIELDS, type LockableField } from "#src/config/invocation-config";
import { composeAgentInstructions, parseFragments } from "#src/config/prompt-fragments";
import { normalizeMaxTurns } from "#src/lifecycle/turn-limits";
import type { AgentConfig } from "#src/types";
import { type BrowserView, sanitizeBrowserText, showReadOnlyBrowser } from "#src/ui/read-only-browser";

export type AgentsBrowserRegistry = Pick<AgentTypeRegistry,
  "getAllTypes" | "resolveAgentConfig" | "getToolNamesForType">;
export interface AgentsBrowserDefaults {
  readonly defaultMaxTurns?: number;
}

export interface AgentsBrowserOptions {
  readonly projectTrusted?: boolean;
  readonly readFile?: (path: string) => string;
}

type BrowserContext = Pick<ExtensionContext, "mode" | "hasUI" | "ui"> &
  Partial<Pick<ExtensionContext, "isProjectTrusted">>;

/** Command entry point. Reads the current registry once; never reloads or mutates it. */
export async function showAgentsBrowser(
  ctx: BrowserContext,
  registry: AgentsBrowserRegistry,
  defaults: AgentsBrowserDefaults = {},
): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("Agent definitions browser requires TUI mode.", "warning");
    return;
  }
  await showReadOnlyBrowser(ctx, buildAgentsView(registry, defaults, {
    projectTrusted: ctx.isProjectTrusted?.() === true,
  }));
}

/** Registry already contains winning definitions, including disabled overrides. */
export function buildAgentsView(
  registry: AgentsBrowserRegistry,
  defaults: AgentsBrowserDefaults = {},
  options: AgentsBrowserOptions = {},
): BrowserView {
  return {
    title: "Subagents · Agents",
    note: "Read-only effective definitions · unlocked fields may be overridden by callers",
    items: registry.getAllTypes().map((name) => {
      const config = registry.resolveAgentConfig(name);
      const enabled = config.enabled !== false;
      return {
        id: name,
        label: name,
        status: enabled ? "enabled" : "disabled",
        badge: { label: enabled ? "[enabled]" : "[disabled]", color: enabled ? "success" : "dim" },
        description: config.description,
        detail: agentDetail(config, registry.getToolNamesForType(name), defaults, options),
      };
    }),
  };
}

/** Align metadata only. Body is always its own full-width multiline section. */
function detailFields(fields: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(...fields.map(([label]) => label.length)) + 2;
  return fields.map(([label, value]) => {
    // Sanitize before adding alignment, so a newline/control in an untrusted
    // value cannot escape its field or forge another heading.
    const [first, ...rest] = sanitizeBrowserText(value).split("\n");
    return `${`${label}:`.padEnd(width)}${first}${rest.map((line) => `\n${" ".repeat(width)}${line}`).join("")}`;
  });
}

const lockValues = (config: AgentConfig): Record<LockableField, unknown> => ({
  model: config.model,
  thinking: config.thinking,
  max_turns: config.maxTurns,
  inherit_context: config.inheritContext,
  run_in_background: config.runInBackground,
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
  if (config.maxTurns === undefined && defaults.defaultMaxTurns !== undefined) label += " (extension default)";
  return label;
}

function agentDetail(
  config: AgentConfig,
  tools: readonly string[],
  defaults: AgentsBrowserDefaults,
  options: AgentsBrowserOptions,
): string {
  const fields: [string, string][] = [
    ["Name", config.name],
    ["Display name", config.displayName ?? config.name],
    ["Enabled", String(config.enabled !== false)],
    ["Source", config.source ?? (config.isDefault ? "default (embedded)" : "(not available)")],
    ["Source path", config.sourcePath ?? (config.isDefault ? "(embedded)" : "(not available)")],
    ["Tools", tools.length ? tools.join(", ") : "(none)"],
    ["Model", config.model ?? "(inherit parent)"],
    ["Thinking", config.thinking ?? "(inherit parent)"],
    ["Max turns", maxTurnsSummary(config, defaults)],
    ["Prompt mode", config.promptMode],
    ["Inherit context", config.inheritContext === undefined ? "false (tool default; caller decides)" : String(config.inheritContext)],
    ["Run in background", config.runInBackground === undefined ? "false (tool default; caller decides)" : String(config.runInBackground)],
    ["Locked", lockSummary(config)],
    ["Tool guideline", config.toolGuideline ?? "(none)"],
    ["Description", config.description],
  ];
  const body = sanitizeBrowserText(config.systemPrompt);
  const sections = [...detailFields(fields), "", "Body", body || "(empty)"];
  if (config.fragmentError || config.fragments?.length) {
    // Provenance stays visible even when a fragment is missing or project trust
    // blocks preview. Validate names before deriving paths; never expand paths.
    const parsed = parseFragments(config.fragments);
    const names = parsed.fragments ?? [];
    const provenance = names.map((name, index) => `${index + 1}. ${name}\n   ${config.sourcePath
      ? join(dirname(config.sourcePath), "fragments", `${name}.md`)
      : "(source path unavailable)"}`).join("\n");
    sections.push("", "Fragments", sanitizeBrowserText(provenance) || "(invalid)", "", "Composed instructions");
    try {
      const composed = composeAgentInstructions(config, options);
      sections.push(sanitizeBrowserText(composed.systemPrompt) || "(empty)");
    } catch (error) {
      sections.push(`Error: ${sanitizeBrowserText(error instanceof Error ? error.message : String(error))}`);
    }
  }
  return sections.join("\n");
}
