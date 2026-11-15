// Slot 6: the thread side-panel tab with the whole session: its header, open
// questions, every explorer view through the generic renderer, recent activity
// and usage.
import {
  experimental_InfoList as InfoList,
  experimental_InfoListRow as InfoListRow,
  experimental_InfoSection as InfoSection,
  useBbNavigate,
  type ExperimentalThreadTabProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import type { SessionSnapshot } from "../contract.ts";
import { ago, compact, duration, NOT_RUNNING, statusText } from "./format.ts";
import { useRunAction, useSession, useSessionResult } from "./session.ts";
import { ExplorerSection, type RunAction } from "./surface.tsx";

function Glyph({ name, label }: { name: string; label?: string }) {
  return (
    <Icon
      name={name}
      className="size-3 text-muted-foreground"
      {...(label ? { "aria-label": label } : { "aria-hidden": true })}
    />
  );
}

function Header({ snapshot, saved }: { snapshot: SessionSnapshot; saved: boolean }) {
  const facts = [
    snapshot.agent,
    snapshot.model?.name ?? snapshot.model?.id,
    snapshot.thinking ? `thinking ${snapshot.thinking}` : undefined,
    snapshot.context?.percent != null
      ? `context ${Math.round(snapshot.context.percent)}%`
      : undefined,
  ].filter(Boolean);
  return (
    <header className="flex flex-col gap-0.5 px-1 pb-2">
      <h2 className="truncate text-sm font-medium text-foreground">
        {snapshot.name ?? snapshot.cwd}
      </h2>
      <p className="truncate text-xs text-muted-foreground">
        {saved ? NOT_RUNNING : statusText(snapshot)}
        {facts.length ? ` · ${facts.join(" · ")}` : ""}
      </p>
    </header>
  );
}

/** Explorer views in this order; any other explorer follows, by id. */
const EXPLORER_ORDER = [
  "todo.explorer",
  "subagent.explorer",
  "stash.explorer",
  "git.worktrees",
  "git.prs",
];

function rank(id: string): number {
  const index = EXPLORER_ORDER.indexOf(id);
  return index < 0 ? EXPLORER_ORDER.length : index;
}

/** Every explorer the session offers, drawn by the generic renderer; empty ones are left out. */
function Explorers({ snapshot, run }: { snapshot: SessionSnapshot; run?: RunAction }) {
  const navigate = useBbNavigate();
  const openUrl = (url: string) => void navigate.openUrl(url);
  const views = (snapshot.views ?? [])
    .flatMap((view) => (view.kind === "explorer" ? [view] : []))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  return (
    <>
      {views.map((view) => {
        if (view.error)
          return (
            <InfoSection key={view.id} label={view.title}>
              <p role="alert" className="px-1 text-xs text-destructive">
                {view.error}
              </p>
            </InfoSection>
          );
        if (!view.model?.items.length) return null;
        return (
          <ExplorerSection
            key={view.id}
            model={view.model}
            openUrl={openUrl}
            {...(run ? { run } : {})}
          />
        );
      })}
    </>
  );
}

function Activity({ snapshot, now }: { snapshot: SessionSnapshot; now: number }) {
  const activity = snapshot.activity ?? [];
  if (!activity.length) return null;
  return (
    <InfoSection label="Recent activity" count={activity.length}>
      <InfoList
        items={activity}
        limit={6}
        getKey={(item) => `${item.at}-${item.tool}`}
        renderItem={(item) => (
          <InfoListRow
            leading={<Glyph name={item.running ? "Loading" : item.error ? "CircleX" : "Check"} />}
            name={item.tool}
            {...(item.summary ? { context: item.summary } : {})}
            trailing={
              <span className="text-xs text-muted-foreground">
                {item.running
                  ? "running"
                  : item.durationMs != null
                    ? duration(item.durationMs)
                    : ago(item.at, now)}
              </span>
            }
          />
        )}
      />
    </InfoSection>
  );
}

function Usage({ snapshot }: { snapshot: SessionSnapshot }) {
  const usage = snapshot.usage;
  if (!usage) return null;
  const rows = [
    ["Input", compact(usage.input)],
    ["Output", compact(usage.output)],
    ["Cache read", compact(usage.cacheRead)],
    ["Cache write", compact(usage.cacheWrite)],
    ["Cost", `$${usage.cost.toFixed(2)}`],
  ];
  return (
    <InfoSection label="Usage">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 px-1 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right tabular-nums text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </InfoSection>
  );
}

function Questions({ snapshot }: { snapshot: SessionSnapshot }) {
  const questions = snapshot.questions ?? [];
  if (!questions.length) return null;
  return (
    <InfoSection
      label="Open questions"
      count={questions.reduce((sum, item) => sum + item.questions.length, 0)}
    >
      <ul className="flex flex-col gap-1 px-1 text-sm">
        {questions.flatMap((questionnaire) =>
          questionnaire.questions.map((question) => (
            <li key={`${questionnaire.id}-${question.header}`} className="flex gap-2">
              <Glyph name="MessageQuestion" />
              <span className="text-foreground">{question.question}</span>
            </li>
          )),
        )}
      </ul>
    </InfoSection>
  );
}

export function SessionView({
  snapshot,
  now,
  saved = false,
  run,
}: {
  snapshot: SessionSnapshot;
  now?: number;
  /** A saved snapshot: no Pi runs for the thread now. */
  saved?: boolean;
  /** Runs an explorer's actions; absent when no Pi runs to answer. */
  run?: RunAction;
}) {
  const at = now ?? Date.now();
  return (
    <div className="flex min-w-0 flex-col gap-3 p-3" data-pi-surface="session-tab">
      <Header snapshot={snapshot} saved={saved} />
      <Questions snapshot={snapshot} />
      <Explorers snapshot={snapshot} {...(run ? { run } : {})} />
      <Activity snapshot={snapshot} now={at} />
      <Usage snapshot={snapshot} />
    </div>
  );
}

export function SessionTab({ threadId }: ExperimentalThreadTabProps) {
  const { snapshot, source } = useSessionResult(threadId);
  const run = useRunAction(threadId, source);
  if (!snapshot)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No Pi session reports to this thread. It appears once a Pi thread with the pi-bb extension
        starts.
      </p>
    );
  return <SessionView snapshot={snapshot} saved={source === "saved"} {...(run ? { run } : {})} />;
}

/** Only threads with a session get the tab. */
export function useSessionTabVisible({ threadId }: ExperimentalThreadTabProps): boolean {
  return !!useSession(threadId);
}
