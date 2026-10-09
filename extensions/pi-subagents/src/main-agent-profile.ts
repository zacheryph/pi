/** Main profiles: startup defaults plus durable SYSTEM instructions, not capability locks. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  parseFrontmatter,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { AgentTypeRegistry, BUILTIN_TOOL_NAMES } from "#src/config/agent-types";
import { loadCustomAgents } from "#src/config/custom-agents";
import { parseThinkingLevel, thinkingLevelError } from "#src/config/thinking-level";
import { composeAgentInstructions, parseFragments } from "#src/config/prompt-fragments";
import { MAIN_AGENT_SECTION } from "#src/session/main-profile-prompt";
import { expandMcpToolPatterns } from "#src/session/mcp-tool-patterns";
import { resolveModel } from "#src/session/model-resolver";
import type { AgentConfig } from "#src/types";
import { sanitizeBrowserText } from "#src/ui/read-only-browser";

export const MAIN_AGENT_ENTRY = "pi-subagents:main-agent-profile";
export { MAIN_AGENT_SECTION } from "#src/session/main-profile-prompt";
export const MAIN_AGENT_REQUIRED_TOOLS = ["subagent", "get_subagent_result", "steer_subagent"] as const;

/** Exact profile content, never a pointer to a mutable file or a settings lock. */
export interface MainAgentSnapshot {
  version: 1;
  profile: AgentConfig;
}

export interface MainAgentProfileIO {
  resolveProfile(name: string, ctx: ExtensionContext): AgentConfig;
  diagnostic(message: string): void;
}

/** Main discovery uses the target session cwd, not the child registry's process.cwd closure. */
export function resolveMainAgentProfile(name: string, ctx: ExtensionContext): AgentConfig {
  const registry = new AgentTypeRegistry(() => loadCustomAgents(ctx.cwd));
  const key = registry.resolveType(name);
  if (!key) throw new Error(`Unknown main agent profile: "${name}".`);
  const profile = structuredClone(registry.resolveAgentConfig(key));
  if (profile.enabled === false) throw new Error(`Main agent profile "${key}" is disabled.`);
  validateTrust(profile, ctx);
  // Children intentionally tolerate malformed thinking frontmatter. Explicit main
  // defaults must reject it; preserve the existing child-loader policy unchanged.
  if (profile.source === "project" || profile.source === "global") {
    const dir = profile.source === "project" ? join(ctx.cwd, ".pi", "agents") : join(getAgentDir(), "agents");
    profile.sourcePath ??= join(dir, `${key}.md`);
    const { frontmatter, body } = parseFrontmatter(readFileSync(profile.sourcePath, "utf8"));
    if (frontmatter.thinking != null && !parseThinkingLevel(frontmatter.thinking)) {
      throw new Error(thinkingLevelError(frontmatter.thinking));
    }
    profile.systemPrompt = body.trim();
    profile.thinking = parseThinkingLevel(frontmatter.thinking);
    // Body and fragment schema must come from the same fresh file. Clear stale
    // discovery errors when frontmatter changed since registry loading.
    const fragments = parseFragments(frontmatter.fragments);
    profile.fragments = fragments.fragments;
    profile.fragmentError = fragments.fragmentError;
  }
  // Explicit selection freezes expanded instructions in the durable snapshot.
  // Restoration consumes that string only, never mutable fragment files.
  profile.systemPrompt = composeAgentInstructions(profile, { projectTrusted: ctx.isProjectTrusted() }).systemPrompt;
  return profile;
}

function validateTrust(profile: AgentConfig, ctx: ExtensionContext): void {
  if (profile.source === "project" && !ctx.isProjectTrusted()) {
    throw new Error(`Main agent profile "${profile.name}" requires Pi project trust (--approve or /trust).`);
  }
}

function restoredSnapshot(data: unknown): MainAgentSnapshot {
  const s = data as Partial<MainAgentSnapshot> | null;
  if (!s || s.version !== 1 || !s.profile || typeof s.profile.name !== "string" ||
      typeof s.profile.systemPrompt !== "string" || typeof s.profile.description !== "string" ||
      !["append", "replace"].includes(s.profile.promptMode) || s.profile.enabled === false ||
      ![undefined, "default", "global", "project"].includes(s.profile.source)) {
    throw new Error("Invalid saved main agent profile snapshot; refusing to run.");
  }
  return { version: 1, profile: structuredClone(s.profile) };
}

function branchSnapshot(ctx: ExtensionContext): MainAgentSnapshot | undefined {
  const entry = ctx.sessionManager.getBranch().filter(e =>
    e.type === "custom" && e.customType === MAIN_AGENT_ENTRY).at(-1);
  return entry?.type === "custom" ? restoredSnapshot(entry.data) : undefined;
}

export function renderMainAgentSection(profile: AgentConfig): string {
  const name = profile.name.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const body = profile.systemPrompt.trim();
  return `<active_agent name="${name}"/>` + (body
    ? `\n\n${profile.promptMode === "append" ? `<agent_instructions>\n${body}\n</agent_instructions>` : body}`
    : "");
}

/** Registers main-only behavior. Fresh child runtimes receive neither flag nor snapshot. */
export function registerMainAgentProfile(pi: ExtensionAPI, overrides: Partial<MainAgentProfileIO> = {}): void {
  const io: MainAgentProfileIO = {
    resolveProfile: resolveMainAgentProfile,
    diagnostic: message => console.error(message),
    ...overrides,
  };
  let selected: MainAgentSnapshot | undefined;
  let failure: string | undefined;
  let lastNotice: string | undefined;
  let runPromptOptions: BuildSystemPromptOptions | undefined;

  pi.registerFlag("agent", { type: "string", description: "Use a main-session agent profile: startup defaults and persistent SYSTEM instructions" });
  pi.registerFlag("agent-model", { type: "string", description: "Override the initial --agent profile's model default (main session only)" });

  function notice(ctx: ExtensionContext, message: string, error = false): void {
    if (lastNotice === message) return;
    lastNotice = message;
    const safe = sanitizeBrowserText(message);
    if (ctx.hasUI) ctx.ui.notify(safe, error ? "error" : "info");
    else io.diagnostic(safe);
  }

  function fail(ctx: ExtensionContext, error: unknown): false {
    failure = `Main agent blocked: ${error instanceof Error ? error.message : String(error)}`;
    // Pi swallows event errors. Input is handled below; context has a live abort
    // signal and stops the provider request. shutdown is advisory (print/SDK may
    // have no shutdown handler); neither process exit nor exit status is claimed.
    if (ctx.signal) ctx.abort();
    ctx.shutdown();
    ctx.ui.setStatus("main-agent", "agent:blocked");
    notice(ctx, failure, true);
    return false;
  }

  function ready(ctx: ExtensionContext): boolean {
    if (failure) return fail(ctx, failure.replace(/^Main agent blocked: /, ""));
    try { if (selected) validateTrust(selected.profile, ctx); return true; }
    catch (error) { return fail(ctx, error); }
  }

  /** Apply defaults once for explicit selection. Never called on restoration or a turn. */
  async function applyDefaults(profile: AgentConfig, ctx: ExtensionContext): Promise<string> {
    if (profile.enabled === false) throw new Error(`Main agent profile "${profile.name}" is disabled.`);
    validateTrust(profile, ctx);
    let model = ctx.model;
    if (profile.model) {
      const slash = profile.model.indexOf("/");
      const resolved = slash < 0 ? resolveModel(profile.model, ctx.modelRegistry)
        : ctx.modelRegistry.find(profile.model.slice(0, slash), profile.model.slice(slash + 1));
      if (!resolved || typeof resolved === "string" || !ctx.modelRegistry.getAvailable().some(m => m.provider === resolved.provider && m.id === resolved.id)) {
        throw new Error(`Unavailable profile model: ${profile.model}.`);
      }
      model = resolved;
    }
    if (profile.thinking !== undefined) {
      if (!parseThinkingLevel(profile.thinking)) throw new Error(thinkingLevelError(profile.thinking));
      if (!model || !getSupportedThinkingLevels(model).includes(profile.thinking)) {
        throw new Error(`Thinking level ${profile.thinking} is unavailable for ${model ? `${model.provider}/${model.id}` : "the current model"}.`);
      }
    }
    const configured = pi.getAllTools();
    // MCP servers connect in the background. A wildcard may match nothing at
    // startup; it selects available tools, not a required connection. Hidden
    // tools are not available matches. Literal missing/hidden names still fail.
    const expanded = expandMcpToolPatterns(profile.toolNames ?? BUILTIN_TOOL_NAMES,
      configured.filter(t => t.exposure !== "hidden").map(t => t.name));
    const tools = [...new Set([...expanded.toolNames, ...MAIN_AGENT_REQUIRED_TOOLS])];
    const missing = tools.filter(name => !configured.some(t => t.name === name && t.exposure !== "hidden"));
    if (missing.length) throw new Error(`Unavailable profile tools (check --tools/--exclude-tools): ${missing.join(", ")}.`);
    if (profile.model && model && (ctx.model?.provider !== model.provider || ctx.model.id !== model.id)) {
      if (!await pi.setModel(model)) throw new Error(`Cannot authenticate profile model: ${model.provider}/${model.id}.`);
    }
    // Model switches choose Pi's own default thinking unless the profile specifies one.
    if (profile.thinking !== undefined) {
      pi.setThinkingLevel(profile.thinking);
      if (pi.getThinkingLevel() !== profile.thinking) throw new Error(`Cannot apply profile thinking: ${profile.thinking}.`);
    }
    pi.setActiveTools(tools);
    const active = pi.getActiveTools();
    if (active.length !== tools.length || tools.some(t => !active.includes(t))) throw new Error("Cannot apply profile tool defaults.");
    const pending = expanded.unmatchedPatterns.length
      ? `\nMCP patterns matched no available tools at startup (servers may still be connecting): ${expanded.unmatchedPatterns.join(", ")}`
      : "";
    return `${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "current model"} · thinking ${pi.getThinkingLevel()} · ${tools.length} active tools${pending}`;
  }

  async function restore(ctx: ExtensionContext, explicit: boolean): Promise<void> {
    selected = undefined;
    failure = undefined;
    runPromptOptions = undefined;
    lastNotice = undefined;
    try {
      const flag = pi.getFlag("agent");
      const override = explicit && typeof flag === "string";
      let saved: MainAgentSnapshot | undefined;
      // Explicit flag can recover a corrupt snapshot. Valid saved state still deduplicates.
      if (override) {
        try { saved = branchSnapshot(ctx); } catch { /* explicit selection supersedes it */ }
      } else saved = branchSnapshot(ctx);
      selected = override ? { version: 1, profile: structuredClone(io.resolveProfile(flag.trim(), ctx)) } : saved;
      if (override && selected) {
        // Core --model is not an extension flag. Launchers mirror their explicit
        // model here; replace only the effective snapshot, never the registry.
        const modelOverride = pi.getFlag("agent-model");
        if (typeof modelOverride === "string") {
          if (!modelOverride.trim()) throw new Error("--agent-model requires a non-empty model.");
          selected.profile.model = modelOverride.trim();
        }
      }
      if (!selected) { ctx.ui.setStatus("main-agent", undefined); return; }
      validateTrust(selected.profile, ctx);
      const defaults = override ? await applyDefaults(selected.profile, ctx) : undefined;
      if (!saved || JSON.stringify(saved) !== JSON.stringify(selected)) pi.appendEntry(MAIN_AGENT_ENTRY, structuredClone(selected));
      const name = sanitizeBrowserText(selected.profile.name).replace(/\s+/g, " ").trim();
      ctx.ui.setStatus("main-agent", `Agent · ${name}`);
      const skipped = [selected.profile.maxTurns !== undefined && "max_turns", selected.profile.runInBackground !== undefined && "run_in_background", selected.profile.inheritContext !== undefined && "inherit_context"].filter(Boolean);
      notice(ctx, `Agent ${name} · ${defaults ? `defaults applied\n${defaults}` : "instructions restored; settings preserved"}${skipped.length ? `\nSubagent-only fields skipped: ${skipped.join(", ")}` : ""}`);
    } catch (error) { fail(ctx, error); }
  }

  pi.on("session_start", async (event, ctx) => {
    // The CLI flag belongs only to the initial session (including CLI resume).
    // Pi retains flag values across replacements: never reuse it for /new or /resume.
    await restore(ctx, event.reason === "startup");
  });
  pi.on("session_tree", async (_event, ctx) => { await restore(ctx, false); });
  pi.on("session_shutdown", () => { selected = undefined; failure = undefined; runPromptOptions = undefined; });
  pi.on("input", (_event, ctx) => ready(ctx) ? undefined : { action: "handled" });
  // RPC/SDK may request summarization while shutdown is deferred or unavailable.
  pi.on("session_before_compact", (_event, ctx) => ready(ctx) ? undefined : { cancel: true });
  pi.on("session_before_tree", (_event, ctx) => ready(ctx) ? undefined : { cancel: true });
  pi.on("before_agent_start", (event, ctx) => {
    if (!ready(ctx) || !selected) return;
    if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
      fail(ctx, "Cannot inject a structured profile into a forced system prompt.");
      return;
    }
    // Shared mutable options expose later opaque overrides, projected after context handlers.
    runPromptOptions = event.systemPromptOptions;
    // Extra sections render after cwd. Parent snapshots also remove this exact
    // captured section before child inheritance; portable identity ignores sections.
    event.systemPromptOptions.sections[MAIN_AGENT_SECTION] = renderMainAgentSection(selected.profile);
  });
  pi.on("context_with_system", (event, ctx) => {
    if (!ready(ctx) || !selected) return;
    const expectedSection = `<${MAIN_AGENT_SECTION}>\n${renderMainAgentSection(selected.profile)}\n</${MAIN_AGENT_SECTION}>`;
    const sections = event.messages.filter(m => m.role === "system").reduce<Record<string, string | null>>((s, m) => ({ ...s, ...m.sections }), {});
    if (runPromptOptions?.forceSystemPrompt !== undefined || !ctx.getSystemPrompt().includes(expectedSection) || sections[MAIN_AGENT_SECTION] !== expectedSection) {
      fail(ctx, "Main agent profile SYSTEM section was removed or replaced.");
    }
  });
}
