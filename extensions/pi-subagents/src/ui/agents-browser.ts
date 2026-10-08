import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentTypeRegistry } from "#src/config/agent-types";
import { LOCKABLE_FIELDS, type LockableField } from "#src/config/invocation-config";
import { normalizeMaxTurns } from "#src/lifecycle/turn-limits";
import type { AgentConfig } from "#src/types";
import { type BrowserView, sanitizeBrowserText, showReadOnlyBrowser } from "#src/ui/read-only-browser";

export type AgentsBrowserRegistry = Pick<AgentTypeRegistry,
  "getAllTypes" | "resolveAgentConfig" | "getToolNamesForType">;
export interface AgentsBrowserDefaults {
  readonly defaultMaxTurns?: number;
}

type BrowserContext = Pick<ExtensionContext, "mode" | "hasUI" | "ui">;

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
  await showReadOnlyBrowser(ctx, buildAgentsView(registry, defaults));
}

/** Registry already contains winning definitions, including disabled overrides. */
export function buildAgentsView(
  registry: AgentsBrowserRegistry,
  defaults: AgentsBrowserDefaults = {},
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
        detail: agentDetail(config, registry.getToolNamesForType(name), defaults),
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

function agentDetail(config: AgentConfig, tools: readonly string[], defaults: AgentsBrowserDefaults): string {
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
  return [...detailFields(fields), "", "Body", body || "(empty)"].join("\n");
}
