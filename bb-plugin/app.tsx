// pi-surface frontend: one registration per bb UI slot, each fed by the
// thread's SessionSnapshot. Components live in ui/; docs/bb/ui-slots.md shows each.
import {
  definePluginApp,
  experimental_THREAD_CONTEXT_SEGMENT_GROUPS as SEGMENT_GROUPS,
  experimental_THREAD_INFO_ROW_GROUPS as ROW_GROUPS,
  experimental_THREAD_INFO_SECTION_GROUPS as SECTION_GROUPS,
} from "@get-bb/plugin-sdk/app";
import { QUESTIONNAIRE_RENDERER } from "./questions.ts";
import { OpenPanelAction, STASH_POPUP, StashPicker } from "./ui/composer.tsx";
import { QuestionnaireInteraction } from "./ui/questionnaire.tsx";
import { SESSION_TAB } from "./ui/session.ts";
import { SessionTab, useSessionTabVisible } from "./ui/session-tab.tsx";
import { RowBadge, SessionsPage, useSessionsBadge, useSessionsByThread } from "./ui/sessions.tsx";
import { SubagentsBanner, TodosBanner } from "./ui/stack-cards.tsx";
import { GitCardSection, PiSegment, StashCardRow } from "./ui/thread-context.tsx";

export default definePluginApp((app) => {
  // 1. Above the editor: bb's collapsible stack cards.
  // 4. In the composer's control row: open the Pi tab.
  // 5. A composer popup, opened by a composer command or the + menu.
  app.composer.customize({
    id: "pi",
    scopes: ["thread"],
    banners: [
      { id: "todos", chrome: "bare", component: TodosBanner },
      { id: "subagents", chrome: "bare", component: SubagentsBanner },
    ],
    actions: [{ id: "open-session", component: OpenPanelAction }],
    plusMenu: [
      {
        id: "insert-stash",
        label: "Insert a Pi stash handle",
        icon: "Paperclip",
        run: ({ composer }) => {
          composer.experimental_openPopup(STASH_POPUP);
        },
      },
    ],
    experimental_popups: [{ id: STASH_POPUP, label: "Pi stash", component: StashPicker }],
  });
  app.composer.experimental_registerCommand({
    id: "stash-picker",
    title: "Pi: insert a stash handle",
    defaultShortcut: { key: "s", mod: true, shift: true },
    run: ({ composer }) => {
      composer.experimental_openPopup(STASH_POPUP);
    },
  });

  // 2. The context row above the composer.
  app.slots.experimental_threadContextSegment({
    id: "pi",
    title: "Pi session",
    group: SEGMENT_GROUPS.thread,
    order: 50,
    summary: PiSegment,
  });

  // 3. The thread context card: a row and a section.
  app.slots.experimental_threadContextCardRow({
    id: "stash",
    group: ROW_GROUPS.environment,
    order: 50,
    component: StashCardRow,
  });
  app.slots.experimental_threadContextCardSection({
    id: "git",
    title: "Pi worktrees and pull requests",
    group: SECTION_GROUPS.changes,
    order: 50,
    component: GitCardSection,
  });

  // 6. The thread's side panel.
  app.slots.experimental_tab({
    ...SESSION_TAB,
    title: "Pi",
    icon: "Layers",
    tooltip: "Pi session: tasks, subagents, stash, Git, activity",
    component: SessionTab,
    useVisible: useSessionTabVisible,
  });

  // 7. Thread rows in the sidebar.
  app.slots.experimental_threadRowMetadata({
    id: "pi",
    order: 50,
    useData: useSessionsByThread,
    component: RowBadge,
  });

  // 8. The sidebar navigation: a page of every connected session.
  app.slots.navPanel({
    id: "sessions",
    title: "Pi sessions",
    icon: "LayoutList",
    path: "sessions",
    component: SessionsPage,
    experimental_useBadge: useSessionsBadge,
  });

  // 9. pi-ask's questionnaire as one form in place of the composer.
  app.slots.pendingInteraction({ id: QUESTIONNAIRE_RENDERER, component: QuestionnaireInteraction });
});
