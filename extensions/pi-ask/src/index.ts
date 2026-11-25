import { errorText } from "#foundations/errors";
import { isRecord } from "#foundations/guards";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ensureWorkHost, QUESTION_KIND, type Json, type WorkParent } from "#work";
import { bodyRow, openInlineWindow, sanitizeLine, styleLine } from "#ui";
import { CmuxNotifications } from "#foundations/cmux";
import { Type } from "typebox";
import { askWithDialogs } from "#src/dialogs";
import {
  actionRegistry,
  FORM_VIEW_ID,
  hasFormConsumer,
  isFormAnswer,
  isJsonObject,
  onFormCapabilityChanged,
  viewRegistry,
  type FormAnswer,
  type JsonValue,
} from "#surface";
import { ASK_CANCEL_ACTION, ASK_SUBMIT_ACTION, type AskAnswerResult } from "#src/events";
import { OpenQuestionnaires, type PendingQuestionnaire } from "#src/owner";
import { Questionnaire } from "#src/questionnaire";
import {
  AskParameters,
  formatForParent,
  formatOutcome,
  readQuestions,
  type AskAnswer,
  type AskOutcome,
  type AskQuestion,
  type CancelReason,
} from "#src/questions";
import { resolveRoute, type AskRoute } from "#src/route";

export interface AskDetails {
  route: "user" | "parent";
  /** `asked`: a question to the delegating agent, answered later by its next message to this session. */
  status: "answered" | "cancelled" | "asked";
  questions: string[];
  answers?: AskAnswer[];
  /** Why a cancelled questionnaire was withdrawn; absent when the user declined it. */
  reason?: CancelReason;
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

/** The transcript row of questions withdrawn before anyone answered them. */
const WITHDRAWN_ROW: Record<CancelReason, string> = {
  aborted: "Withdrawn: the call was aborted",
  unavailable: "Withdrawn: nobody was left to answer",
  ended: "Withdrawn: the session ended",
};

/** What the cmux notification for an open questionnaire says: never the questions or answers. */
const QUESTION_NOTICE = {
  title: "Pi needs your input",
  body: "Answer the questions in your terminal.",
};

export const NOTIFY_TOOL_NAME = "user_notify";
export const MAX_NOTIFY_TITLE = 80;
export const MAX_NOTIFY_BODY = 300;

const NotifyParameters = Type.Object(
  {
    title: Type.String({
      minLength: 1,
      maxLength: MAX_NOTIFY_TITLE,
      description: "What needs the user, in a few words, e.g. PR 12 is ready for review",
    }),
    body: Type.String({
      minLength: 1,
      maxLength: MAX_NOTIFY_BODY,
      description: "One or two sentences: what to do and where (a URL, a step, a failing check)",
    }),
  },
  { additionalProperties: false },
);

export interface NotifyDetails {
  title: string;
  body: string;
  /** False when no native notification was shown: the message is in the transcript only. */
  delivered: boolean;
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
  // ask.questions, ask.submit and ask.cancel live on this session's bus from
  // session_start to session_shutdown, so a /reload, which runs this factory again on the same
  // bus, does not leak them.
  const actions = actionRegistry(pi.events);
  const views = viewRegistry(pi.events);
  /** Every questionnaire waiting for the user, whoever shows it. */
  const questionnaires = new OpenQuestionnaires({ changed: () => views.changed(FORM_VIEW_ID) });

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
                ? [
                    [
                      {
                        text:
                          typeof details.reason === "string" && details.reason in WITHDRAWN_ROW
                            ? WITHDRAWN_ROW[details.reason]
                            : "Dismissed without an answer",
                        tone: "warning" as const,
                      },
                    ],
                  ]
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

  const registerNotify = () => {
    pi.registerTool(
      defineTool<typeof NotifyParameters, NotifyDetails>({
        name: NOTIFY_TOOL_NAME,
        label: "Notify user",
        // Only the session the user sits at alerts them; a delegated session reports to its parent.
        exposure: route.kind === "user" ? "model-only" : "hidden",
        description:
          "Send the user a native desktop notification that something outside this session now waits on them, and continue. It does not wait for an answer (use ask for that). Returns whether a notification was shown; where none can be, the message stays in the transcript.",
        promptSnippet: "Alert the user that work waits on them, without waiting for an answer",
        promptGuidelines: [
          "Call user_notify when you are about to end your turn waiting on something only the user can do outside this session (review or merge a pull request, unblock a step, look at a failed check). Send one per event, not progress updates, and do not repeat it when woken for something else.",
        ],
        annotations: { readOnlyHint: true, openWorldHint: false },
        parameters: NotifyParameters,
        async execute(_toolCallId, params, _signal, _update, ctx) {
          if (resolveRoute(ctx).kind !== "user")
            throw new Error(
              "Only the main session can notify the user. Report to the delegating agent instead.",
            );
          const title = sanitizeLine(params.title).slice(0, MAX_NOTIFY_TITLE);
          const body = sanitizeLine(params.body).slice(0, MAX_NOTIFY_BODY);
          const delivered = await notifications.send({ title, body });
          return {
            content: [
              {
                type: "text",
                text: delivered
                  ? "The user was notified."
                  : "No native notification could be shown here (not in cmux, or cmux did not take it). The message is in the transcript only; do not retry.",
              },
            ],
            details: { title, body, delivered },
          };
        },
        renderCall(args, theme) {
          const title = typeof args?.title === "string" ? sanitizeLine(args.title) : "";
          return new Text(
            theme.fg("toolTitle", theme.bold("notify ")) + theme.fg("muted", title),
            0,
            0,
          );
        },
        renderResult(result, { isPartial }, theme) {
          if (isPartial) return new Text(theme.fg("muted", "Notifying…"), 0, 0);
          const details = result.details;
          if (!details || typeof details.body !== "string")
            return new Text(theme.fg("error", sanitizeLine(textOf(result))), 0, 0);
          const rows = [
            [{ text: details.body, tone: "default" as const }],
            ...(details.delivered
              ? []
              : [[{ text: "No native notification: shown here only", tone: "warning" as const }]]),
          ];
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
    const outcome = await (current.mode === "tui"
      ? askInline(toolCallId, questions, signal, ctx)
      : hasFormConsumer(pi.events)
        ? askForm(toolCallId, questions, signal, ctx)
        : // No consumer can answer a form: Pi's own dialogs, exactly as before forms existed.
          askWithDialogs(ctx.ui, questions, signal ? { signal } : {}));
    return {
      content: [{ type: "text", text: formatOutcome(outcome) }],
      details: {
        route: "user",
        status: outcome.status,
        questions: asked,
        ...(outcome.status === "answered" ? { answers: outcome.answers } : {}),
        ...(outcome.status === "cancelled" && outcome.reason ? { reason: outcome.reason } : {}),
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

  /**
   * Opens a published questionnaire and waits for `show` or any form consumer to settle it.
   * Every route that publishes goes through here: the record leaves the form however it ends.
   */
  const publishAndWait = async (
    toolCallId: string,
    questions: AskQuestion[],
    signal: AbortSignal | undefined,
    show: (record: PendingQuestionnaire) => Promise<void>,
    options: { notify?: boolean } = {},
  ): Promise<AskOutcome> => {
    // Refused before anything is shown or announced when the form cannot carry it.
    const record = questionnaires.open(toolCallId, questions);
    let closeNotification: (() => void) | undefined;
    const abort = () => record.settle({ status: "cancelled", reason: "aborted" });
    signal?.addEventListener("abort", abort, { once: true });
    // A consumer that saw the form announced may already have aborted the call.
    if (signal?.aborted) abort();
    try {
      if (options.notify) closeNotification = notifications.open(QUESTION_NOTICE);
      await show(record);
      return await record.done;
    } finally {
      closeNotification?.();
      signal?.removeEventListener("abort", abort);
      // After an error nothing may still wait on it.
      record.settle({ status: "cancelled", reason: "aborted" });
    }
  };

  /** The terminal's keyboard questionnaire, over a record any form consumer can answer too. */
  const askInline = (
    toolCallId: string,
    questions: AskQuestion[],
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<AskOutcome> =>
    publishAndWait(
      toolCallId,
      questions,
      signal,
      async (record) => {
        // Answered from outside before the window could open: nothing to show.
        if (record.outcome) return;
        const shown = await openInlineWindow<AskOutcome>(
          ctx,
          { icon: "?", label: questions.length > 1 ? `${questions.length} questions` : "Question" },
          (tui, theme, keys, done) => {
            // Settled elsewhere (a form consumer, an abort, shutdown): the window closes.
            const close = () => done(record.outcome!);
            if (record.outcome) queueMicrotask(close);
            else record.signal.addEventListener("abort", close, { once: true });
            return new Questionnaire(questions, theme, keys, tui, (outcome) => {
              record.settle(outcome);
            });
          },
          { minimizedHint: "waiting for your answer · any key returns" },
        );
        record.settle(shown ?? { status: "cancelled" });
      },
      { notify: true },
    );

  /**
   * RPC with a live form consumer: the questionnaire is published and a consumer answers it.
   * When the last consumer goes before an answer, the form is withdrawn for good and Pi's own
   * dialogs ask instead; with none available the questions are withdrawn, and the model is told.
   */
  const askForm = (
    toolCallId: string,
    questions: AskQuestion[],
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<AskOutcome> =>
    publishAndWait(toolCallId, questions, signal, async (record) => {
      const handOver = () => {
        if (record.outcome || !record.published) return;
        // Off the form first: from here only the dialog answers, so no answer counts twice.
        record.withdraw();
        if (!dialogsAvailable(ctx)) {
          record.settle({ status: "cancelled", reason: "unavailable" });
          return;
        }
        void (async () => {
          try {
            record.settle(await askWithDialogs(ctx.ui, questions, { signal: record.signal }));
          } catch {
            record.settle({ status: "cancelled", reason: "unavailable" });
          }
        })();
      };
      const stop = onFormCapabilityChanged(pi.events, (available) => {
        if (!available) handOver();
      });
      void record.done.finally(stop);
      // The consumer may have gone between choosing this route and subscribing.
      if (!hasFormConsumer(pi.events)) handOver();
    });

  pi.on("session_start", (_event, ctx) => {
    actions.dispose();
    views.dispose();
    // Questionnaires of a session this one replaces have nobody left to answer them.
    questionnaires.cancelAll("ended");
    actions.define({
      id: ASK_SUBMIT_ACTION,
      title: "Answer a questionnaire of the open questions form",
      parse: readSubmit,
      handler: ({ id, answer }) =>
        accepted(questionnaires.answer({ toolCallId: id, ...answer }), "answered"),
    });
    actions.define({
      id: ASK_CANCEL_ACTION,
      title: "Decline a questionnaire of the open questions form",
      parse: readCancel,
      handler: ({ id }) =>
        accepted(questionnaires.answer({ toolCallId: id, cancel: true }), "cancelled"),
    });
    views.define({
      id: FORM_VIEW_ID,
      kind: "form",
      title: "Questions",
      model: () => questionnaires.form(),
    });
    const next = resolveRoute(ctx);
    if (next.kind !== route.kind) {
      route = next;
      register();
      registerNotify();
    }
    // A delegated session that was reloaded or restarted while a question stood: the question is
    // still open and the delegator was told once, so take it over rather than have the host
    // report it lost. Anywhere else a question item is not ours to keep.
    work.host()?.adopt(WORK_OWNER, (item) => next.kind === "parent" && isQuestion(item));
  });

  pi.on("session_shutdown", () => {
    // Removed without announcing (see pi-surface's viewRegistry); then nothing is left waiting.
    views.dispose();
    actions.dispose();
    questionnaires.cancelAll("ended");
    return notifications.shutdown();
  });

  register();
  registerNotify();
}

/** Whether Pi can still show its own dialogs through this context; a stale one cannot. */
function dialogsAvailable(ctx: ExtensionContext): boolean {
  try {
    return ctx.hasUI;
  } catch {
    return false;
  }
}

/** `ask.submit`'s arguments: the questionnaire's `{ id }` and a `FormAnswer`, nothing else. */
function readSubmit(args: JsonValue | undefined): { id: string; answer: FormAnswer } {
  if (!isJsonObject(args) || typeof args.id !== "string")
    throw new Error("expected { id, answers }");
  const { id, answers, globalNote, ...rest } = args;
  const extra = Object.keys(rest);
  if (extra.length) throw new Error(`unexpected field "${extra[0]}"`);
  const answer = { answers, ...(globalNote !== undefined ? { globalNote } : {}) };
  if (!isFormAnswer(answer)) throw new Error("answers is not a well-formed form answer");
  return { id, answer };
}

/** `ask.cancel`'s arguments: the questionnaire's `{ id }`. */
function readCancel(args: JsonValue | undefined): { id: string } {
  if (!isJsonObject(args) || typeof args.id !== "string") throw new Error("expected { id }");
  const extra = Object.keys(args).filter((key) => key !== "id");
  if (extra.length) throw new Error(`unexpected field "${extra[0]}"`);
  return { id: args.id };
}

/** A form action's result once accepted; a refusal becomes the action's error. */
function accepted(result: AskAnswerResult, status: "answered" | "cancelled"): JsonValue {
  if (!result.ok) throw new Error(`Not accepted (${result.code}): ${result.reason}`);
  return { id: result.toolCallId!, status };
}

function textOf(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => (item as { text: string }).text)
    .join("\n");
}
