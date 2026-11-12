import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { AskAnswer, AskOutcome, AskQuestion } from "#src/questions";
import { TYPE_LABEL } from "#src/questionnaire";

type Dialogs = Pick<ExtensionUIContext, "select" | "input">;

const title = (question: AskQuestion, at: number, total: number) =>
  `${total > 1 ? `(${at + 1}/${total}) ` : ""}${question.header ? `${question.header}: ` : ""}${question.question}`;

/**
 * For hosts that render Pi's own dialogs but not custom terminal UI (RPC): one
 * dialog per question, in order. Dismissing any dialog dismisses them all.
 * Multi-select takes option numbers separated by commas, optionally followed by
 * a semicolon and the user's own words.
 */
export async function askWithDialogs(
  ui: Dialogs,
  questions: readonly AskQuestion[],
  opts: ExtensionUIDialogOptions = {},
): Promise<AskOutcome> {
  const answers: AskAnswer[] = [];
  for (const [at, question] of questions.entries()) {
    const heading = title(question, at, questions.length);
    if (!question.options.length) {
      const text = (await ui.input(heading, "Your answer", opts))?.trim();
      if (!text) return { status: "cancelled" };
      answers.push({ question: question.question, selected: [], text });
      continue;
    }
    if (question.multiSelect) {
      const listed = question.options.map((option, choice) => `${choice + 1}. ${option.label}`);
      const reply = (
        await ui.input(`${heading}\n${listed.join("\n")}`, "e.g. 1,3; own words", opts)
      )?.trim();
      if (!reply) return { status: "cancelled" };
      const [numbers = "", ...rest] = reply.split(";");
      const picked = [
        ...new Set(
          numbers
            .split(",")
            .map((part) => Number(part.trim()))
            .filter(
              (choice) =>
                Number.isInteger(choice) && choice >= 1 && choice <= question.options.length,
            ),
        ),
      ].sort((a, b) => a - b);
      const own = rest.join(";").trim() || (picked.length ? "" : reply);
      answers.push({
        question: question.question,
        selected: picked.map((choice) => question.options[choice - 1]!.label),
        ...(own ? { text: own } : {}),
      });
      continue;
    }
    const choices = question.options.map(
      (option) => `${option.label}${option.description ? ` — ${option.description}` : ""}`,
    );
    const picked = await ui.select(heading, [...choices, TYPE_LABEL], opts);
    if (picked === undefined) return { status: "cancelled" };
    if (picked === TYPE_LABEL) {
      const text = (await ui.input(heading, "Your answer", opts))?.trim();
      if (!text) return { status: "cancelled" };
      answers.push({ question: question.question, selected: [], text });
      continue;
    }
    const choice = choices.indexOf(picked);
    if (choice < 0) return { status: "cancelled" };
    answers.push({ question: question.question, selected: [question.options[choice]!.label] });
  }
  return { status: "answered", answers };
}
