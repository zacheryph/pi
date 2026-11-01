import {
  showDetail,
  showExplorer,
  type ExplorerView,
  type Line,
  type ModalContext,
} from "../../../packages/pi-ui/src/index.ts";
import type { InsightLegend, InsightView } from "./types.js";

const UNAVAILABLE = "System insights viewer requires TUI mode.";

export function insightTitle(title: string): string {
  return title.startsWith("System insights") ? title : `System insights · ${title}`;
}

/** One notice row: `[loaded]=fresh observation · [loaded]=unobserved/dirty`. */
export function legendNotice(legend: readonly InsightLegend[]): Line {
  return legend.flatMap((entry, index) => [
    ...(index ? [{ text: " · ", tone: "dim" as const }] : []),
    { text: entry.label, tone: entry.tone },
    { text: `=${entry.meaning}`, tone: "dim" as const },
  ]);
}

/** Map an insight list snapshot onto the shared explorer. */
export function toExplorerView(view: InsightView): ExplorerView {
  return {
    title: insightTitle(view.title),
    noun: view.noun,
    notices: [
      ...(view.note ? [{ text: view.note, tone: "muted" as const }] : []),
      ...(view.legend?.length ? [legendNotice(view.legend)] : []),
    ],
    items: (view.items ?? []).map((item) => ({
      id: item.id,
      label: item.label,
      // Tools show their status on the right; skills show a colored badge instead.
      badge: item.badge ?? (item.status ? { text: item.status } : undefined),
      search: [item.status, item.description].filter(Boolean).join(" "),
      detail: item.detail,
    })),
  };
}

/** Read-only snapshot viewers; the shared library owns framing, input and sanitization. */
export async function showInsightView(ctx: ModalContext, view: InsightView): Promise<void> {
  const options = { unavailableMessage: UNAVAILABLE };
  if (view.text !== undefined) {
    await showDetail(
      ctx,
      {
        title: insightTitle(view.title),
        content: [
          ...(view.note ? [{ text: `${view.note}\n`, tone: "muted" as const }] : []),
          { text: view.text },
        ],
      },
      options,
    );
    return;
  }
  await showExplorer(ctx, toExplorerView(view), options);
}
