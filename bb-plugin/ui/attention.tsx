// Step 4 of docs/roadmaps/2026-11-26-attention.md: what needs the user, from the `attention`
// RPC. The Attention page lists every session's rows; the thread context card
// lists the thread's owed rows; the navigation badge counts them all.
import {
  experimental_ThreadContextCardRow as ThreadContextCardRow,
  experimental_useRpcQuery,
  useBbNavigate,
  useRpc,
  type ExperimentalBadge,
  type ExperimentalThreadContextCardProps,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rpcContract, type AttentionResult, type ThreadAttentionRow } from "../contract.ts";
import { ago } from "./format.ts";
import { LineText, plainText } from "./surface.tsx";

/** The Attention page's path under the plugin's navigation. */
export const ATTENTION_PATH = "attention";

const EMPTY: AttentionResult = { rows: [], blocking: 0, owed: 0, more: 0 };

/** Every session's rows: one live query shared by every slot. */
export function useAttention(): AttentionResult {
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "attention",
    input: null,
  });
  return query.data ?? EMPTY;
}

/** A category's icon; one the plugin does not know gets a generic one. */
const CATEGORY_ICON: Record<string, string> = {
  question: "MessageQuestion",
  waiting: "Info",
  review: "GitPullRequest",
  findings: "ListTodo",
};
export const categoryIcon = (category: string) => CATEGORY_ICON[category] ?? "AlertCircle";

/** `review` → `Reviews 2`, for the page's filters. */
const CATEGORY_NAME: Record<string, [string, string]> = {
  review: ["review", "reviews"],
  findings: ["finding", "findings"],
  question: ["question", "questions"],
  waiting: ["dialog", "dialogs"],
};
function categoryLabel(category: string, count: number): string {
  const [one, many] = CATEGORY_NAME[category] ?? [category, category];
  return count === 1 ? one : many;
}
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Navigation badge: everything that needs the user; critical while anything blocks. */
export function useAttentionBadge(): ExperimentalBadge | null {
  const { blocking, owed } = useAttention();
  const total = blocking + owed;
  if (!total) return null;
  const parts = [
    ...(blocking ? [`${blocking} blocking`] : []),
    ...(owed ? [`${owed} waiting on you`] : []),
  ];
  return {
    count: total,
    tone: blocking ? "critical" : "warning",
    label: `Pi: ${parts.join(", ")}`,
  };
}

/** `1 review`, `2 reviews`, or `3 need you` when the owed rows are of mixed kinds. */
export function owedText(rows: readonly ThreadAttentionRow[]): string | undefined {
  const owed = rows.filter((row) => row.kind === "owed");
  if (!owed.length) return undefined;
  const [category, ...others] = new Set(owed.map((row) => row.category));
  return !others.length && CATEGORY_NAME[category!]
    ? `${owed.length} ${categoryLabel(category!, owed.length)}`
    : `${owed.length} need you`;
}

/** The thread's rows, as the card and the segment read them. */
export function useThreadAttention(threadId: string): ThreadAttentionRow[] {
  const { rows } = useAttention();
  return useMemo(() => rows.filter((row) => row.threadId === threadId), [rows, threadId]);
}

/** Thread context card section: the thread's owed rows, each opening its link. */
export function AttentionCardSection({ threadId }: ExperimentalThreadContextCardProps) {
  const rows = useThreadAttention(threadId).filter((row) => row.kind === "owed");
  const navigate = useBbNavigate();
  if (!rows.length) return null;
  return (
    <>
      {rows.map((row) => {
        const stale = row.state === "stale";
        const tooltip = [plainText(row.title), row.reason].filter(Boolean).join(" · ");
        const link = row.link;
        return (
          <ThreadContextCardRow
            key={row.key}
            icon={categoryIcon(row.category)}
            label={
              <span className={stale ? "text-muted-foreground" : undefined}>
                <LineText line={row.title} />
              </span>
            }
            title={tooltip}
            trailing={
              <span
                className={stale ? "text-muted-foreground" : "text-warning"}
                data-pi-surface="attention-state"
              >
                {stale ? "stale" : "ready"}
              </span>
            }
            onClick={() =>
              link ? void navigate.openUrl(link.url) : navigate.toPluginPanel(ATTENTION_PATH)
            }
          />
        );
      })}
    </>
  );
}

export interface AttentionActions {
  /** Opens the row's thread, where a blocking row is answered. */
  onThread(row: ThreadAttentionRow): void;
  onOpenUrl(url: string): void;
  /** Resolves `true` when the dismissal waits for the thread's Pi to come back. */
  onDismiss(row: ThreadAttentionRow): Promise<boolean>;
}

function meta(row: ThreadAttentionRow, now: number): string {
  const parts: string[] = [];
  if (row.since !== undefined)
    parts.push(`${row.kind === "blocking" ? "Asked" : "Raised"} ${ago(row.since, now)}`);
  if (row.source === "saved") parts.push("Pi stopped, no updates since");
  else if (!row.connected) parts.push("reconnecting");
  else if (row.source === "fixture") parts.push("fixture");
  return parts.join(" · ");
}

function AttentionItem({
  row,
  now,
  actions,
}: {
  row: ThreadAttentionRow;
  now: number;
  actions: AttentionActions;
}) {
  const [note, setNote] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const blocking = row.kind === "blocking";
  // A saved row lost its action with Pi; dismissing it queues for when Pi is back.
  const dismissible = !blocking && (!!row.dismiss || row.source === "saved");
  const dismiss = useCallback(async () => {
    setBusy(true);
    setNote(undefined);
    try {
      if (await actions.onDismiss(row)) setNote("Dismissed; Pi records it when it runs again.");
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [actions, row]);
  return (
    <li
      className="flex min-w-0 items-start gap-3 px-4 py-3"
      data-pi-surface="attention-row"
      data-kind={row.kind}
      data-state={row.state}
    >
      <Icon
        name={categoryIcon(row.category)}
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span
            className={`min-w-0 truncate text-sm font-medium ${row.state === "stale" ? "text-muted-foreground" : "text-foreground"}`}
          >
            <LineText line={row.title} />
          </span>
          {row.session ? (
            <span className="truncate text-xs text-muted-foreground">{row.session}</span>
          ) : null}
          {row.source === "saved" ? (
            <span className="shrink-0 rounded bg-muted px-1.5 text-xs text-warning">
              last known
            </span>
          ) : null}
        </div>
        {row.reason ? (
          <span className="truncate text-xs text-muted-foreground">{row.reason}</span>
        ) : null}
        <span className="truncate text-xs text-muted-foreground">{meta(row, now)}</span>
        {note ? (
          <span role="status" className="text-xs text-muted-foreground">
            {note}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        {blocking ? (
          <Button size="sm" onClick={() => actions.onThread(row)}>
            Answer
          </Button>
        ) : null}
        {row.link ? (
          <Button size="sm" onClick={() => actions.onOpenUrl(row.link!.url)}>
            Open {row.link.label}
          </Button>
        ) : null}
        {!blocking ? (
          <Button size="sm" variant="outline" onClick={() => actions.onThread(row)}>
            Thread
          </Button>
        ) : null}
        {dismissible ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void dismiss()}>
            Dismiss
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function Group({
  title,
  note,
  tone,
  rows,
  now,
  actions,
}: {
  title: string;
  note: string;
  tone: "critical" | "warning";
  rows: readonly ThreadAttentionRow[];
  now: number;
  actions: AttentionActions;
}) {
  if (!rows.length) return null;
  return (
    <section className="space-y-2" aria-label={title}>
      <h2 className="flex items-baseline gap-2 text-sm">
        <span
          className={`inline-block size-2 rounded-full ${tone === "critical" ? "bg-destructive" : "bg-warning"}`}
          aria-hidden
        />
        <span className="font-semibold text-foreground">{title}</span>
        <span className="text-muted-foreground">{note}</span>
      </h2>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {rows.map((row) => (
          <AttentionItem key={`${row.threadId}/${row.key}`} row={row} now={now} actions={actions} />
        ))}
      </ul>
    </section>
  );
}

/** Which rows a filter keeps: all, the blocking ones, or one owed category. */
type Filter = "all" | "blocking" | `category:${string}`;

export function AttentionList({
  result,
  actions,
  now,
}: {
  result: AttentionResult;
  actions: AttentionActions;
  now?: number;
}) {
  const at = now ?? Date.now();
  const [filter, setFilter] = useState<Filter>("all");
  const [showStale, setShowStale] = useState(false);
  const { rows, more } = result;
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows)
      if (row.kind === "owed") counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
    return [...counts];
  }, [rows]);
  if (!rows.length)
    return (
      <div
        role="status"
        className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
      >
        Nothing needs you. Questions Pi asks and work it hands you show here.
      </div>
    );
  const shown = rows.filter((row) =>
    filter === "all"
      ? true
      : filter === "blocking"
        ? row.kind === "blocking"
        : row.kind === "owed" && `category:${row.category}` === filter,
  );
  const blocking = shown.filter((row) => row.kind === "blocking");
  const ready = shown.filter((row) => row.kind === "owed" && row.state === "ready");
  const stale = shown.filter((row) => row.kind === "owed" && row.state === "stale");
  const blockingCount = rows.filter((row) => row.kind === "blocking").length;
  const chips: Array<[Filter, string, number]> = [
    ["all", "All", rows.length],
    ...(blockingCount ? [["blocking", "Blocking", blockingCount] as [Filter, string, number]] : []),
    ...categories.map(([category, count]): [Filter, string, number] => [
      `category:${category}`,
      capital(categoryLabel(category, count)),
      count,
    ]),
  ];
  return (
    <div className="space-y-5" data-pi-surface="attention">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter">
        {chips.map(([value, label, count]) => (
          <Button
            key={value}
            size="sm"
            variant="outline"
            aria-pressed={filter === value}
            className="rounded-full"
            onClick={() => setFilter(value)}
          >
            {label} <span className="tabular-nums">{count}</span>
          </Button>
        ))}
      </div>
      <Group
        title="Blocking"
        note="The agent stopped until you answer"
        tone="critical"
        rows={blocking}
        now={at}
        actions={actions}
      />
      <Group
        title="Waiting on you"
        note="The agent moved on; this is yours"
        tone="warning"
        rows={ready}
        now={at}
        actions={actions}
      />
      {stale.length ? (
        <section className="space-y-2" aria-label="Stale">
          <button
            type="button"
            className="flex items-baseline gap-2 text-sm"
            aria-expanded={showStale}
            onClick={() => setShowStale((open) => !open)}
          >
            <Icon
              name={showStale ? "ChevronDown" : "ChevronRight"}
              className="size-3.5 self-center text-muted-foreground"
              aria-hidden
            />
            <span className="font-semibold text-foreground">Stale · {stale.length}</span>
            <span className="text-muted-foreground">Changed since it was handed to you</span>
          </button>
          {showStale ? (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {stale.map((row) => (
                <AttentionItem
                  key={`${row.threadId}/${row.key}`}
                  row={row}
                  now={at}
                  actions={actions}
                />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      {more ? <p className="text-xs text-muted-foreground">{more} more not listed here.</p> : null}
    </div>
  );
}

export function AttentionPage(_props: PluginNavPanelProps) {
  const result = useAttention();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const actions = useMemo<AttentionActions>(
    () => ({
      onThread: (row) => navigate.toThread(row.threadId),
      onOpenUrl: (url) => void navigate.openUrl(url),
      onDismiss: async (row) => {
        const { queued } = await rpc.call("dismiss", {
          threadId: row.threadId,
          viewId: row.viewId,
          itemId: row.itemId,
          ...(row.rev ? { rev: row.rev } : {}),
        });
        return queued;
      },
    }),
    [navigate, rpc],
  );
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-4 p-4 md:p-5">
        <p className="text-sm text-muted-foreground">
          What your Pi sessions are waiting on you for: questions that stop the agent, and work it
          handed you.
        </p>
        <AttentionList result={result} actions={actions} />
      </div>
    </div>
  );
}
