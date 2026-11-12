import {
  DetailView,
  Explorer,
  openModal,
  snapshotExplorer,
  type ExplorerView,
  type Line,
  type ModalContext,
  type ModalFactory,
} from "../../../packages/pi-ui/src/index.ts";
import type { InsightLegend, InsightView } from "./types.js";

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

/** Capture object input immediately; commands may defer snapshot reads until TUI mounting. */
function prepareView(view: InsightView): ModalFactory<void> {
  if (view.text !== undefined) {
    const title = insightTitle(view.title);
    const content = [
      ...(view.note ? [{ text: `${view.note}\n`, tone: "muted" as const }] : []),
      { text: view.text },
    ];
    return (tui, theme, keys, done) =>
      new DetailView({ title, content, tui, theme, keys, done: () => done(undefined) });
  }
  const snapshot = snapshotExplorer(toExplorerView(view));
  return (tui, theme, keys, done) =>
    new Explorer({ view: snapshot, tui, theme, keys, done: () => done(undefined) });
}

/** The shared modal owns the mode gate, framing, input and sanitization. */
export async function showInsightView(
  ctx: ModalContext,
  view: InsightView | (() => InsightView),
): Promise<void> {
  const factory: ModalFactory<void> =
    typeof view === "function" ? (...args) => prepareView(view())(...args) : prepareView(view);
  await openModal(ctx, factory, { command: "/system" });
}
