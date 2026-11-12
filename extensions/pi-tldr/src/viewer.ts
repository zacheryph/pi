import { errorText } from "#foundations/errors";
import { DetailView, openModal, type Block, type ModalContext, type Title } from "#ui";
import type { TldrResult } from "#src/core";

const LOADING: Block[] = [{ text: "Summarizing session…", tone: "muted" }];
const MAX_ERROR = 360;

export function tldrTitle(result?: TldrResult): Title {
  return { label: "TLDR", detail: result?.title || "session" };
}

/** Premise, one bullet per semicolon-separated finding, then status. */
export function summaryContent(result: TldrResult): Block[] {
  return [
    { heading: "Premise" },
    { text: result.premise },
    { heading: "Findings / turns" },
    { bullets: result.findings.split(/\s*;\s*/).filter(Boolean) },
    { heading: "Current status" },
    { text: result.status },
  ];
}

export function errorContent(error: unknown): Block[] {
  const message = errorText(error);
  return [{ text: `Couldn't summarize: ${message.slice(0, MAX_ERROR)}`, tone: "error" }];
}

/**
 * Open the modal before the model request. Loading, results and errors render in
 * place; closing aborts the request through the modal's signal.
 */
export async function showTldr(
  ctx: ModalContext,
  load: (signal: AbortSignal) => Promise<TldrResult>,
): Promise<void> {
  await openModal<void>(
    ctx,
    (tui, theme, keys, done, signal) => {
      const view = new DetailView({
        tui,
        theme,
        keys,
        title: tldrTitle(),
        content: LOADING,
        closeOnEnter: true,
        done: () => done(undefined),
      });
      // Yield to the TUI so the loading modal appears before the request starts.
      void Promise.resolve()
        .then(() => load(signal))
        .then(
          (result) => {
            if (signal.aborted) return;
            view.setTitle(tldrTitle(result));
            view.setContent(summaryContent(result));
          },
          (error: unknown) => {
            if (!signal.aborted) view.setContent(errorContent(error));
          },
        );
      return view;
    },
    { command: "/tldr" },
  );
}
