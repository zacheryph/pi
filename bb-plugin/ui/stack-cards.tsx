// Slot 1: composer banners (chrome "bare") drawn as bb's collapsible stack cards.
//
// bb draws the card's header (12px inset, 14px icon, 6px gap) and the collapse
// row, but leaves the body's padding to us. The body matches the header: the
// same 12px inset on the left, right and top, and the same icon size and gap,
// so row icons and text line up under the header's icon and title.
import { experimental_CollapsibleStackCard as CollapsibleStackCard } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import type { SessionSnapshot } from "../contract.ts";
import { agentIcon, duration, isRunning, taskIcon, taskLabel, todoCounts } from "./format.ts";
import { useComposerThread, useSession } from "./session.ts";

/** The card body's padding: the header's 12px inset on three sides. */
export const STACK_CARD_BODY_CLASS = "px-3 pt-3 pb-1";
/** One body row: the header's icon-to-title gap, no padding of its own. */
const ROW_CLASS = "flex min-w-0 gap-1.5";

export function TodosCard({ snapshot }: { snapshot: SessionSnapshot }) {
  const counts = todoCounts(snapshot.todos);
  if (!counts || !snapshot.todos) return null;
  const title = counts.active
    ? `Todos ${counts.done}/${counts.total} · ${counts.active.subject}`
    : `Todos ${counts.done}/${counts.total}`;
  return (
    <CollapsibleStackCard label="Todos" title={title} icon="ListTodo" isActive={!!counts.active}>
      <ul className={`flex flex-col gap-1 text-sm ${STACK_CARD_BODY_CLASS}`} aria-label="Tasks">
        {snapshot.todos.tasks.map((task) => (
          <li key={task.key} className={`${ROW_CLASS} items-center`}>
            <Icon
              name={taskIcon(task.status, task.blocked)}
              aria-label={taskLabel(task.status, task.blocked)}
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span
              className={
                task.status === "completed"
                  ? "min-w-0 flex-1 truncate text-muted-foreground line-through"
                  : task.status === "in_progress"
                    ? "min-w-0 flex-1 truncate font-medium text-foreground"
                    : "min-w-0 flex-1 truncate text-foreground"
              }
              title={task.message?.text ?? task.subject}
            >
              {task.subject}
            </span>
            {task.blocked ? (
              <span className="shrink-0 text-xs text-muted-foreground">blocked</span>
            ) : null}
          </li>
        ))}
        {snapshot.todos.total > snapshot.todos.tasks.length ? (
          <li className="text-xs text-muted-foreground">
            {snapshot.todos.total - snapshot.todos.tasks.length} more in the Pi tab
          </li>
        ) : null}
      </ul>
    </CollapsibleStackCard>
  );
}

export function SubagentsCard({ snapshot, now }: { snapshot: SessionSnapshot; now?: number }) {
  const agents = snapshot.subagents?.agents ?? [];
  if (!agents.length) return null;
  const running = agents.filter((agent) => isRunning(agent.state)).length;
  const title = running
    ? `Subagents · ${running} running`
    : `Subagents · ${agents.length} finished`;
  const at = now ?? Date.now();
  return (
    <CollapsibleStackCard label="Subagents" title={title} icon="Bot" isActive={running > 0}>
      <ul
        className={`flex flex-col gap-1.5 text-sm ${STACK_CARD_BODY_CLASS}`}
        aria-label="Subagents"
      >
        {agents.map((agent) => (
          <li key={agent.id} className={`${ROW_CLASS} items-start`}>
            <Icon
              name={agentIcon(agent.state)}
              aria-label={agent.state}
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 rounded bg-muted px-1.5 font-mono text-xs text-muted-foreground">
                  {agent.type}
                </span>
                <span className="min-w-0 truncate text-foreground">{agent.description}</span>
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {agent.state}
                {" · "}
                {duration(agent.durationMs ?? at - agent.since)}
                {agent.toolUses ? ` · ${agent.toolUses} tools` : ""}
                {agent.note ? ` · ${agent.note}` : ""}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </CollapsibleStackCard>
  );
}

export function TodosBanner() {
  const snapshot = useSession(useComposerThread());
  return snapshot ? <TodosCard snapshot={snapshot} /> : null;
}

export function SubagentsBanner() {
  const snapshot = useSession(useComposerThread());
  return snapshot ? <SubagentsCard snapshot={snapshot} /> : null;
}
