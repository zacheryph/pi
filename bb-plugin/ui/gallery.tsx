// /plugins/pi-surface/sessions/gallery: the slot components that bb shows only
// behind experiments or a pending interaction, drawn on the plugin's own page
// from a fixture session, for docs/bb/ui-slots.md. Not linked from anywhere.
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import { QuestionnaireForm } from "./questionnaire.tsx";
import { useSession, useSessions } from "./session.ts";
import { RowBadge, useSessionsByThread } from "./sessions.tsx";
import { GitCardSection, StashCardRow } from "./thread-context.tsx";

function Exhibit({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div data-pi-surface={id} className="inline-block min-w-0">
        {children}
      </div>
    </section>
  );
}

export function Gallery() {
  const sessions = useSessions();
  const target = sessions.find((session) => session.source === "fixture") ?? sessions[0];
  const snapshot = useSession(target?.threadId);
  const byThread = useSessionsByThread();
  if (!target || !snapshot)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Show a fixture first: <code>bb pi-surface fixture --thread &lt;id&gt;</code>.
      </p>
    );
  const props = { threadId: target.threadId, projectId: "", environment: null };
  const questionnaire = snapshot.questions?.[0];
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-8 p-4 md:p-5">
        <Exhibit id="gallery-card" title="Thread context card: row and section">
          <div className="w-80 space-y-1 rounded-xl border border-border bg-card p-2">
            <StashCardRow {...props} />
            <div className="border-t border-border pt-2">
              <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                Pi worktrees and pull requests
              </p>
              <GitCardSection {...props} />
            </div>
          </div>
        </Exhibit>
        <Exhibit id="gallery-row" title="Thread row metadata">
          <div className="w-72 rounded-md px-3 py-2 hover:bg-state-hover">
            <div className="truncate text-sm text-foreground">{snapshot.name ?? "Pi thread"}</div>
            <div className="flex items-center gap-2">
              <RowBadge thread={{ id: target.threadId } as PluginSidebarThread} data={byThread} />
            </div>
          </div>
        </Exhibit>
        {questionnaire ? (
          <Exhibit id="gallery-questionnaire" title="Pending interaction: pi-ask questionnaire">
            <div className="w-[36rem] max-w-full">
              <QuestionnaireForm
                questionnaire={questionnaire}
                onSubmit={() => {}}
                onCancel={() => {}}
              />
            </div>
          </Exhibit>
        ) : null}
      </div>
    </div>
  );
}
