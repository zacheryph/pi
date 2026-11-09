/**
 * outcome-delivery.ts — Shared rendering for a subagent outcome.
 *
 * A terminated child's outcome reaches the parent model in the completion
 * message, which is a preview. `subagent_get` reads the same outcome back in
 * full, without delivering it again. Each owns its own framing (XML envelope,
 * report header) and its own truncation, but the body they wrap is the same
 * fact, so it is rendered here rather than twice.
 *
 * The updates a child sent mid-run that no announcement delivered ride both:
 * `renderRunUpdates` renders them for the completion message, and
 * `renderOutcomeAddenda` appends them to a report.
 *
 * The updates and the ask-back affordance are appended in one fixed order by
 * `renderOutcomeAddenda`, so the renderings that compose them cannot disagree
 * about what follows the body. The affordance is the one addendum that asks the
 * parent to call back, so it is also the one that has to know whether that call
 * would be accepted.
 *
 * Pure functions only: no SDK types, no record types, no side effects.
 */

import type { SendRefusal } from "#src/lifecycle/subagent";
import type { DisplayStatus } from "#src/lifecycle/subagent-state";
import { type TurnBudget, wrappedUpAtTurnLimit } from "#src/lifecycle/turn-limits";

/**
 * What a terminal status means, independent of how a message renders it.
 *
 * One source of truth for the facts, because the renderings disagreed on them:
 * the nudge reported an abort as "max turns exceeded" while the pull reported
 * nothing at all. Presentation still differs — see the two renderers
 * below — because a standalone label and a mid-sentence parenthetical are
 * different grammar, not different facts.
 */
interface StatusMeaning {
  /** Sentence-initial label, e.g. "Wrapped up". */
  label: string;
  /** Why, without terminal punctuation, e.g. "after turn-budget warning". */
  detail: string;
}

const STATUS_MEANINGS: Partial<Record<DisplayStatus, StatusMeaning>> = {
  aborted: { label: "Aborted", detail: "turn limit reached, output may be incomplete" },
  // "user request" rather than "stopped by user": the detail must stand on its
  // own after the label, which both presentations already supply.
  stopped: { label: "Stopped", detail: "user request" },
};

/** A run that finished on its own after the harness warned it about its turn limit. */
const WRAPPED_UP: StatusMeaning = { label: "Wrapped up", detail: "after turn-budget warning" };

/**
 * Only what the status presentations read: the status, the error an error
 * label names, and the budget that qualifies a completed run.
 */
export interface StatusOutcome {
  status: DisplayStatus;
  error?: string;
  turnBudget?: TurnBudget;
}

function statusMeaning(outcome: StatusOutcome): StatusMeaning | undefined {
  return wrappedUpAtTurnLimit(outcome) ? WRAPPED_UP : STATUS_MEANINGS[outcome.status];
}

/**
 * Why a message cannot reach an idle agent, worded as a subordinate clause.
 *
 * `subagent_send` words the same facts as standalone refusals; a clause that
 * continues someone else's sentence is different grammar, not a different fact
 * — the split `STATUS_MEANINGS` makes between `label` and `detail`.
 *
 * `rebuilding` is excluded by type rather than by omission: a refusal that lifts
 * in a moment asks the parent to try again, where these ask it to give up, so it
 * gets its own sentence in the renderers below.
 */
const SEND_REFUSAL_CLAUSES: Record<Exclude<SendRefusal, "rebuilding">, string> = {
  "no-session": "it never started a session and its original task was not saved",
  "session-released": "its session was released and its saved transcript is gone",
  "directory-unavailable": "the directory it ran in no longer exists",
  "agent-type-unavailable": "its agent type is no longer available",
};

/**
 * One line on why this settled agent cannot take a message; empty when it can.
 * A message with a question to report uses `renderQuestionAffordance` instead,
 * which says the same thing about the question.
 */
export function renderSendUnavailable(refusal: SendRefusal | undefined): string {
  if (!refusal || refusal === "rebuilding") return "";
  return `Send: not available, because ${SEND_REFUSAL_CLAUSES[refusal]}. Spawn a new agent with the context it needs.`;
}

/**
 * Standalone label form, e.g. "Wrapped up (after turn-budget warning)".
 *
 * An error reports its message instead: the status alone does not say what
 * went wrong.
 */
export function renderStatusLabel(outcome: StatusOutcome): string {
  if (outcome.status === "error") return `Error: ${outcome.error ?? "unknown"}`;
  const meaning = statusMeaning(outcome);
  return meaning ? `${meaning.label} (${meaning.detail})` : "Done";
}

/**
 * Parenthetical suffix form, e.g. " (wrapped up — after turn-budget warning)", for a
 * message appending to its own sentence. Empty when the status is unremarkable
 * or when the body already carries the explanation, as an error's does.
 */
export function renderStatusNote(outcome: StatusOutcome): string {
  const meaning = statusMeaning(outcome);
  if (!meaning) return "";
  return ` (${meaning.label.toLowerCase()} \u2014 ${meaning.detail})`;
}

/**
 * Only what the body formatter reads. Narrower than any record type so a
 * caller cannot come to depend on fields this module does not use.
 */
export interface OutcomeBody {
  status: DisplayStatus;
  result: string | undefined;
  error: string | undefined;
  /** Whether the agent was stopped before the limiter ever admitted it. */
  stoppedWhileQueued: boolean;
}

/**
 * The trailing affordance for a child that ended its turn with a question.
 * Empty when the child asked nothing.
 *
 * Names the exact call that answers it when a message would be accepted, and why
 * it cannot be answered when one would be refused for good — the parent is never
 * told to make a call this extension declines.
 *
 * Takes the id, question, and refusal rather than a record: the three facts it
 * needs, so a caller holding any shape can call it.
 */
export function renderQuestionAffordance(
  agentId: string,
  question: string | undefined,
  refusal: SendRefusal | undefined,
): string {
  if (!question) return "";
  const quoted = question
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  if (refusal === "rebuilding") {
    return (
      "\n\nThis agent asked a question, but it was stopped while its session was being created or rebuilt " +
      `and cannot take your answer yet:\n\n${quoted}\n\n` +
      "Try again in a moment."
    );
  }
  if (refusal) {
    return (
      "\n\nThis agent ended its run with a question that can no longer be answered \u2014 " +
      `${SEND_REFUSAL_CLAUSES[refusal]}:\n\n${quoted}\n\n` +
      "Spawn a new agent with the context it needs; this one cannot take a message."
    );
  }
  return (
    `\n\nThis agent is waiting on an answer:\n\n${quoted}\n\n` +
    `Answer by calling subagent_send with agent_id: "${agentId}" and your answer as the message.`
  );
}

/**
 * What a report appends after the outcome body: the run's updates, then the
 * call to action.
 *
 * The fields rather than a record, so a caller holding any shape can call it
 * — both `Subagent` and `AgentReport` satisfy this structurally.
 */
export interface OutcomeAddenda {
  id: string;
  runUpdates?: readonly string[];
  pendingQuestion?: string;
  /**
   * Why a message would be refused; undefined when one would be accepted.
   *
   * Required rather than optional so a caller that forgets it fails to
   * compile. An omitted optional would silently mean "accepts messages", which
   * is the fail-open this field exists to close.
   */
  sendRefusal: SendRefusal | undefined;
}

/** The addenda tail a report appends, in one order. */
export function renderOutcomeAddenda(outcome: OutcomeAddenda): string {
  return (
    // What the agent flagged along the way, then the call to action.
    renderRunUpdates(outcome.runUpdates) +
    renderQuestionAffordance(outcome.id, outcome.pendingQuestion, outcome.sendRefusal)
  );
}

/**
 * The updates a child sent that no announcement delivered, quoted the way the
 * ask-back affordance quotes the child's question. Empty for a run the child
 * said nothing during — which is every run whose updates the parent received
 * as they happened.
 */
export function renderRunUpdates(updates: readonly string[] | undefined): string {
  if (!updates?.length) return "";
  const quoted = updates
    .map((update) =>
      update
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    )
    .join("\n\n");
  return `\n\nUpdates this agent sent while it worked:\n\n${quoted}`;
}

/**
 * The outcome body a report gives: a running note, an error line, a
 * never-started note, or the trimmed result.
 *
 * The empty-result fallback tests truthiness rather than nullishness. A `??`
 * here passed an empty string through, which is exactly what a run whose
 * provider errored carries — so the parent received a completion header
 * followed by nothing and confabulated the child's work. The two renderers in
 * `notification.ts` always guarded this by truthiness; this is the third
 * agreeing with them (#889).
 */
export function renderOutcomeBody(outcome: OutcomeBody): string {
  if (outcome.status === "running")
    return "Agent is still running. Its completion message arrives when it finishes.";
  if (outcome.status === "error") return `Error: ${outcome.error}`;
  if (outcome.stoppedWhileQueued)
    return "Agent was stopped while queued and never started. No work was performed.";
  const trimmed = outcome.result?.trim();
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- || intentional: converts falsy values to fallback
  return trimmed || "No output.";
}
