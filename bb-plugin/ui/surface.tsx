// pi-surface's view model drawn with bb's components: one renderer for every
// extension's widgets, explorers and details. Extensions say what text means
// (tones, badges, blocks); this file alone decides how that looks in bb.
import {
  experimental_InfoList as InfoList,
  experimental_InfoListRow as InfoListRow,
  experimental_InfoSection as InfoSection,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import type {
  ActionRef,
  Badge,
  Block,
  DetailContent,
  ExplorerItem,
  ExplorerModel,
  JsonObject,
  JsonValue,
  Line,
  Span,
  StateIcon,
  Title,
  Tone,
  WidgetModel,
} from "../contract.ts";
// The same check pi-ui makes on an action's result before drawing it.
import { isDetailContent } from "pi-surface/model";

const TONES: Record<Tone, string> = {
  default: "text-foreground",
  accent: "text-primary",
  muted: "text-muted-foreground",
  dim: "text-muted-foreground/70",
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
};

export function toneClass(tone: Tone | undefined): string {
  return tone ? TONES[tone] : "";
}

function spans(line: Line): readonly Span[] {
  return Array.isArray(line) ? line : [line as Span];
}

/** A line as plain text, for names, tooltips and titles. */
export function plainText(line: Line): string {
  return spans(line)
    .map((span) => (typeof span === "string" ? span : span.text))
    .join("");
}

/** `label / detail`, without the terminal's Nerd Font icon. */
export function titleText(title: Title): string {
  if (typeof title === "string") return title;
  return title.detail ? `${title.label} / ${title.detail}` : title.label;
}

/** bb's icon for each state a span's glyph can stand for. */
export const STATE_ICONS: Record<StateIcon, string> = {
  done: "CircleCheck",
  active: "Loading",
  pending: "Circle",
  blocked: "Lock",
  queued: "Clock",
  waiting: "Pause",
  failed: "CircleX",
  stopped: "X",
};

/** `mm:ss`, as the terminal's subagent clock reads; minutes keep counting past 59. */
export function clockText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** An elapsed clock that keeps running between snapshots, ticking once a second. */
function Clock({ since, className }: { since: number; className: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className={`tabular-nums ${className}`}>{clockText(now - since)}</span>;
}

/**
 * A line's spans: tones become bb's colours, bold is bold, a state glyph
 * becomes bb's icon for the state, and a clock with a start keeps running.
 */
export function LineText({ line }: { line: Line }) {
  return (
    <>
      {spans(line).map((span, index) => {
        if (typeof span === "string") return span;
        if (span.icon)
          return (
            <Icon
              key={index}
              name={STATE_ICONS[span.icon]}
              aria-label={span.icon}
              className={`inline size-3.5 align-[-2px] ${toneClass(span.tone)}`}
            />
          );
        const className = [toneClass(span.tone), span.bold ? "font-semibold" : ""].join(" ").trim();
        if (span.since !== undefined)
          return <Clock key={index} since={span.since} className={className} />;
        return (
          <span key={index} className={className}>
            {span.text}
          </span>
        );
      })}
    </>
  );
}

export function BadgeText({ badge }: { badge: Badge }) {
  return (
    <span className={`text-xs ${toneClass(badge.tone) || "text-muted-foreground"}`}>
      {badge.text}
    </span>
  );
}

/** A field value that is only an http(s) URL, which opens in bb's browser. */
export const URL_ONLY = /^https?:\/\/\S+$/;

/** A field value; a bare http(s) URL opens in bb's browser when `openUrl` is given. */
function Value({ line, openUrl }: { line: Line; openUrl?: (url: string) => void }) {
  const text = plainText(line);
  if (openUrl && URL_ONLY.test(text))
    return (
      <button
        type="button"
        className="min-w-0 truncate text-left text-primary hover:underline"
        onClick={() => openUrl(text)}
      >
        {text}
      </button>
    );
  return <LineText line={line} />;
}

function BlockView({ block, openUrl }: { block: Block; openUrl?: (url: string) => void }) {
  if ("heading" in block)
    return <h4 className="pt-1 font-medium text-muted-foreground first:pt-0">{block.heading}</h4>;
  if ("fields" in block)
    return (
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
        {block.fields.map(([label, value], index) => (
          <div key={`${label}-${index}`} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words text-foreground">
              <Value line={value} {...(openUrl ? { openUrl } : {})} />
            </dd>
          </div>
        ))}
      </dl>
    );
  if ("text" in block)
    return (
      <p
        className={`whitespace-pre-wrap break-words ${toneClass(block.tone) || "text-foreground"}`}
      >
        {block.text}
      </p>
    );
  if ("bullets" in block)
    return (
      <ul className="list-disc pl-4 text-foreground">
        {block.bullets.map((bullet, index) => (
          <li key={index} className="break-words">
            {bullet}
          </li>
        ))}
      </ul>
    );
  const first = typeof block.numbered === "number" ? block.numbered : 1;
  return (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-foreground">
      {block.lines.map((line, index) => (
        <div key={index}>
          {block.numbered !== undefined && block.numbered !== false ? (
            <span className="mr-2 select-none text-muted-foreground">{first + index}</span>
          ) : null}
          {line}
        </div>
      ))}
    </pre>
  );
}

/** Detail content: a string is one text block. */
export function DetailView({
  content,
  openUrl,
}: {
  content: DetailContent;
  openUrl?: (url: string) => void;
}) {
  const blocks: readonly Block[] = typeof content === "string" ? [{ text: content }] : content;
  return (
    <div className="flex min-w-0 flex-col gap-1 py-1 pl-5 text-xs" data-pi-surface="detail">
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} {...(openUrl ? { openUrl } : {})} />
      ))}
    </div>
  );
}

/** A widget's title and its fullest meta, as one header string: `Todos · 3/7`. */
export function widgetTitle(model: WidgetModel): string {
  const meta = model.meta?.[0];
  const text = meta === undefined ? "" : plainText(meta);
  return text ? `${titleText(model.title)} · ${text}` : titleText(model.title);
}

type IconSpan = Exclude<Span, string> & { icon: StateIcon };

/**
 * A right-column line split into its state glyph (the span marked with an
 * icon) and the rest, with the space and separator that joined them dropped:
 * `→ worker · ▸ in_progress` gives `▸` and `→ worker · in_progress`.
 */
export function splitState(line: Line | undefined): { state?: IconSpan; rest: Span[] } {
  if (line === undefined) return { rest: [] };
  const list = spans(line);
  const index = list.findIndex((span) => typeof span === "object" && !!span.icon);
  if (index < 0) return { rest: [...list] };
  const trim = (span: Span | undefined, side: "start" | "end"): Span[] => {
    if (span === undefined) return [];
    const text = typeof span === "string" ? span : span.text;
    const trimmed = side === "start" ? text.trimStart() : text.replace(/\s*·?\s*$/, "");
    if (!trimmed) return [];
    return [typeof span === "string" ? trimmed : { ...span, text: trimmed }];
  };
  const before = list.slice(0, index);
  const after = list.slice(index + 1);
  // `→ worker · ` keeps its ` · ` only while something follows it.
  const head = after.length ? before : [...before.slice(0, -1), ...trim(before.at(-1), "end")];
  return {
    state: list[index] as IconSpan,
    rest: [...head, ...trim(after[0], "start"), ...after.slice(1)],
  };
}

/** bb's icon for a state, in the colour of the glyph it stands for. */
function StateMark({ span }: { span: IconSpan | undefined }) {
  if (!span) return <span className="size-3.5 shrink-0" aria-hidden />;
  return (
    <Icon
      name={STATE_ICONS[span.icon]}
      aria-label={span.icon}
      className={`size-3.5 shrink-0 ${toneClass(span.tone) || "text-muted-foreground"}`}
    />
  );
}

/**
 * A widget's rows, as bb's stack cards draw them, all in one shape: the row's
 * state as bb's icon in the glyph's colour, under the card header's icon; the
 * row's lead (a subagent's clock); the row's text; and at the right the rest
 * of its fullest status (an activity, a status label, an assignee). The state
 * comes from the glyph the terminal draws at the right, so a task and an agent
 * read the same way. The text truncates first.
 */
export function WidgetRows({ model, className = "" }: { model: WidgetModel; className?: string }) {
  if (!model.rows.length)
    return (
      <p className={`text-sm text-muted-foreground ${className}`}>
        <span className="inline-block w-5" aria-hidden />
        {model.emptyText ?? "Nothing to show."}
      </p>
    );
  return (
    <ul className={`flex flex-col gap-1 text-sm ${className}`} aria-label={titleText(model.title)}>
      {model.rows.map((row, index) => {
        const { state, rest } = splitState(row.right?.[0]);
        return (
          <li key={index} className="flex min-w-0 items-center gap-1.5">
            <StateMark span={state} />
            {row.lead === undefined ? null : (
              <span className="shrink-0 tabular-nums" style={{ whiteSpace: "pre" }}>
                <LineText line={row.lead} />
              </span>
            )}
            {/* Spaces are kept, as the terminal keeps them. */}
            <span
              className="min-w-0 flex-1 truncate"
              style={{ whiteSpace: "pre" }}
              title={plainText(row.left)}
            >
              <LineText line={row.left} />
            </span>
            {rest.length === 0 ? null : (
              <span
                className="max-w-[50%] shrink-0 truncate text-xs text-muted-foreground"
                style={{ whiteSpace: "pre" }}
              >
                <LineText line={rest} />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Runs an action on the session; absent while no Pi runs for the thread. */
export type RunAction = (action: string, args: JsonValue) => Promise<unknown>;

type Loaded =
  | { state: "loading" }
  | { state: "done"; content: DetailContent }
  | { state: "error"; message: string };

function call(ref: ActionRef<JsonObject>, context: JsonObject, run: RunAction): Promise<unknown> {
  return run(ref.action, { ...ref.args, ...context });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Tabs({
  tabs,
  current,
  onSelect,
}: {
  tabs: NonNullable<ExplorerModel["tabs"]>;
  current: number;
  onSelect: (index: number) => void;
}) {
  return (
    <span className="inline-flex gap-1" role="tablist">
      {tabs.map((tab, index) => (
        <button
          key={tab.label}
          type="button"
          role="tab"
          aria-selected={index === current}
          className={`rounded px-1.5 text-xs ${
            index === current
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => onSelect(index)}
        >
          {tab.label}
        </button>
      ))}
    </span>
  );
}

/**
 * An explorer as an Info section: tabs, notices, and items that open into
 * their detail. `loadDetail`, `onOpen` and `marker.onClear` run through `run`;
 * without it (no Pi runs for the thread) only inline details open.
 */
export function ExplorerSection({
  model,
  run,
  openUrl,
  limit = 12,
}: {
  model: ExplorerModel;
  run?: RunAction;
  openUrl?: (url: string) => void;
  limit?: number;
}) {
  const tabs = model.tabs ?? [];
  const [tab, setTab] = useState(() =>
    Math.min(Math.max(0, model.initialTab ?? 0), Math.max(0, tabs.length - 1)),
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [loaded, setLoaded] = useState<Readonly<Record<string, Loaded>>>({});
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());

  const current = tabs[Math.min(tab, tabs.length - 1)];
  const byId = new Map(model.items.map((item) => [item.id, item]));
  const items = current ? current.ids.flatMap((id) => byId.get(id) ?? []) : model.items;
  const marked = (item: ExplorerItem) => !!model.marker && !!item.marked && !cleared.has(item.id);
  const markedCount = model.items.filter(marked).length;
  const remote = !!model.loadDetail;

  const setDetail = (id: string, value: Loaded) =>
    setLoaded((previous) => ({ ...previous, [id]: value }));

  const toggle = (item: ExplorerItem) => {
    if (open.has(item.id)) {
      setOpen((previous) => new Set([...previous].filter((id) => id !== item.id)));
      return;
    }
    setOpen((previous) => new Set([...previous, item.id]));
    if (!run) return;
    if (model.onOpen) void call(model.onOpen, { id: item.id }, run).catch(() => {});
    if (marked(item) && model.marker?.onClear) {
      setCleared((previous) => new Set([...previous, item.id]));
      void call(model.marker.onClear, { ids: [item.id] }, run).catch(() => {});
    }
    if (model.loadDetail) {
      const ref = model.loadDetail;
      setDetail(item.id, { state: "loading" });
      call(ref, { id: item.id }, run).then(
        (content) =>
          setDetail(
            item.id,
            isDetailContent(content)
              ? { state: "done", content }
              : { state: "error", message: `Action "${ref.action}" returned no detail.` },
          ),
        (error: unknown) => setDetail(item.id, { state: "error", message: errorMessage(error) }),
      );
    }
  };

  const detail = (item: ExplorerItem): ReactNode => {
    if (!open.has(item.id)) return null;
    if (!remote)
      return item.detail === undefined ? null : (
        <DetailView content={item.detail} {...(openUrl ? { openUrl } : {})} />
      );
    const state = loaded[item.id];
    if (!state || state.state === "loading")
      return <p className="py-1 pl-5 text-xs text-muted-foreground">Loading…</p>;
    if (state.state === "error")
      return (
        <p role="alert" className="py-1 pl-5 text-xs text-destructive">
          {state.message}
        </p>
      );
    return <DetailView content={state.content} {...(openUrl ? { openUrl } : {})} />;
  };

  const empty = current?.emptyText ?? model.emptyText ?? `No ${model.noun?.[1] ?? "items"}.`;
  return (
    <InfoSection
      label={titleText(model.title)}
      count={model.items.length}
      {...(tabs.length > 1
        ? { accessory: <Tabs tabs={tabs} current={tab} onSelect={setTab} /> }
        : {})}
    >
      <div className="flex min-w-0 flex-col gap-1" data-pi-surface="explorer">
        {(model.notices ?? []).map((notice, index) => (
          <p key={index} className="truncate px-1 text-xs text-muted-foreground">
            <LineText line={notice} />
          </p>
        ))}
        {model.marker && markedCount ? (
          <p className="px-1 text-xs text-muted-foreground">
            {markedCount} {model.marker.label}
          </p>
        ) : null}
        {items.length ? (
          <InfoList
            items={items}
            limit={limit}
            getKey={(item) => item.id}
            renderItem={(item) => {
              const isMarked = marked(item);
              const openable = remote ? !!run : item.detail !== undefined;
              return (
                <div>
                  <InfoListRow
                    leading={
                      isMarked ? (
                        <span className="block size-1.5 rounded-full bg-primary" aria-hidden />
                      ) : (
                        <Icon
                          name={open.has(item.id) ? "ChevronDown" : "ChevronRight"}
                          className={`size-3 ${openable ? "text-muted-foreground" : "text-transparent"}`}
                          aria-hidden
                        />
                      )
                    }
                    {...(isMarked ? { leadingLabel: model.marker!.label } : {})}
                    name={<LineText line={item.label} />}
                    title={plainText(item.label)}
                    {...(item.badge ? { trailing: <BadgeText badge={item.badge} /> } : {})}
                    {...(openable ? { onSelect: () => toggle(item) } : {})}
                  />
                  {detail(item)}
                </div>
              );
            }}
          />
        ) : (
          <p className="px-1 text-xs text-muted-foreground">{empty}</p>
        )}
      </div>
    </InfoSection>
  );
}
