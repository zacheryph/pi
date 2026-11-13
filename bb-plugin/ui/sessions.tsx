// Slots 7 and 8: thread row badges, and the Pi sessions page in the sidebar navigation.
import {
  useBbNavigate,
  type ExperimentalBadge,
  type ExperimentalThreadRowMetadataProps,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { useMemo } from "react";
import { Icon } from "@/components/ui/icon";
import type { SessionSummary } from "../contract.ts";
import { ago } from "./format.ts";
import { Gallery } from "./gallery.tsx";
import { useSessions } from "./session.ts";

export type SessionsByThread = ReadonlyMap<string, SessionSummary>;

/** Row metadata `useData`: one read for every row. */
export function useSessionsByThread(): SessionsByThread {
  const sessions = useSessions();
  return useMemo(() => new Map(sessions.map((session) => [session.threadId, session])), [sessions]);
}

export function RowBadge({ thread, data }: ExperimentalThreadRowMetadataProps<SessionsByThread>) {
  const session = data.get(thread.id);
  if (!session) return null;
  if (!session.questions && !session.runningAgents) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
      data-pi-surface="row-badge"
    >
      {session.questions ? (
        <span
          className="inline-flex items-center gap-0.5 text-foreground"
          title={`Pi asked ${session.questions === 1 ? "a question" : `${session.questions} questions`}`}
        >
          <Icon name="MessageQuestion" className="size-3" aria-label="Open question" />
        </span>
      ) : null}
      {session.runningAgents ? (
        <span
          className="inline-flex items-center gap-0.5"
          title={`${session.runningAgents} Pi ${session.runningAgents === 1 ? "subagent" : "subagents"} running`}
        >
          <Icon name="Bot" className="size-3" aria-hidden />
          <span className="tabular-nums">{session.runningAgents}</span>
        </span>
      ) : null}
    </span>
  );
}

/** Navigation badge: sessions that wait on the user. */
export function useSessionsBadge(): ExperimentalBadge | null {
  const sessions = useSessions();
  const waiting = sessions.filter(
    (session) => session.questions > 0 || session.status === "waiting",
  ).length;
  if (waiting)
    return {
      count: waiting,
      tone: "warning",
      label: waiting === 1 ? "1 Pi session waits for you" : `${waiting} Pi sessions wait for you`,
    };
  return null;
}

const STATUS: Record<SessionSummary["status"], string> = {
  idle: "Idle",
  working: "Working",
  tool: "Running a tool",
  compacting: "Compacting",
  waiting: "Waiting for you",
};

export function SessionList({
  sessions,
  onOpen,
  now,
}: {
  sessions: readonly SessionSummary[];
  onOpen: (threadId: string) => void;
  now?: number;
}) {
  const at = now ?? Date.now();
  if (!sessions.length)
    return (
      <div
        role="status"
        className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
      >
        No Pi session is connected. Start a Pi thread with the pi-bb extension installed.
      </div>
    );
  return (
    <ul
      className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card"
      aria-label="Pi sessions"
      data-pi-surface="sessions"
    >
      {sessions.map((session) => (
        <li key={session.threadId}>
          <button
            type="button"
            className="flex w-full min-w-0 items-start gap-3 px-4 py-3 text-left hover:bg-state-hover"
            onClick={() => onOpen(session.threadId)}
          >
            <Icon
              name={
                session.questions
                  ? "MessageQuestion"
                  : session.status === "idle"
                    ? "Circle"
                    : "Loading"
              }
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-sm font-medium text-foreground">
                  {session.name ?? session.cwd}
                </span>
                {session.agent ? (
                  <span className="shrink-0 rounded bg-muted px-1.5 font-mono text-xs text-muted-foreground">
                    {session.agent}
                  </span>
                ) : null}
                {session.source === "fixture" ? (
                  <span className="shrink-0 text-xs text-muted-foreground">fixture</span>
                ) : null}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {session.connected ? STATUS[session.status] : "Disconnected"}
                {session.todos ? ` · ${session.todos.done}/${session.todos.total} tasks` : ""}
                {session.runningAgents ? ` · ${session.runningAgents} agents running` : ""}
                {session.questions ? " · question waiting" : ""}
                {` · ${ago(session.updatedAt, at)}`}
              </span>
              {session.todos?.active ? (
                <span className="truncate text-xs text-foreground">{session.todos.active}</span>
              ) : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function SessionsPage({ subPath }: PluginNavPanelProps) {
  const sessions = useSessions();
  const navigate = useBbNavigate();
  if (subPath === "gallery") return <Gallery />;
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-4 p-4 md:p-5">
        <p className="text-sm text-muted-foreground">
          Pi threads whose pi-bb extension reports to this plugin. A session stays listed for 15
          seconds after its Pi process stops.
        </p>
        <SessionList sessions={sessions} onOpen={(threadId) => navigate.toThread(threadId)} />
      </div>
    </div>
  );
}
