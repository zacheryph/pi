// Slot 6: the thread side-panel tab with the whole session.
import {
  experimental_InfoList as InfoList,
  experimental_InfoListRow as InfoListRow,
  experimental_InfoSection as InfoSection,
  useBbNavigate,
  type ExperimentalThreadTabProps,
} from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import type { SessionSnapshot, StashPreview, TodoHistory } from "../contract.ts";
import {
  agentIcon,
  ago,
  bytes,
  compact,
  duration,
  prNumber,
  statusText,
  taskIcon,
  taskLabel,
  todoCounts,
} from "./format.ts";
import { useSession, useSessionRequest, type Loaded } from "./session.ts";

function Glyph({ name, label }: { name: string; label?: string }) {
  return (
    <Icon
      name={name}
      className="size-3 text-muted-foreground"
      {...(label ? { "aria-label": label } : { "aria-hidden": true })}
    />
  );
}

function Detail({
  loaded,
  render,
}: {
  loaded: Loaded<unknown> | undefined;
  render: () => ReactNode;
}) {
  if (!loaded || loaded.state === "idle") return null;
  if (loaded.state === "loading")
    return <p className="py-1 pl-5 text-xs text-muted-foreground">Loading…</p>;
  if (loaded.state === "error")
    return (
      <p role="alert" className="py-1 pl-5 text-xs text-destructive">
        {loaded.message}
      </p>
    );
  return <>{render()}</>;
}

function Header({ snapshot }: { snapshot: SessionSnapshot }) {
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
        {statusText(snapshot)}
        {facts.length ? ` · ${facts.join(" · ")}` : ""}
      </p>
    </header>
  );
}

function Todos({
  snapshot,
  threadId,
  now,
}: {
  snapshot: SessionSnapshot;
  threadId: string;
  now: number;
}) {
  const todos = snapshot.todos;
  const counts = todoCounts(todos);
  const history = useSessionRequest<TodoHistory>(threadId);
  if (!todos || !counts) return null;
  return (
    <InfoSection label={`Todos ${counts.done}/${counts.total}`} count={todos.total}>
      <InfoList
        items={todos.tasks}
        limit={12}
        getKey={(task) => task.key}
        renderItem={(task) => {
          const loaded = history.loaded[task.key];
          return (
            <div>
              <InfoListRow
                leading={<Glyph name={taskIcon(task.status, task.blocked)} />}
                leadingLabel={taskLabel(task.status, task.blocked)}
                name={task.subject}
                title={task.description ?? task.subject}
                {...(task.message ? { context: task.message.text } : {})}
                onSelect={() =>
                  loaded
                    ? history.forget(task.key)
                    : history.load(task.key, { command: "todo-history", key: task.key })
                }
              />
              <Detail
                loaded={loaded}
                render={() => {
                  const value = (loaded as { value: TodoHistory }).value;
                  return (
                    <ol
                      className="flex flex-col gap-0.5 py-1 pl-5 text-xs text-muted-foreground"
                      aria-label="History"
                    >
                      {value.updates.length === 0 ? <li>No updates yet.</li> : null}
                      {value.updates.map((update) => (
                        <li key={`${update.revision}-${update.at}`} className="truncate">
                          {ago(update.at, now)} · {update.from ? `${update.from} → ` : ""}
                          {update.status}
                          {update.message ? ` · ${update.message}` : ""}
                        </li>
                      ))}
                    </ol>
                  );
                }}
              />
            </div>
          );
        }}
      />
    </InfoSection>
  );
}

function Subagents({ snapshot, now }: { snapshot: SessionSnapshot; now: number }) {
  const agents = snapshot.subagents?.agents ?? [];
  if (!agents.length) return null;
  return (
    <InfoSection label="Subagents" count={agents.length}>
      <InfoList
        items={agents}
        getKey={(agent) => agent.id}
        renderItem={(agent) => (
          <InfoListRow
            leading={<Glyph name={agentIcon(agent.state)} />}
            leadingLabel={agent.state}
            name={`${agent.type}: ${agent.description}`}
            {...(agent.note ? { context: agent.note } : {})}
            trailing={
              <span className="text-xs text-muted-foreground">
                {duration(agent.durationMs ?? now - agent.since)}
                {agent.tokens ? ` · ${compact(agent.tokens)}` : ""}
              </span>
            }
          />
        )}
      />
    </InfoSection>
  );
}

function Stash({
  snapshot,
  threadId,
  now,
}: {
  snapshot: SessionSnapshot;
  threadId: string;
  now: number;
}) {
  const stash = snapshot.stash;
  const previews = useSessionRequest<StashPreview>(threadId);
  if (!stash?.total) return null;
  return (
    <InfoSection label="Stash" count={stash.total}>
      <InfoList
        items={stash.entries}
        getKey={(entry) => entry.handle}
        renderItem={(entry) => {
          const loaded = previews.loaded[entry.name];
          return (
            <div>
              <InfoListRow
                leading={<Glyph name="Paperclip" />}
                name={entry.name}
                title={entry.handle}
                {...(entry.description ? { context: entry.description } : {})}
                trailing={
                  <span className="text-xs text-muted-foreground">
                    {bytes(entry.bytes)} · {ago(entry.createdAt, now)}
                  </span>
                }
                onSelect={() =>
                  loaded
                    ? previews.forget(entry.name)
                    : previews.load(entry.name, { command: "stash-preview", name: entry.name })
                }
              />
              <Detail
                loaded={loaded}
                render={() => {
                  const value = (loaded as { value: StashPreview }).value;
                  return (
                    <pre className="my-1 ml-5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-xs text-foreground">
                      {value.lines.join("\n")}
                      {value.complete ? "" : `\n… ${value.total - value.lines.length} more lines`}
                    </pre>
                  );
                }}
              />
            </div>
          );
        }}
      />
    </InfoSection>
  );
}

function Git({ snapshot }: { snapshot: SessionSnapshot }) {
  const navigate = useBbNavigate();
  const git = snapshot.git;
  if (!git || git.worktrees.length + git.prs.length === 0) return null;
  return (
    <InfoSection label="Git" count={git.worktreeTotal + git.prTotal}>
      <InfoList
        items={[
          ...git.worktrees.map((worktree) => ({
            kind: "worktree" as const,
            key: worktree.path,
            worktree,
          })),
          ...git.prs.map((pr) => ({ kind: "pr" as const, key: pr.url, pr })),
        ]}
        limit={8}
        getKey={(item) => item.key}
        renderItem={(item) =>
          item.kind === "worktree" ? (
            <InfoListRow
              leading={<Glyph name="FolderGit" />}
              name={item.worktree.branch}
              context={item.worktree.repo}
              title={item.worktree.path}
              trailing={
                <span className="text-xs text-muted-foreground">
                  {item.worktree.mergedInto
                    ? `merged into ${item.worktree.mergedInto}`
                    : [
                        item.worktree.dirty ? "dirty" : "",
                        item.worktree.unpushed ? `${item.worktree.unpushed} unpushed` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ") || "clean"}
                </span>
              }
            />
          ) : (
            <InfoListRow
              leading={<Glyph name={item.pr.state === "merged" ? "GitMerge" : "GitPullRequest"} />}
              name={`${prNumber(item.pr.label)} ${item.pr.title ?? ""}`.trim()}
              context={item.pr.label.slice(0, item.pr.label.lastIndexOf("#"))}
              title={item.pr.url}
              trailing={
                <span className="text-xs text-muted-foreground">
                  {item.pr.draft ? "draft" : (item.pr.state ?? "")}
                  {item.pr.checks
                    ? ` · ✓${item.pr.checks.passed} ✗${item.pr.checks.failed} ●${item.pr.checks.pending}`
                    : ""}
                </span>
              }
              onSelect={() => void navigate.openUrl(item.pr.url)}
            />
          )
        }
      />
    </InfoSection>
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
  threadId,
  now,
}: {
  snapshot: SessionSnapshot;
  threadId: string;
  now?: number;
}) {
  const at = now ?? Date.now();
  return (
    <div className="flex min-w-0 flex-col gap-3 p-3" data-pi-surface="session-tab">
      <Header snapshot={snapshot} />
      <Questions snapshot={snapshot} />
      <Todos snapshot={snapshot} threadId={threadId} now={at} />
      <Subagents snapshot={snapshot} now={at} />
      <Stash snapshot={snapshot} threadId={threadId} now={at} />
      <Git snapshot={snapshot} />
      <Activity snapshot={snapshot} now={at} />
      <Usage snapshot={snapshot} />
    </div>
  );
}

export function SessionTab({ threadId }: ExperimentalThreadTabProps) {
  const snapshot = useSession(threadId);
  if (!snapshot)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No Pi session reports to this thread. It appears once a Pi thread with the pi-bb extension
        starts.
      </p>
    );
  return <SessionView snapshot={snapshot} threadId={threadId} />;
}

/** Only threads with a session get the tab. */
export function useSessionTabVisible({ threadId }: ExperimentalThreadTabProps): boolean {
  return !!useSession(threadId);
}
