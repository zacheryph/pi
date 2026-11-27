/**
 * How a `job:completion` message reads in Pi's terminal: per job, its outcome and title, the
 * facts the model's notification gives, and the end of its output, laid out like a subagent's
 * completion. Collapsed it shows the last output line; expanded, the whole tail the message
 * carries, the command and the log.
 */
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ICONS } from "#ui/icons";
import { sanitizeLine } from "#ui/text";
import { formatFacts, jobTitle } from "#src/format";
import type { JobSnapshot } from "#src/jobs";
import type { Tail } from "#src/tail";

/** One completion in a message's details. `output` is absent in sessions from before it. */
export interface CompletionDetail {
  completionId: string;
  job: JobSnapshot;
  output?: Tail;
}

export interface CompletionDetails {
  completions: CompletionDetail[];
}

type Theme = Parameters<MessageRenderer>[2];
type Color = "success" | "error" | "dim" | "muted";

/** One completion, unstyled: its headline and the lines under it, each with its colour. */
export interface CompletionView {
  good: boolean;
  title: string;
  status: string;
  lines: { text: string; color: Color }[];
}

/** Build what one completion shows, collapsed or expanded. */
export function completionView(detail: CompletionDetail, expanded: boolean): CompletionView {
  const { job, output } = detail;
  const lines: CompletionView["lines"] = [];
  const kind = job.kind === "watch" ? "watch" : "job";
  lines.push({ text: [`${kind} ${job.id}`, ...formatFacts(job)].join(" · "), color: "dim" });
  if (job.error) lines.push({ text: `error: ${sanitizeLine(job.error)}`, color: "error" });

  const text = output?.text.replace(/\n$/, "") ?? "";
  if (text !== "") {
    const all = text.split("\n").map(sanitizeLine);
    if (expanded) {
      if (output?.truncated) lines.push({ text: "…", color: "dim" });
      for (const line of all) lines.push({ text: line, color: "dim" });
    } else {
      lines.push({ text: `${ICONS.subLine}  ${all.at(-1)}`, color: "dim" });
    }
  } else if (output) {
    lines.push({ text: `${ICONS.subLine}  (no output)`, color: "dim" });
  }

  if (expanded) {
    if (job.label) lines.push({ text: `command: ${sanitizeLine(job.command)}`, color: "muted" });
    lines.push({ text: `log: ${job.logPath}`, color: "muted" });
  }
  return {
    good: job.status === "succeeded" || job.status === "matched",
    title: sanitizeLine(jobTitle(job)),
    status: job.status.replace("_", " "),
    lines,
  };
}

function renderCompletion(detail: CompletionDetail, expanded: boolean, theme: Theme): string {
  const view = completionView(detail, expanded);
  const icon = view.good ? theme.fg("success", ICONS.success) : theme.fg("error", ICONS.failure);
  const headline = `${icon} ${theme.bold(view.title)} ${theme.fg("dim", view.status)}`;
  // Lines under the headline start under its title, as a subagent's completion does.
  return [headline, ...view.lines.map((line) => `  ${theme.fg(line.color, line.text)}`)].join("\n");
}

/**
 * The renderer for `pi.registerMessageRenderer`. A message without completions in its details
 * (not one pi-job wrote) falls back to Pi's own rendering.
 */
export function createCompletionRenderer(): MessageRenderer<CompletionDetails> {
  return (message, { expanded, outputPad }, theme) => {
    const completions = message.details?.completions;
    if (!Array.isArray(completions) || completions.length === 0) return undefined;
    const text = completions
      .map((detail) => renderCompletion(detail, expanded, theme))
      .join("\n\n");
    return new Text(text, outputPad ?? 1, 0);
  };
}
