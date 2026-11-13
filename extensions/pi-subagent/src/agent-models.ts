/**
 * Agents as virtual models. A host that lists Pi's models (bb's picker) can then choose a main
 * agent: `agent/orchestrate`. Selecting one runs that profile (see main-agent-profile.ts);
 * the virtual model only decides which physical model answers each request.
 */
import { getAgentDir, SettingsManager as PiSettings } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionVirtualModel,
  ModelRoute,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import {
  AGENT_PROVIDER,
  listMainAgentProfiles,
  resolveProfileModel,
  type ProfileSource,
} from "#src/main-agent-profile";
import type { AgentConfig } from "#src/types";

/** Thinking levels offered for selection. Pi clamps the one chosen to the routed model. */
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies ExtensionVirtualModel["thinkingLevels"];

/** `Model.api` of every virtual model: a request for it fails unless it is routed first. */
const VIRTUAL_API = "pi-virtual";

export const isVirtualModel = (model: { api: string }): boolean => model.api === VIRTUAL_API;

type RouteContext = Pick<ExtensionContext, "cwd" | "modelRegistry" | "sessionManager"> &
  Partial<Pick<ExtensionContext, "isProjectTrusted">>;

export interface AgentModelDeps {
  /** Profiles that can run as the main agent, for one project. */
  profiles(source: ProfileSource): AgentConfig[];
  /** Pi's own configured default model, ahead of its first available one. */
  defaultModel(ctx: RouteContext): Model<Api> | undefined;
}

/** The model Pi's settings name as the default, when it exists. */
function configuredDefault(ctx: RouteContext): Model<Api> | undefined {
  try {
    const settings = PiSettings.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted?.() ?? false,
    });
    const provider = settings.getDefaultProvider();
    const id = settings.getDefaultModel();
    return provider && id ? ctx.modelRegistry.find(provider, id) : undefined;
  } catch {
    return undefined;
  }
}

const defaultDeps: AgentModelDeps = {
  profiles: listMainAgentProfiles,
  defaultModel: configuredDefault,
};

/** A physical model with credentials, or undefined. */
function usable(ctx: RouteContext, model: Model<Api> | undefined): Model<Api> | undefined {
  return model && !isVirtualModel(model) && ctx.modelRegistry.hasConfiguredAuth(model)
    ? model
    : undefined;
}

/** The physical model that last answered in this session, from its transcript. */
function lastAnswering(ctx: RouteContext): Model<Api> | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const { provider, model } = entry.message;
    const found = usable(ctx, ctx.modelRegistry.find(provider, model));
    if (found) return found;
  }
  return undefined;
}

/**
 * The physical model for a profile that has no say: the one the session last used, then
 * Pi's configured default, then the first model with credentials.
 */
export function sessionModel(
  ctx: RouteContext,
  deps: Pick<AgentModelDeps, "defaultModel"> = defaultDeps,
): Model<Api> | undefined {
  return (
    lastAnswering(ctx) ??
    usable(ctx, deps.defaultModel(ctx)) ??
    ctx.modelRegistry.getAvailable().find((model) => usable(ctx, model))
  );
}

/**
 * Pick the physical model for one request made with an agent model.
 *
 * Tool follow-ups stay on the model that handled the turn (`previous`) and retries on the one
 * that failed, so prompt caches and thinking signatures stay valid. A new turn, or a request
 * with nothing to stay on, goes to the profile's own model if it resolves and has credentials,
 * else the model the session last used, else Pi's default. The selected thinking level goes
 * through; Pi clamps it.
 */
export function routeAgentModel(
  request: ModelRouteRequest,
  ctx: RouteContext,
  profile: Pick<AgentConfig, "name" | "model">,
  deps: Pick<AgentModelDeps, "defaultModel"> = defaultDeps,
): ModelRoute {
  const sticky =
    request.reason === "continuation"
      ? request.previous
      : request.reason === "retry"
        ? (request.failed ?? request.previous)
        : undefined;
  if (sticky)
    return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel };
  const configured = profile.model
    ? usable(ctx, resolveProfileModel(profile.model, ctx.modelRegistry))
    : undefined;
  const model = configured ?? usable(ctx, request.previous?.model) ?? sessionModel(ctx, deps);
  if (!model)
    throw new Error(`Agent ${profile.name} has no model to run on: no provider has credentials.`);
  return { model, thinkingLevel: request.thinkingLevel };
}

/**
 * The model a child session inherits from its parent. An agent model is the parent's choice of
 * profile, not of provider, and a child would route it again with no history to go on: it gets
 * the physical model the parent has been answering with instead.
 */
export function inheritableModel<T extends { provider: string; api: string }>(
  model: T | undefined,
  routeContext: RouteContext,
): T | Model<Api> | undefined {
  if (!model || model.provider !== AGENT_PROVIDER || !isVirtualModel(model)) return model;
  return sessionModel(routeContext) ?? model;
}

export interface AgentModels {
  /** The profile an agent model names, when this extension registered it. */
  profileOf(model: { provider: string; id: string } | undefined): string | undefined;
  /** Bring the registered models in line with this project's profiles. */
  sync(source: ProfileSource, keep?: string): void;
  /** Names currently registered. */
  names(): string[];
}

/**
 * Register one virtual model per profile that can run as the main agent, under the provider
 * `agent`. Registration happens now, from the launch directory, because `--provider agent
 * --model <name>` is resolved before any session starts; `sync` narrows it once the
 * session's directory and project trust are known.
 */
export function registerAgentModels(
  pi: ExtensionAPI,
  options: { enabled: boolean; source?: ProfileSource; deps?: Partial<AgentModelDeps> },
): AgentModels {
  const deps: AgentModelDeps = { ...defaultDeps, ...options.deps };
  const registered = new Map<string, AgentConfig>();

  function sync(source: ProfileSource, keep?: string): void {
    if (!options.enabled) return;
    const wanted = new Map(deps.profiles(source).map((profile) => [profile.name, profile]));
    // A model that is selected stays so a profile that cannot load is reported, not a
    // model that Pi cannot route.
    const kept = keep ? registered.get(keep) : undefined;
    if (keep && kept && !wanted.has(keep)) wanted.set(keep, kept);
    for (const name of registered.keys()) {
      if (wanted.has(name)) continue;
      registered.delete(name);
      try {
        pi.unregisterVirtualModel(AGENT_PROVIDER, name);
      } catch {
        /* The session is gone. */
      }
    }
    for (const [name, profile] of wanted) {
      registered.set(name, profile);
      pi.registerVirtualModel({
        provider: AGENT_PROVIDER,
        id: name,
        name: `Agent · ${name}`,
        thinkingLevels: THINKING_LEVELS,
        route: (request, ctx) =>
          routeAgentModel(request, ctx, registered.get(name) ?? profile, deps),
      });
    }
  }

  if (options.enabled && options.source) sync(options.source);

  return {
    profileOf: (model) =>
      model?.provider === AGENT_PROVIDER && registered.has(model.id) ? model.id : undefined,
    sync,
    names: () => [...registered.keys()],
  };
}
