// Slot 9: a pending interaction that replaces the composer with pi-ask's whole
// questionnaire as one form: every question, its options and a free-text answer.
import type { JsonValue, PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isFormQuestionnaire } from "pi-surface/form";
import type { FormAnswer, FormQuestionnaire } from "../contract.ts";

interface Draft {
  options: number[];
  text: string;
}

/** Builds the form's answer; questions left blank are left out. The questionnaire's owner checks it. */
export function toAnswer(drafts: readonly Draft[], note: string): FormAnswer {
  const answers = drafts.flatMap((draft, questionIndex) => {
    const text = draft.text.trim();
    if (!draft.options.length && !text) return [];
    return [
      {
        questionIndex,
        ...(draft.options.length ? { optionIndexes: draft.options } : {}),
        ...(text ? { text } : {}),
      },
    ];
  });
  return { answers, ...(note.trim() ? { globalNote: note.trim() } : {}) };
}

export function QuestionnaireForm({
  questionnaire,
  onSubmit,
  onCancel,
}: {
  questionnaire: FormQuestionnaire;
  onSubmit: (answer: FormAnswer) => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    questionnaire.questions.map(() => ({ options: [], text: "" })),
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const answered = drafts.filter((draft) => draft.options.length || draft.text.trim()).length;
  // The owner takes an answer to every question or none (pi-ask's rule).
  const complete = answered === questionnaire.questions.length;

  const choose = (questionIndex: number, optionIndex: number, multi: boolean) =>
    setDrafts((current) =>
      current.map((draft, index) => {
        if (index !== questionIndex) return draft;
        const has = draft.options.includes(optionIndex);
        const options = multi
          ? has
            ? draft.options.filter((value) => value !== optionIndex)
            : [...draft.options, optionIndex].toSorted((a, b) => a - b)
          : has
            ? []
            : [optionIndex];
        return { ...draft, options };
      }),
    );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !complete) return;
    setBusy(true);
    try {
      await onSubmit(toAnswer(drafts, note));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4"
      data-question-form=""
      data-pi-surface="questionnaire"
      aria-label="Pi's questions"
    >
      {questionnaire.questions.map((question, questionIndex) => (
        <fieldset key={questionIndex} className="flex flex-col gap-2">
          <legend className="flex flex-col gap-0.5">
            {question.header || question.multiSelect ? (
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {[question.header, question.multiSelect ? "choose any" : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            ) : null}
            <span className="text-sm text-foreground">{question.question}</span>
          </legend>
          <div
            className="flex flex-col gap-1"
            role="group"
            aria-label={question.header || question.question}
          >
            {question.options.map((option, optionIndex) => {
              const selected = drafts[questionIndex]?.options.includes(optionIndex) ?? false;
              return (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={selected}
                  className={
                    selected
                      ? "flex items-baseline gap-2 rounded-md border border-foreground bg-state-active px-3 py-1.5 text-left"
                      : "flex items-baseline gap-2 rounded-md border border-border px-3 py-1.5 text-left hover:bg-state-hover"
                  }
                  onClick={() => choose(questionIndex, optionIndex, !!question.multiSelect)}
                >
                  <span className="shrink-0 text-sm font-medium text-foreground">
                    {option.label}
                  </span>
                  {option.description ? (
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <Input
            value={drafts[questionIndex]?.text ?? ""}
            onChange={(event) =>
              setDrafts((current) =>
                current.map((draft, index) =>
                  index === questionIndex ? { ...draft, text: event.target.value } : draft,
                ),
              )
            }
            placeholder={question.options.length ? "Or answer in your own words" : "Your answer"}
            aria-label={`Answer to: ${question.question}`}
          />
        </fieldset>
      ))}
      <Input
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="A note for all answers (optional)"
        aria-label="Note for all answers"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {answered}/{questionnaire.questions.length} answered
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void onCancel()}
          >
            Decline
          </Button>
          <Button type="submit" size="sm" disabled={busy || !complete}>
            Send answers
          </Button>
        </div>
      </div>
    </form>
  );
}

/** The form for one questionnaire the server raised: the payload is a form view's questionnaire. */
export function QuestionnaireInteraction(props: PluginPendingInteractionProps) {
  const { payload } = props.interaction;
  if (!isFormQuestionnaire(payload)) return null;
  return (
    <QuestionnaireForm
      questionnaire={payload}
      onSubmit={(answer) => props.submit(answer as unknown as JsonValue)}
      onCancel={() => props.cancel()}
    />
  );
}
