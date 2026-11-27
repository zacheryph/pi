/**
 * `/subagent:switch <profile> [focus]`: compact the conversation for the profile that takes
 * over, then run that profile.
 *
 * Switching profiles replaces the system prompt section and the active tools, so the prompt
 * cache starts over either way. Compacting first leaves the new profile a summary written for
 * it, instead of a transcript of the old profile's habits.
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { errorText } from "#foundations/errors";
import { AGENT_PROVIDER, type MainAgentProfileHandle } from "#src/main-agent-profile";
import type { AgentConfig } from "#src/types";

export type OutputLevel = "info" | "warning" | "error";

export interface SwitchCommandDeps {
  /** Profiles that can run as the main agent in this session's directory. */
  profiles(ctx: ExtensionContext): readonly AgentConfig[];
  /** The named profile, or a thrown error saying why it cannot run. */
  resolve(name: string, ctx: ExtensionContext): AgentConfig;
  /** The profile the main agent runs now. */
  current(): Readonly<AgentConfig> | undefined;
  /** Run the named profile; true when it now runs. */
  activate(ctx: ExtensionContext, name: string): Promise<boolean>;
  show(ctx: ExtensionContext, text: string, level: OutputLevel): void;
}

/** Errors Pi raises when there is nothing to summarize: the switch still goes ahead. */
const NOTHING_TO_COMPACT = /^(Nothing to compact|Already compacted)/;

/** Copied exactly in every handoff, whichever profile takes over. */
const ALWAYS_KEEP = [
  "stash handles (stash:<name>@<hash>)",
  "IDs of subagents that are running or waiting, with what each is doing",
  "worktree paths and branches",
  "pull request URLs",
  "questions still waiting on the user",
];

/** The compaction instructions that hand this conversation to `target`. */
export function handoffInstructions(
  target: Pick<AgentConfig, "name" | "handoff">,
  from: Pick<AgentConfig, "name"> | undefined,
  focus: string,
): string {
  const parts = [
    `This compaction hands the conversation ${from ? `from the ${from.name} agent profile ` : ""}to the ${target.name} agent profile, which continues from your summary under different instructions. Write the summary for ${target.name}.`,
    "Record what was asked, decided and found. Leave out how the previous profile worked and what it said it would do next: the new profile decides that.",
    `Copy these exactly, never paraphrased: ${ALWAYS_KEEP.join("; ")}.`,
  ];
  if (target.handoff)
    parts.push(`What ${target.name} needs from this conversation:\n${target.handoff}`);
  const wanted = focus.trim();
  if (wanted) parts.push(`The user also asked to keep: ${wanted}`);
  return parts.join("\n\n");
}

type CompactOutcome = { ok: true; compacted: boolean } | { ok: false; error: string };

function compactFor(ctx: ExtensionContext, customInstructions: string): Promise<CompactOutcome> {
  return new Promise((resolve) => {
    try {
      ctx.compact({
        customInstructions,
        onComplete: () => resolve({ ok: true, compacted: true }),
        onError: (error) =>
          resolve(
            NOTHING_TO_COMPACT.test(error.message)
              ? { ok: true, compacted: false }
              : { ok: false, error: errorText(error) },
          ),
      });
    } catch (error) {
      resolve({ ok: false, error: errorText(error) });
    }
  });
}

function usage(deps: SwitchCommandDeps, ctx: ExtensionContext): string {
  const current = deps.current()?.name;
  const names = deps
    .profiles(ctx)
    .map((p) => (p.name === current ? `${p.name} (running)` : p.name))
    .join(", ");
  return `Usage: /subagent:switch <profile> [what to keep]\nProfiles: ${names || "(none)"}`;
}

async function pick(
  deps: SwitchCommandDeps,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const current = deps.current()?.name;
  const choices = deps.profiles(ctx).filter((p) => p.name !== current);
  if (!ctx.hasUI || !choices.length) {
    deps.show(ctx, usage(deps, ctx), "info");
    return undefined;
  }
  const labels = choices.map((p) => `${p.name} — ${p.description}`);
  const choice = await ctx.ui.select("Compact and switch to", labels);
  return choice === undefined ? undefined : choices[labels.indexOf(choice)]?.name;
}

export async function runSwitchCommand(
  args: string,
  ctx: ExtensionCommandContext,
  deps: SwitchCommandDeps,
): Promise<void> {
  const trimmed = args.trim();
  const space = trimmed.search(/\s/);
  const name = space < 0 ? trimmed : trimmed.slice(0, space);
  const focus = space < 0 ? "" : trimmed.slice(space + 1);
  const wanted = name || (await pick(deps, ctx));
  if (!wanted) return;

  let target: AgentConfig;
  try {
    target = deps.resolve(wanted, ctx);
  } catch (error) {
    deps.show(ctx, `${errorText(error)}\n${usage(deps, ctx)}`, "error");
    return;
  }
  const from = deps.current();
  if (from?.name === target.name) {
    deps.show(ctx, `Already running ${target.name}.`, "info");
    return;
  }

  await ctx.waitForIdle();
  deps.show(ctx, `Compacting for ${target.name}…`, "info");
  const outcome = await compactFor(ctx, handoffInstructions(target, from, focus));
  if (!outcome.ok) {
    deps.show(
      ctx,
      `Compaction failed, so ${from?.name ?? "the session"} keeps running: ${outcome.error}\nTo switch without compacting: /model agent/${target.name}`,
      "error",
    );
    return;
  }
  // The profile reports its own failure (and blocks input) when it cannot run.
  if (!(await deps.activate(ctx, target.name))) return;
  deps.show(
    ctx,
    outcome.compacted
      ? `Compacted for ${target.name} and switched.`
      : `Nothing to compact; switched to ${target.name}.`,
    "info",
  );
}

/**
 * `SwitchCommandDeps.activate` as pi-subagent wires it. A session on an agent model switches by
 * picking the target's agent model, so the model it routes through and the profile stay in
 * step; any other session keeps its model and switches the profile alone.
 */
export function activateProfile(
  pi: Pick<ExtensionAPI, "setModel">,
  agentModels: {
    profileOf(model: { provider: string; id: string } | undefined): string | undefined;
  },
  profile: MainAgentProfileHandle,
): SwitchCommandDeps["activate"] {
  return async (ctx, name) => {
    const virtual =
      agentModels.profileOf(ctx.model) !== undefined
        ? ctx.modelRegistry.find(AGENT_PROVIDER, name)
        : undefined;
    if (virtual && (await pi.setModel(virtual))) return profile.current()?.name === name;
    return profile.switchTo(ctx, name);
  };
}
