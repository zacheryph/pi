import { errorText } from "../../../packages/pi-foundations/src/errors.ts";
import { isRecord } from "../../../packages/pi-foundations/src/guards.ts";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  ensureWorkHost,
  QUESTION_KIND,
  type Json,
  type WorkParent,
} from "../../../packages/pi-work/src/index.ts";
import {
  bodyRow,
  openInlineWindow,
  sanitizeLine,
  styleLine,
} from "../../../packages/pi-ui/src/index.ts";
import { CmuxNotifications } from "./cmux.ts";
import { askWithDialogs } from "./dialogs.ts";
import {
  ASK_ANSWER,
  ASK_ANSWER_RESULT,
  ASK_CLOSED,
  ASK_OPENED,
  openedEvent,
  type AskAnswerResult,
  type AskClosedEvent,
} from "./events.ts";
import { Questionnaire } from "./questionnaire.ts";
import {
  AskParameters,
  formatForParent,
  formatOutcome,
  readExternalAnswer,
  readQuestions,
  type AskAnswer,
  type AskOutcome,
  type AskQuestion,
} from "./questions.ts";
import { resolveRoute, type AskRoute } from "./route.ts";

export interface AskDetails {
  route: "user" | "parent";
  /** `asked`: a question to the delegating agent, answered later by its next message to this session. */
  status: "answered" | "cancelled" | "asked";
  questions: string[];
  answers?: AskAnswer[];
}

/** The `owner` of the question items this extension opens, and the ones it adopts. */
export const WORK_OWNER = "pi-ask";

/** The label of a question item: what a delegated session shows as `waiting: answer`. */
const ITEM_LABEL = "answer";

/** What a question item records; persisted with it, so it survives a reload and a restart. */
interface QuestionItemData {
  toolCallId: string;
  /** The question texts, for whoever reads the open item. */
  questions: string[];
  /** The question as the delegator was told it. */
  text: string;
}

const ASKED =
  "Your question was sent to the delegating agent. Your turn ends now: its answer arrives as your next message, and you continue with your context intact. Do not call more tools.";

const SHARED_GUIDELINES = [
  "Use ask only when the answer materially changes what you do: a real decision, conflicting requirements, or a missing fact. Otherwise state your assumption and continue.",
  "Put related questions in one ask call (at most 4). When the answer is a choice, give 2-4 short, distinct options with a description of what each means; put a recommended option first and end its label with (Recommended). A free-text answer is always available, so never add an Other option.",
];

function toolText(route: AskRoute) {
  if (route.kind === "parent")
    return {
      description:
        "Ask the agent that delegated this task 1-4 questions, each with optional choices, when you cannot finish without information or a decision only it has. The question is sent to the delegating agent and your turn ends right after this call; you wait, and its answer arrives as your next message with your context intact.",
      promptSnippet: "Ask the delegating agent a question; your turn ends and its answer wakes you",
      promptGuidelines: [
        ...SHARED_GUIDELINES,
        "Call ask on its own, not together with other tools: your turn ends after it, and the delegating agent's answer arrives as your next message.",
      ],
    };
  return {
    description:
      "Ask the user 1-4 questions, each with optional choices, and wait for the answers. The questions open in a window under the transcript; each question also takes a free-text answer. Returns the answers, or says the user dismissed the questions.",
    promptSnippet: "Ask the user questions with choices and wait for the answers",
    promptGuidelines: SHARED_GUIDELINES,
  };
}

/** An item this extension opened: a question that carries the text the delegator was told. */
const isQuestion = (item: { kind: string; data?: unknown }): boolean =>
  item.kind === QUESTION_KIND &&
  isRecord(item.data) &&
  typeof item.data.text === "string" &&
  Array.isArray(item.data.questions);

/** One ask tool, routed by session: a subagent asks its parent agent, the root session asks the user in an inline window. */
export default function piAsk(pi: ExtensionAPI): void {
  // Per-session state lives in this closure, never in module scope: every
  // subagent session runs this factory again, and a same-cwd child may share
  // this module with its parent.
  let route: AskRoute = { kind: "user", mode: "tui" };
  // The session's work host: a delegated session waits on a question item in it. Called first,
  // so the host is provided (or found) before our own session_start runs.
  const work = ensureWorkHost(pi);
  const notifications = new CmuxNotifications();
  /** Questionnaires on screen, by asking tool call id. */
  const open = new Map<string, { questions: AskQuestion[]; finish(outcome: AskOutcome): void }>();

  const register = () => {
    const text = toolText(route);
    pi.registerTool(
      defineTool<typeof AskParameters, AskDetails>({
        name: "ask",
        label: "Ask",
        // Asking a person or an agent is the model's call alone; scripts never ask.
        exposure: route.kind === "none" ? "hidden" : "model-only",
        executionMode: "sequential",
        description: text.description,
        promptSnippet: text.promptSnippet,
        promptGuidelines: text.promptGuidelines,
        annotations: { readOnlyHint: true, openWorldHint: false },
        parameters: AskParameters,
        execute: (toolCallId, params, signal, _update, ctx) =>
          ask(toolCallId, readQuestions(params), signal, ctx),
        renderCall(args, theme) {
          const questions = Array.isArray(args?.questions) ? args.questions : [];
          const first = questions[0] as { question?: unknown } | undefined;
          const lead = typeof first?.question === "string" ? sanitizeLine(first.question) : "";
          const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
          return new Text(
            theme.fg("toolTitle", theme.bold("ask ")) + theme.fg("muted", `${lead}${more}`),
            0,
            0,
          );
        },
        renderResult(result, { isPartial }, theme) {
          if (isPartial) return new Text(theme.fg("muted", "Waiting for an answer…"), 0, 0);
          const details = result.details;
          if (!details || !Array.isArray(details.questions))
            return new Text(theme.fg("error", sanitizeLine(textOf(result))), 0, 0);
          const rows =
            // "recorded" is what transcripts written before questions became work items say.
            details.status === "asked" || (details.status as string) === "recorded"
              ? [
                  [
                    {
                      text: "Asked the delegating agent; waiting for its answer",
                      tone: "muted" as const,
                    },
                  ],
                ]
              : details.status === "cancelled"
                ? [[{ text: "Dismissed without an answer", tone: "warning" as const }]]
                : (Array.isArray(details.answers) ? details.answers : []).map((answer) => [
                    { text: `${String(answer.question)} `, tone: "muted" as const },
                    {
                      text: [
                        ...(Array.isArray(answer.selected) ? answer.selected.map(String) : []),
                        ...(typeof answer.text === "string" ? [answer.text] : []),
                      ].join(", "),
                      tone: "accent" as const,
                    },
                  ]);
          return {
            render: (width: number) => rows.map((row) => bodyRow(styleLine(row, theme), width)),
            invalidate() {},
          };
        },
      }),
    );
  };

  const ask = async (
    toolCallId: string,
    questions: AskQuestion[],
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<AskDetails>> => {
    const current = resolveRoute(ctx);
    const asked = questions.map((question) => question.question);
    if (current.kind === "parent") {
      askParent(current.parent, toolCallId, questions, asked);
      return {
        content: [{ type: "text", text: ASKED }],
        details: { route: "parent", status: "asked", questions: asked },
        // The turn ends after the tool batch (when every tool in it terminates): the session is
        // then idle, waiting on the question item. The delegator's next message wakes it.
        terminate: true,
      };
    }
    if (current.kind === "none")
      throw new Error(
        "No one can answer questions in this session: it has no interactive terminal and no delegating agent. Continue with your best judgment and say what you assumed.",
      );
    if (signal?.aborted) throw new Error("ask was cancelled before the questions were shown.");
    const outcome = await (current.mode === "rpc"
      ? askWithDialogs(ctx.ui, questions, signal ? { signal } : {})
      : askInline(toolCallId, questions, signal, ctx));
    return {
      content: [{ type: "text", text: formatOutcome(outcome) }],
      details: {
        route: "user",
        status: outcome.status,
        questions: asked,
        ...(outcome.status === "answered" ? { answers: outcome.answers } : {}),
      },
    };
  };

  /**
   * Open the question item in the session's own host, then tell the delegator. The item comes
   * first: it is what keeps the session open and what a reload adopts, so a delegator that has
   * heard the question always has a session that is waiting for its answer. A delegator that
   * cannot be told leaves nobody to answer, so the item is withdrawn and the model hears why.
   */
  const askParent = (
    parent: WorkParent,
    toolCallId: string,
    questions: AskQuestion[],
    asked: string[],
  ): void => {
    const host = work.host();
    if (!host)
      throw new Error(
        "This session has no work host to wait on the delegating agent's answer. Continue with your best judgment and say what you assumed.",
      );
    const text = formatForParent(questions);
    const data: QuestionItemData = { toolCallId, questions: asked, text };
    const item = host.open({
      owner: WORK_OWNER,
      kind: QUESTION_KIND,
      label: ITEM_LABEL,
      data: data as unknown as Json,
    });
    try {
      parent.question(text);
    } catch (error) {
      item.cancel();
      throw new Error(
        `The delegating agent could not be reached (${errorText(error)}). Continue with your best judgment and say what you assumed.`,
      );
    }
  };

  const askInline = async (
    toolCallId: string,
    questions: AskQuestion[],
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<AskOutcome> => {
    let closed: AskClosedEvent["outcome"] = "error";
    let closeNotification: (() => void) | undefined;
    let finish: ((outcome: AskOutcome) => void) | undefined;
    // An answer from outside can arrive before the window has mounted.
    let early: AskOutcome | undefined;
    open.set(toolCallId, {
      questions,
      finish: (outcome) => (finish ? finish(outcome) : (early = outcome)),
    });
    const abort = () => open.get(toolCallId)?.finish({ status: "cancelled" });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      closeNotification = notifications.open();
      pi.events.emit(ASK_OPENED, openedEvent(toolCallId, questions));
      const outcome = await openInlineWindow<AskOutcome>(
        ctx,
        { icon: "?", label: questions.length > 1 ? `${questions.length} questions` : "Question" },
        (tui, theme, keys, done) => {
          finish = done;
          if (early) queueMicrotask(() => done(early!));
          return new Questionnaire(questions, theme, keys, tui, done);
        },
        { minimizedHint: "waiting for your answer · any key returns" },
      );
      const result = outcome ?? { status: "cancelled" as const };
      closed = result.status;
      return result;
    } finally {
      closeNotification?.();
      signal?.removeEventListener("abort", abort);
      open.delete(toolCallId);
      pi.events.emit(ASK_CLOSED, { toolCallId, outcome: closed } satisfies AskClosedEvent);
    }
  };

  pi.events.on(ASK_ANSWER, (data) => {
    const reply = (result: AskAnswerResult) => pi.events.emit(ASK_ANSWER_RESULT, result);
    const requestId =
      isRecord(data) && typeof data.requestId === "string" ? data.requestId : undefined;
    if (!isRecord(data) || typeof data.toolCallId !== "string") {
      reply({
        ok: false,
        code: "invalid_payload",
        reason: "toolCallId is required.",
        ...(requestId ? { requestId } : {}),
      });
      return;
    }
    const echo = { toolCallId: data.toolCallId, ...(requestId ? { requestId } : {}) };
    const entry = open.get(data.toolCallId);
    if (!entry) {
      reply({
        ok: false,
        code: "not_found",
        reason: "No open questionnaire has that id.",
        ...echo,
      });
      return;
    }
    const outcome = readExternalAnswer(entry.questions, data);
    if ("code" in outcome) {
      reply({ ok: false, code: outcome.code, reason: outcome.reason, ...echo });
      return;
    }
    entry.finish(outcome);
    reply({ ok: true, ...echo });
  });

  pi.on("session_start", (_event, ctx) => {
    const next = resolveRoute(ctx);
    if (next.kind !== route.kind) {
      route = next;
      register();
    }
    // A delegated session that was reloaded or restarted while a question stood: the question is
    // still open and the delegator was told once, so take it over rather than have the host
    // report it lost. Anywhere else a question item is not ours to keep.
    work.host()?.adopt(WORK_OWNER, (item) => next.kind === "parent" && isQuestion(item));
  });

  pi.on("session_shutdown", () => notifications.shutdown());

  register();
}

function textOf(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => (item as { text: string }).text)
    .join("\n");
}
