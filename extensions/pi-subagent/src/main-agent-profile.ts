/**
 * Main profiles: startup defaults plus durable SYSTEM instructions. Tool defaults are
 * not capability locks; only a profile's `reserved_tools` refuses calls.
 */
import { errorText } from "#foundations/errors";
import { readEntries } from "#session-state";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  parseFrontmatter,
  type BuildSystemPromptOptions,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { loadCustomAgents } from "#src/config/custom-agents";
import { parseThinkingLevel, thinkingLevelError } from "#src/config/thinking-level";
import { composeAgentInstructions, parseFragments } from "#src/config/prompt-fragments";
import { MAIN_AGENT_SECTION } from "#src/session/main-profile-prompt";
import { resolveToolSelection } from "#src/session/tool-selection";
import { LATEST_SUFFIX, resolveModel } from "#src/session/model-resolver";
import { reservedToolRefusal } from "#src/session/reserved-tools";
import type { AgentConfig } from "#src/types";
import { sanitizeText } from "#ui";

export const MAIN_AGENT_ENTRY = "agent:profile";
/** Provider id of the virtual models that run a profile as the main agent: `agent/<name>`. */
export const AGENT_PROVIDER = "agent";
/** Environment variable that selects the main agent when `--agent` is absent. */
export const MAIN_AGENT_ENV = "PI_MAIN_AGENT";
/** Displayed (never model-visible) notices for hosts that drop `notify`, such as RPC apps. */
export const MAIN_AGENT_NOTICE_TYPE = "agent:notice";
export { MAIN_AGENT_SECTION } from "#src/session/main-profile-prompt";
export const MAIN_AGENT_REQUIRED_TOOLS = [
  "subagent_start",
  "subagent_get",
  "subagent_send",
] as const;

/** Exact profile content, never a pointer to a mutable file or a settings lock. */
export interface MainAgentSnapshot {
  version: 1;
  profile: AgentConfig;
}

export interface MainAgentProfileIO {
  resolveProfile(name: string, ctx: ExtensionContext): AgentConfig;
  diagnostic(message: string): void;
  /** The `PI_MAIN_AGENT` value, if set. */
  env(): string | undefined;
  /** True for a delegated child session, which never takes its profile from the environment. */
  isChild(ctx: ExtensionContext): boolean;
  /** The profile an agent model names, or undefined for any other model. */
  agentModel(model: { provider: string; id: string } | undefined): string | undefined;
}

/** What resolving a main profile reads: the session cwd and whether Pi trusts the project. */
export type ProfileSource = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

/** Main discovery uses the target session cwd, not the child registry's process.cwd closure. */
export function resolveMainAgentProfile(name: string, ctx: ProfileSource): AgentConfig {
  const registry = new AgentTypeRegistry(() => loadCustomAgents(ctx.cwd));
  const key = registry.resolveType(name);
  if (!key) throw new Error(`Unknown main agent profile: "${name}".`);
  const profile = structuredClone(registry.resolveAgentConfig(key));
  if (profile.definitionError)
    throw new Error(`Main agent profile "${key}" cannot load: ${profile.definitionError}`);
  if (profile.visibility === "disabled")
    throw new Error(`Main agent profile "${key}" is disabled.`);
  validateTrust(profile, ctx);
  // Children intentionally tolerate malformed thinking frontmatter. Explicit main
  // defaults must reject it; preserve the existing child-loader policy unchanged.
  if (profile.source === "project" || profile.source === "global") {
    const dir =
      profile.source === "project" ? join(ctx.cwd, ".pi", "agents") : join(getAgentDir(), "agents");
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
  profile.systemPrompt = composeAgentInstructions(profile, {
    projectTrusted: ctx.isProjectTrusted(),
  }).systemPrompt;
  return profile;
}

/**
 * Every profile `--agent <name>` accepts for this source: it parses, is not disabled, passes
 * project trust, and has valid thinking and fragments. Hidden profiles run by name but are
 * not advertised, so pickers leave them out.
 */
export function listMainAgentProfiles(source: ProfileSource): AgentConfig[] {
  const registry = new AgentTypeRegistry(() => loadCustomAgents(source.cwd));
  const profiles: AgentConfig[] = [];
  for (const name of registry.getAllTypes()) {
    try {
      const profile = resolveMainAgentProfile(name, source);
      if ((profile.visibility ?? "visible") === "visible") profiles.push(profile);
    } catch {
      /* Cannot run as the main agent: not offered. */
    }
  }
  return profiles;
}

/** A profile's `model` as an available model, or undefined. */
export function resolveProfileModel(
  spec: string,
  modelRegistry: ExtensionContext["modelRegistry"],
): Model<Api> | undefined {
  const slash = spec.indexOf("/");
  const resolved =
    slash < 0 || spec.toLowerCase().endsWith(LATEST_SUFFIX)
      ? resolveModel(spec, modelRegistry)
      : modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
  if (
    !resolved ||
    typeof resolved === "string" ||
    !modelRegistry
      .getAvailable()
      .some((m) => m.provider === resolved.provider && m.id === resolved.id)
  )
    return undefined;
  return resolved;
}

function validateTrust(profile: AgentConfig, ctx: ProfileSource): void {
  if (profile.source === "project" && !ctx.isProjectTrusted()) {
    throw new Error(
      `Main agent profile "${profile.name}" requires Pi project trust (--approve or /trust).`,
    );
  }
}

function restoredSnapshot(data: unknown): MainAgentSnapshot {
  const s = data as Partial<MainAgentSnapshot> | null;
  if (
    !s ||
    s.version !== 1 ||
    !s.profile ||
    typeof s.profile.name !== "string" ||
    typeof s.profile.systemPrompt !== "string" ||
    typeof s.profile.description !== "string" ||
    !["append", "replace"].includes(s.profile.promptMode) ||
    (s.profile.reservedTools !== undefined &&
      !(
        Array.isArray(s.profile.reservedTools) &&
        s.profile.reservedTools.every((name) => typeof name === "string")
      )) ||
    s.profile.visibility === "disabled" ||
    ![undefined, "default", "global", "project"].includes(s.profile.source)
  ) {
    throw new Error("Invalid saved main agent profile snapshot; refusing to run.");
  }
  return { version: 1, profile: structuredClone(s.profile) };
}

function branchSnapshot(ctx: ExtensionContext): MainAgentSnapshot | undefined {
  const entries = readEntries(ctx, { type: MAIN_AGENT_ENTRY });
  return entries.length ? restoredSnapshot(entries.at(-1)) : undefined;
}

export function renderMainAgentSection(profile: AgentConfig): string {
  const name = profile.name
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const body = profile.systemPrompt.trim();
  return (
    `<active_agent name="${name}"/>` +
    (body
      ? `\n\n${profile.promptMode === "append" ? `<agent_instructions>\n${body}\n</agent_instructions>` : body}`
      : "")
  );
}

/** Registers main-only behavior. Fresh child runtimes receive neither flag nor snapshot. */
export function registerMainAgentProfile(
  pi: ExtensionAPI,
  overrides: Partial<MainAgentProfileIO> = {},
): void {
  const io: MainAgentProfileIO = {
    resolveProfile: resolveMainAgentProfile,
    diagnostic: (message) => console.error(message),
    env: () => process.env[MAIN_AGENT_ENV],
    isChild: () => false,
    agentModel: (model) => (model?.provider === AGENT_PROVIDER ? model.id : undefined),
    ...overrides,
  };
  let selected: MainAgentSnapshot | undefined;
  let failure: string | undefined;
  /** The failure came from picking an agent model: input is blocked, but the session lives. */
  let switchFailure = false;
  let lastNotice: string | undefined;
  let runPromptOptions: BuildSystemPromptOptions | undefined;

  pi.registerFlag("agent", {
    type: "string",
    description:
      "Use a main-session agent profile: startup defaults and persistent SYSTEM instructions",
  });
  pi.registerFlag("agent-model", {
    type: "string",
    description: "Override the initial --agent profile's model default (main session only)",
  });

  /**
   * `display` also writes the message into the transcript outside the terminal UI: RPC
   * hosts drop `notify` and `setStatus`, and without it a blocked agent looks like a hang.
   */
  function notice(ctx: ExtensionContext, message: string, error = false, display = false): void {
    if (lastNotice === message) return;
    lastNotice = message;
    const safe = sanitizeText(message);
    if (ctx.hasUI) ctx.ui.notify(safe, error ? "error" : "info");
    else io.diagnostic(safe);
    if (display && ctx.mode !== "tui") {
      try {
        pi.sendMessage(
          { customType: MAIN_AGENT_NOTICE_TYPE, content: safe, display: true },
          { triggerTurn: false },
        );
      } catch {
        /* The session is already shutting down: nobody is left to tell. */
      }
    }
  }

  function fail(ctx: ExtensionContext, error: unknown): false {
    switchFailure = false;
    failure = `Main agent blocked: ${errorText(error)}`;
    // Pi swallows event errors. Input is handled below; context has a live abort
    // signal and stops the provider request. shutdown is advisory (print/SDK may
    // have no shutdown handler); neither process exit nor exit status is claimed.
    if (ctx.signal) ctx.abort();
    ctx.shutdown();
    ctx.ui.setStatus("agent:status", "agent:blocked");
    notice(ctx, failure, true, true);
    return false;
  }

  function ready(ctx: ExtensionContext): boolean {
    if (failure)
      return switchFailure ? false : fail(ctx, failure.replace(/^Main agent blocked: /, ""));
    try {
      if (selected) validateTrust(selected.profile, ctx);
      return true;
    } catch (error) {
      return fail(ctx, error);
    }
  }

  /** Apply defaults once for explicit selection. Never called on restoration or a turn. */
  async function applyDefaults(
    profile: AgentConfig,
    ctx: ExtensionContext,
    /** The host chose the model and thinking level: apply instructions and tools only. */
    hostModel = false,
  ): Promise<string> {
    if (profile.definitionError)
      throw new Error(
        `Main agent profile "${profile.name}" cannot load: ${profile.definitionError}`,
      );
    if (profile.visibility === "disabled")
      throw new Error(`Main agent profile "${profile.name}" is disabled.`);
    validateTrust(profile, ctx);
    let model = ctx.model;
    if (profile.model && !hostModel) {
      const resolved = resolveProfileModel(profile.model, ctx.modelRegistry);
      if (!resolved) throw new Error(`Unavailable profile model: ${profile.model}.`);
      model = resolved;
    }
    const thinking = hostModel ? undefined : profile.thinking;
    if (thinking !== undefined) {
      if (!parseThinkingLevel(thinking)) throw new Error(thinkingLevelError(thinking));
      if (!model || !getSupportedThinkingLevels(model).includes(thinking)) {
        throw new Error(
          `Thinking level ${thinking} is unavailable for ${model ? `${model.provider}/${model.id}` : "the current model"}.`,
        );
      }
    }
    const configured = pi.getAllTools();
    // MCP servers connect in the background. A wildcard may match nothing at
    // startup; it selects available tools, not a required connection. Hidden
    // tools are not available matches. Literal missing/hidden names still fail.
    const expanded = resolveToolSelection(
      profile.toolNames,
      configured.filter((t) => t.exposure !== "hidden").map((t) => t.name),
    );
    // Explicit exclusions also apply to otherwise mandatory orchestration defaults.
    // Reserved tools leave the active set only: they stay registered, and workers
    // resolve their tools against the registered set, so they still receive them.
    const tools = [...new Set([...expanded.toolNames, ...MAIN_AGENT_REQUIRED_TOOLS])].filter(
      (name) =>
        !expanded.excludedToolNames.includes(name) && !profile.reservedTools?.includes(name),
    );
    const missing = tools.filter(
      (name) => !configured.some((t) => t.name === name && t.exposure !== "hidden"),
    );
    if (missing.length)
      throw new Error(
        `Unavailable profile tools (check --tools/--exclude-tools): ${missing.join(", ")}.`,
      );
    if (
      profile.model &&
      model &&
      (ctx.model?.provider !== model.provider || ctx.model.id !== model.id)
    ) {
      if (!(await pi.setModel(model)))
        throw new Error(`Cannot authenticate profile model: ${model.provider}/${model.id}.`);
    }
    // Model switches choose Pi's own default thinking unless the profile specifies one.
    if (thinking !== undefined) {
      pi.setThinkingLevel(thinking);
      if (pi.getThinkingLevel() !== thinking)
        throw new Error(`Cannot apply profile thinking: ${thinking}.`);
    }
    pi.setActiveTools(tools);
    const active = pi.getActiveTools();
    if (active.length !== tools.length || tools.some((t) => !active.includes(t)))
      throw new Error("Cannot apply profile tool defaults.");
    const pending = expanded.unmatchedPatterns.length
      ? `\nMCP patterns matched no available tools at startup (servers may still be connecting): ${expanded.unmatchedPatterns.join(", ")}`
      : "";
    return `${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "current model"} · thinking ${pi.getThinkingLevel()} · ${tools.length} active tools${pending}`;
  }

  /**
   * `explicit` is a process startup, the only time `--agent` and `PI_MAIN_AGENT` apply.
   * `atStart` is any session start, when an agent model that is already selected applies.
   */
  async function restore(ctx: ExtensionContext, explicit: boolean, atStart = false): Promise<void> {
    selected = undefined;
    failure = undefined;
    switchFailure = false;
    runPromptOptions = undefined;
    lastNotice = undefined;
    try {
      const flag = pi.getFlag("agent");
      const override = explicit && typeof flag === "string";
      // A session that starts on an agent model runs that agent unless its saved profile
      // already is that agent; the flag, being explicit, still wins. Children inherit the
      // parent's model and must not take on its profile.
      const modelAgent =
        atStart && !override && !io.isChild(ctx) ? io.agentModel(ctx.model) : undefined;
      let saved: MainAgentSnapshot | undefined;
      // An explicit selection can recover a corrupt snapshot. Valid saved state still deduplicates.
      if (override || modelAgent) {
        try {
          saved = branchSnapshot(ctx);
        } catch {
          /* explicit selection supersedes it */
        }
      } else saved = branchSnapshot(ctx);
      const byModel = modelAgent !== undefined && saved?.profile.name !== modelAgent;
      // PI_MAIN_AGENT is for hosts that cannot pass --agent. It only starts a session that
      // has no profile yet: the host restarts Pi on every resume, so re-applying would
      // reset the user's tools. The flag and an agent model win, and delegated children
      // never read it.
      const envName =
        override || byModel || !explicit || saved || io.isChild(ctx) ? "" : (io.env() ?? "").trim();
      const fromEnv = envName !== "";
      // The host passes its own --model and --thinking, which win over the profile's.
      const hostModel = fromEnv || byModel;
      const wanted = override ? flag.trim() : byModel ? modelAgent : fromEnv ? envName : undefined;
      selected =
        wanted === undefined
          ? saved
          : { version: 1, profile: structuredClone(io.resolveProfile(wanted, ctx)) };
      if (override && selected) {
        // Core --model is not an extension flag. Launchers mirror their explicit
        // model here; replace only the effective snapshot, never the registry.
        const modelOverride = pi.getFlag("agent-model");
        if (typeof modelOverride === "string") {
          if (!modelOverride.trim()) throw new Error("--agent-model requires a non-empty model.");
          selected.profile.model = modelOverride.trim();
        }
      }
      if (!selected) {
        ctx.ui.setStatus("agent:status", undefined);
        return;
      }
      validateTrust(selected.profile, ctx);
      const defaults =
        wanted !== undefined ? await applyDefaults(selected.profile, ctx, hostModel) : undefined;
      if (!saved || JSON.stringify(saved) !== JSON.stringify(selected))
        pi.appendEntry(MAIN_AGENT_ENTRY, structuredClone(selected));
      announce(ctx, selected, defaults);
    } catch (error) {
      fail(ctx, error);
    }
  }

  function announce(ctx: ExtensionContext, snapshot: MainAgentSnapshot, defaults?: string): void {
    const name = sanitizeText(snapshot.profile.name).replace(/\s+/g, " ").trim();
    ctx.ui.setStatus("agent:status", `Agent · ${name}`);
    const skipped = [
      snapshot.profile.maxTurns !== undefined && "max_turns",
      snapshot.profile.inheritContext !== undefined && "inherit_context",
    ].filter(Boolean);
    notice(
      ctx,
      `Agent ${name} · ${defaults ? `defaults applied\n${defaults}` : "instructions restored; settings preserved"}${skipped.length ? `\nSubagent-only fields skipped: ${skipped.join(", ")}` : ""}`,
      false,
      defaults !== undefined,
    );
  }

  /**
   * An agent model was picked in a running session: run that agent, with the model the
   * virtual model routes to. A profile that cannot load blocks input until another model is
   * picked; it does not end the session, because the user can still choose.
   */
  async function switchAgent(ctx: ExtensionContext, wanted: string): Promise<void> {
    try {
      const snapshot: MainAgentSnapshot = {
        version: 1,
        profile: structuredClone(io.resolveProfile(wanted, ctx)),
      };
      const defaults = await applyDefaults(snapshot.profile, ctx, true);
      selected = snapshot;
      runPromptOptions = undefined;
      pi.appendEntry(MAIN_AGENT_ENTRY, structuredClone(snapshot));
      announce(ctx, snapshot, defaults);
    } catch (error) {
      failure = `Main agent blocked: ${errorText(error)}`;
      switchFailure = true;
      ctx.ui.setStatus("agent:status", "agent:blocked");
      notice(ctx, failure, true, true);
    }
  }

  pi.on("session_start", async (event, ctx) => {
    // The CLI flag belongs only to the initial session (including CLI resume).
    // Pi retains flag values across replacements: never reuse it for /new or /resume.
    await restore(ctx, event.reason === "startup", true);
  });
  pi.on("model_select", async (event, ctx) => {
    if (event.source === "restore") return;
    if (switchFailure) {
      // A failed switch is not terminal: choosing any model clears it and keeps the old profile.
      failure = undefined;
      switchFailure = false;
      lastNotice = undefined;
      ctx.ui.setStatus(
        "agent:status",
        selected ? `Agent · ${sanitizeText(selected.profile.name)}` : undefined,
      );
    }
    if (failure || io.isChild(ctx)) return;
    const wanted = io.agentModel(event.model);
    if (wanted === undefined || selected?.profile.name === wanted) return;
    await switchAgent(ctx, wanted);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await restore(ctx, false);
  });
  pi.on("session_shutdown", () => {
    selected = undefined;
    failure = undefined;
    switchFailure = false;
    runPromptOptions = undefined;
  });
  // The displayed notice is for the user; the model has no use for it.
  pi.on("context", (event) => {
    const messages = event.messages.filter(
      (m) => !(m.role === "custom" && m.customType === MAIN_AGENT_NOTICE_TYPE),
    );
    return messages.length === event.messages.length ? undefined : { messages };
  });
  pi.on("input", (_event, ctx) => (ready(ctx) ? undefined : { action: "handled" }));
  // RPC/SDK may request summarization while shutdown is deferred or unavailable.
  pi.on("session_before_compact", (_event, ctx) => (ready(ctx) ? undefined : { cancel: true }));
  pi.on("session_before_tree", (_event, ctx) => (ready(ctx) ? undefined : { cancel: true }));
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
    event.systemPromptOptions.sections[MAIN_AGENT_SECTION] = renderMainAgentSection(
      selected.profile,
    );
  });
  // Reserved tools are off at selection, but a restored session keeps its own tool
  // set and the user can turn them back on: refuse the call whatever is active.
  pi.on("tool_call", (event) => {
    const profile = selected?.profile;
    return profile?.reservedTools
      ? reservedToolRefusal(event, profile.reservedTools, profile.name)
      : undefined;
  });
  pi.on("context_with_system", (event, ctx) => {
    if (!ready(ctx) || !selected) return;
    const expectedSection = `<${MAIN_AGENT_SECTION}>\n${renderMainAgentSection(selected.profile)}\n</${MAIN_AGENT_SECTION}>`;
    const sections = event.messages
      .filter((m) => m.role === "system")
      .reduce<Record<string, string | null>>((s, m) => ({ ...s, ...m.sections }), {});
    if (
      runPromptOptions?.forceSystemPrompt !== undefined ||
      !ctx.getSystemPrompt().includes(expectedSection) ||
      sections[MAIN_AGENT_SECTION] !== expectedSection
    ) {
      fail(ctx, "Main agent profile SYSTEM section was removed or replaced.");
    }
  });
}
