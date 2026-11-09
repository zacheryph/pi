/**
 * Scripted model for tests and TUI screenshots.
 *
 * A scenario is a Pi extension that registers the `pi-scripted` provider, a
 * fake model that plays back a fixed script instead of calling an API. Load it
 * only from a test harness (`startSession` in `./harness.ts`) or the
 * tui-screenshot driver, which passes it with `-e` to a Pi running in a
 * throwaway agent directory. It is not part of the bundle manifest, and it
 * registers nothing unless PI_SCRIPTED_MODEL=1 is set, so a stray `-e` or glob
 * cannot put a fake model into a real session.
 *
 * Replies are chosen from the transcript, never from counters, so the same
 * script answers the main session and every subagent: Pi hands the provider
 * down to child sessions.
 */
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type FauxContentBlock,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ENABLE_ENV = "PI_SCRIPTED_MODEL";
export const PROVIDER = "pi-scripted";
export const MODEL = "scripted-model";
/** pi-tldr names sessions with the newest available Haiku; this one answers it. */
export const TITLE_MODEL = "scripted-haiku";

/**
 * Keep the turn open: the model never answers, so Pi shows it as working. A
 * subagent holds on its own once its steps run out.
 */
export const HOLD = Symbol("hold");

/**
 * One model response. A string ends the turn with that text; a list of blocks
 * is one assistant message (tool calls run and the model is asked again).
 */
export type Step = string | FauxContentBlock[] | typeof HOLD;

export interface AgentScript {
  /** subagent_start's subagent_type, e.g. "general-purpose" or "Plan". */
  type: string;
  /** Shown in the tool row and the Subagents widget. */
  description: string;
  /** The agent's task. It also identifies the child session, so keep it unique. */
  prompt: string;
  /** The child's responses. When they run out the child holds, still running. */
  steps?: Step[];
  /** Extra subagent_start parameters (handoff, …). */
  options?: ToolArgs;
}

export interface Scenario {
  /**
   * One list of steps per user turn, in order: each prompt the driver types,
   * and each follow-up Pi starts itself, such as a subagent completion notice.
   * A turn with no steps left ends quietly.
   */
  replies: Step[][];
  /** Session name pi-tldr suggests (shown in the TUI footer). */
  title?: string;
}

export const text = fauxText;
export const thinking = fauxThinking;
/** Tool arguments: JSON, as a model would send them. */
export type ToolArgs = Parameters<typeof fauxToolCall>[1];
export const tool = (name: string, args: ToolArgs) => fauxToolCall(name, args);

const agents = new Map<string, AgentScript>();

/** A subagent_start call whose child session plays `agent.steps`. */
export function startAgent(agent: AgentScript): FauxContentBlock {
  agents.set(agent.prompt, agent);
  return tool("subagent_start", {
    subagent_type: agent.type,
    description: agent.description,
    prompt: agent.prompt,
    ...agent.options,
  });
}

type Message = { role: string; content: unknown };

function messageText(message: Message): string {
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) => (block.type === "text" ? block.text : ""))
    .join("");
}

/**
 * Indexes of the user messages that start a turn. Extensions add context as
 * user messages too, such as pi-todo's task list before the next request. One
 * that follows a tool result arrives mid-turn and does not start a turn, and a
 * run of user messages starts at most one.
 */
export function turnStarts(messages: readonly Message[]): number[] {
  const starts: number[] = [];
  let previous: string | undefined;
  messages.forEach((message, i) => {
    if (message.role !== "user") {
      previous = message.role;
      return;
    }
    if (messages[i - 1]?.role === "user" || previous === "toolResult") return;
    starts.push(i);
  });
  return starts;
}

/** Assistant messages since `start`: the step to play next. */
function stepIndex(messages: readonly Message[], start: number): number {
  return messages.slice(start).filter((m) => m.role === "assistant").length;
}

function hold(signal: AbortSignal | undefined) {
  return new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
    const stop = () => resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop, { once: true });
  });
}

function play(step: Step | undefined, signal: AbortSignal | undefined, holdWhenDone: boolean) {
  if (step === HOLD || (step === undefined && holdWhenDone)) return hold(signal);
  return fauxAssistantMessage(step ?? "");
}

export function defineScenario(scenario: Scenario) {
  return function scriptedScenario(pi: ExtensionAPI) {
    if (process.env[ENABLE_ENV] !== "1") return;

    const faux = fauxProvider({
      provider: PROVIDER,
      models: [
        { id: MODEL, name: "Scripted", contextWindow: 200_000, maxTokens: 8192 },
        { id: TITLE_MODEL, name: "Scripted Haiku", contextWindow: 200_000, maxTokens: 1024 },
      ],
      tokensPerSecond: 400,
    });

    const respond = (
      context: { messages: Message[] },
      options: { signal?: AbortSignal } | undefined,
      _state: unknown,
      model: { id: string },
    ) => {
      const starts = turnStarts(context.messages);
      const turn = starts.length - 1;
      const first = turn >= 0 ? messageText(context.messages[starts[0]!]!) : "";
      if (model.id === TITLE_MODEL) {
        const title = scenario.title ?? "scripted";
        // pi-tldr asks for a bare slug when naming, and for JSON when summarizing.
        if (first.includes("<user_request>")) return fauxAssistantMessage(title);
        return fauxAssistantMessage(
          JSON.stringify({ title, premise: title, findings: "", status: "In progress" }),
        );
      }
      const step = stepIndex(context.messages, starts[turn] ?? 0);
      const agent = [...agents.values()].find((a) => first.includes(a.prompt));
      if (agent) return play(agent.steps?.[step], options?.signal, true);
      const reply = scenario.replies[turn] ?? [];
      return play(reply[step], options?.signal, false);
    };

    // The faux provider plays a queue; every entry is the same pure function.
    faux.setResponses(Array.from({ length: 10_000 }, () => respond));
    pi.registerProvider(faux.provider);
  };
}
